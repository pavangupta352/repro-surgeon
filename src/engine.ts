import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseConfig } from './config.ts';
import { assertTemporaryDirectoryOutsideSource, dependencyCandidates, runtimeInfo, validateNpmProject, WorkspaceManager } from './dependencies.ts';
import { buildGraph, detectAdapter } from './graph.ts';
import { evaluateOracle } from './oracle.ts';
import { runCommand } from './runner.ts';
import { applyTransformation, assertDisjointPaths, hashValue, inventoryProject, matchesPath, metrics, scanForReview, snapshotHash } from './snapshot.ts';
import { acquireRunLock, assertCompatibleRuntime, atomicWrite, loadCheckpoint, saveCheckpoint } from './state.ts';
import { jsonCandidates, syntaxCandidates } from './transforms.ts';
import type { Config, Metrics, Observation, OracleResult, RunState, Snapshot, Transformation, Trial } from './types.ts';

export interface ProgressEvent { type: 'baseline' | 'trial' | 'status'; message: string; trial?: Trial }
export interface EngineOptions { signal?: AbortSignal; onEvent?: (event: ProgressEvent) => void }
export interface ReduceOptions extends EngineOptions { sourceRoot: string; runRoot: string; config: Config }
export interface ReductionResult { state: RunState; snapshot: Snapshot }

function smaller(a: Metrics, b: Metrics): boolean {
  for (const key of ['sourceBytes', 'files', 'dependencies', 'bytes'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key];
  }
  return false;
}

function* fileCandidates(snapshot: Snapshot, config: Config): Generator<Transformation> {
  const adapter = detectAdapter(snapshot, config.adapter);
  const protectedPaths = new Set(adapter.protectedPaths);
  const names = [...snapshot.keys()].filter(name => !protectedPaths.has(name) && !matchesPath(name, config.preserve));
  const graph = buildGraph(snapshot);
  names.sort((a, b) => (graph.imports[b]?.length ?? 0) - (graph.imports[a]?.length ?? 0) || a.localeCompare(b, 'en'));
  const seen = new Set<string>();
  function transform(paths: string[], label: string): Transformation | null {
    const sorted = [...paths].sort();
    const id = 'files:' + hashValue(sorted);
    if (!paths.length || seen.has(id)) return null;
    seen.add(id);
    return { id, kind: 'files', description: `Remove ${label} (${paths.length} file${paths.length === 1 ? '' : 's'})`, paths: sorted, edits: sorted.map(name => ({ path: name, content: null })) };
  }
  const everything = transform(names, 'all unpinned source');
  if (everything) yield everything;
  const directories = new Map<string, string[]>();
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      directories.set(prefix, [...(directories.get(prefix) ?? []), name]);
    }
  }
  for (const [directory, files] of [...directories].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'en'))) {
    const value = transform(files, directory);
    if (value) yield value;
  }
  for (let count = 2; names.length > 0;) {
    const size = Math.ceil(names.length / count);
    for (let start = 0; start < names.length; start += size) {
      const chunk = names.slice(start, start + size);
      const value = transform(chunk, chunk.length === 1 ? chunk[0]! : 'source group');
      if (value) yield value;
      const complement = transform(names.filter(name => !chunk.includes(name)), 'group complement');
      if (complement) yield complement;
    }
    if (count >= names.length) break;
    count = Math.min(names.length, count * 2);
  }
}

function invalidObservation(reason: string): Observation {
  return { execution: { exitCode: null, signal: null, timedOut: false, aborted: false, outputLimitExceeded: false, stdout: '', stderr: '', durationMs: 0, error: reason }, oracle: { status: 'invalid', reason, matched: [], missing: [], forbidden: [], diagnostics: [] } };
}

async function continueReduction(runRoot: string, state: RunState, initial: Snapshot, options: EngineOptions, resume: boolean): Promise<ReductionResult> {
  let best = initial;
  const previousElapsed = state.elapsedMs;
  const started = performance.now();
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const manager = new WorkspaceManager(runRoot, state.config, signal);
  const remainingMs = () => state.config.budget.maxSeconds * 1000 - previousElapsed - (performance.now() - started);
  let deadlineTimer: NodeJS.Timeout | undefined;
  const scheduleDeadline = () => {
    const remaining = remainingMs();
    if (remaining <= 0) deadline.abort(new Error('Time budget reached'));
    else deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
  };
  scheduleDeadline();
  const rejected = new Set(state.rejectedHashes);
  let sequence = state.evaluations;
  const emit = (event: ProgressEvent) => options.onEvent?.(event);
  const updateTime = () => { state.elapsedMs = previousElapsed + performance.now() - started; state.updatedAt = new Date().toISOString(); };
  const checkpoint = async () => { updateTime(); state.bestHash = snapshotHash(best); state.current = metrics(best); state.rejectedHashes = [...rejected]; await saveCheckpoint(runRoot, state, best); };
  const interruption = (): string | null => {
    updateTime();
    if (options.signal?.aborted) return 'Interrupted; accepted state saved';
    if (remainingMs() <= 0 && !deadline.signal.aborted) deadline.abort(new Error('Time budget reached'));
    if (deadline.signal.aborted) return 'Time budget reached';
    return null;
  };
  const stop = (): string | null => interruption() ?? (state.evaluations >= state.config.budget.maxEvaluations ? 'Search evaluation budget reached' : null);
  const observe = async (snapshot: Snapshot, stage: string): Promise<Observation> => {
    const stopped = interruption();
    if (stopped) return invalidObservation(stopped);
    try {
      const cwd = await manager.prepare(snapshot);
      const execution = await runCommand(state.config.command, { cwd, timeoutMs: state.config.execution.timeoutMs, maxOutputBytes: state.config.execution.maxOutputBytes, env: await manager.environment(), signal });
      const observation = { execution, oracle: evaluateOracle(execution, state.config.oracle) };
      const logName = `${String(sequence++).padStart(6, '0')}-${stage}.json`;
      await atomicWrite(path.join(runRoot, 'logs', logName), JSON.stringify(observation, null, 2));
      return observation;
    } catch (error) { return invalidObservation(error instanceof Error ? error.message : String(error)); }
  };

  try {
    const alreadyStopped = stop();
    if (alreadyStopped) {
      if (options.signal?.aborted || state.baseline.length < state.config.runs.baseline || !['verifying', 'complete'].includes(state.status)) state.status = 'paused';
      state.stopReason = alreadyStopped;
      await checkpoint();
      return { state, snapshot: best };
    }
    await assertTemporaryDirectoryOutsideSource(state.sourceRoot);
    state.status = 'calibrating';
    state.verification = { status: 'pending', runs: 0, reason: resume ? 'Resume calibration in progress' : 'Initial calibration in progress', snapshotHash: '', environment: 'fresh-directory' };
    await checkpoint();
    if (resume) {
      try { assertCompatibleRuntime(state.runtime, await runtimeInfo(runRoot, signal)); }
      catch (error) {
        const stopped = interruption();
        if (!stopped) throw error;
        state.status = 'paused';
        state.stopReason = stopped;
        await checkpoint();
        return { state, snapshot: best };
      }
    }
    if (state.baseline.length < state.config.runs.baseline || resume) {
      state.status = 'calibrating';
      const establishingBaseline = state.baseline.length < state.config.runs.baseline;
      if (establishingBaseline) state.baseline = [];
      for (let run = 0; run < state.config.runs.baseline; run++) {
        const stopped = stop();
        if (stopped) { state.status = 'paused'; state.stopReason = stopped; await checkpoint(); return { state, snapshot: best }; }
        emit({ type: 'baseline', message: `${resume ? 'Resume check' : 'Baseline'} ${run + 1}/${state.config.runs.baseline}` });
        const observation = await observe(best, resume ? 'resume' : 'baseline');
        const interrupted = interruption();
        if (interrupted) { state.status = 'paused'; state.stopReason = interrupted; await checkpoint(); return { state, snapshot: best }; }
        if (observation.oracle.status !== 'reproduced') {
          state.status = 'failed';
          state.stopReason = `Baseline did not reproduce: ${observation.oracle.reason}`;
          await checkpoint();
          throw new Error(`${state.stopReason}. Inspect private logs and choose a stable, distinctive oracle.`);
        }
        if (establishingBaseline) state.baseline.push(observation.oracle);
        await checkpoint();
      }
    }
    state.status = 'reducing';
    state.verification = { status: 'pending', runs: 0, reason: 'Reduction in progress', snapshotHash: '', environment: 'fresh-directory' };
    await checkpoint();
    while (!stop()) {
      let acceptedInPass = false;
      const passes: Iterable<Transformation>[] = [];
      if (state.config.reduce.files) passes.push(fileCandidates(best, state.config));
      if (state.config.reduce.syntax) passes.push(syntaxCandidates(best, state.config));
      if (state.config.reduce.json) passes.push(jsonCandidates(best, state.config));
      if (state.config.reduce.dependencies) passes.push(dependencyCandidates(best, state.config));
      candidateLoop: for (const pass of passes) {
        for (const transformation of pass) {
          if (stop()) break candidateLoop;
          let candidate = applyTransformation(best, transformation);
          const preliminaryHash = snapshotHash(candidate);
          if (rejected.has(preliminaryHash)) continue;
          let preparationError: string | null = null;
          if (transformation.kind === 'dependencies') {
            try { candidate = await manager.reconcile(candidate, best); }
            catch (error) { preparationError = error instanceof Error ? error.message : String(error); }
          }
          const candidateHash = snapshotHash(candidate);
          if (rejected.has(candidateHash) || (!preparationError && !smaller(metrics(candidate), metrics(best)))) continue;
          const trialStart = performance.now();
          let last: OracleResult = invalidObservation(preparationError ?? 'No observation').oracle;
          let confirmations = 0;
          if (preparationError) state.evaluations++;
          else {
            for (let run = 0; run < state.config.runs.candidate; run++) {
              if (stop()) { last = invalidObservation('Budget or interruption prevented confirmation').oracle; break; }
              state.evaluations++;
              last = (await observe(candidate, 'candidate')).oracle;
              if (last.status !== 'reproduced') break;
              confirmations++;
            }
          }
          const interrupted = interruption();
          if (interrupted) last = invalidObservation(interrupted).oracle;
          const accepted = confirmations === state.config.runs.candidate && !interrupted;
          const trial: Trial = { index: state.trials.length + 1, candidateHash, kind: transformation.kind, description: transformation.description, paths: transformation.paths, status: accepted ? 'reproduced' : last.status, accepted, reason: last.reason, durationMs: performance.now() - trialStart, before: metrics(best), after: metrics(candidate), confirmations, diagnostics: last.diagnostics };
          state.trials.push(trial);
          if (accepted) { best = candidate; acceptedInPass = true; }
          else if (!stop()) { rejected.add(preliminaryHash); rejected.add(candidateHash); }
          await checkpoint();
          emit({ type: 'trial', message: `${accepted ? 'Accepted' : 'Kept original'}: ${trial.description}`, trial });
          if (accepted) break candidateLoop;
        }
      }
      if (!acceptedInPass) break;
    }
    state.stopReason = stop() ?? 'No further reduction found by the enabled passes';
    state.status = options.signal?.aborted ? 'paused' : 'verifying';
    state.reviewFindings = scanForReview(best);
    emit({ type: 'status', message: state.stopReason });
    await checkpoint();
    return { state, snapshot: best };
  } catch (error) {
    if (state.status !== 'failed') { state.status = options.signal?.aborted ? 'paused' : 'failed'; state.stopReason = error instanceof Error ? error.message : String(error); await checkpoint(); }
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    await manager.dispose();
  }
}

export async function reduceProject(options: ReduceOptions): Promise<ReductionResult> {
  const config = parseConfig(options.config);
  const sourceRoot = await realpath(options.sourceRoot);
  await assertTemporaryDirectoryOutsideSource(sourceRoot);
  const runRoot = path.resolve(options.runRoot);
  await assertDisjointPaths(sourceRoot, runRoot);
  try { await stat(runRoot); throw new Error('Run output already exists. Choose a new directory or use resume.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const inventory = await inventoryProject(sourceRoot, config);
  validateNpmProject(inventory.snapshot);
  const runtime = await runtimeInfo(sourceRoot);
  const adapter = detectAdapter(inventory.snapshot, config.adapter);
  const now = new Date().toISOString();
  const hash = snapshotHash(inventory.snapshot);
  const state: RunState = { version: 1, id: randomUUID(), sourceRoot, createdAt: now, updatedAt: now, config, configHash: hashValue(config), runtime, originalHash: hash, bestHash: hash, initial: metrics(inventory.snapshot), current: metrics(inventory.snapshot), adapter, status: 'calibrating', stopReason: '', evaluations: 0, elapsedMs: 0, baseline: [], trials: [], rejectedHashes: [], excluded: inventory.excluded, warnings: [...inventory.warnings, ...adapter.warnings], verification: { status: 'pending', runs: 0, reason: 'Not exported yet', snapshotHash: '', environment: 'fresh-directory' }, reviewFindings: [] };
  await mkdir(runRoot, { mode: 0o700 });
  const release = await acquireRunLock(runRoot);
  try { await saveCheckpoint(runRoot, state, inventory.snapshot); return await continueReduction(runRoot, state, inventory.snapshot, options, false); }
  finally { await release(); }
}

export async function resumeProject(options: EngineOptions & { runRoot: string; maxEvaluations?: number; maxSeconds?: number }): Promise<ReductionResult> {
  const runRoot = await realpath(options.runRoot);
  const release = await acquireRunLock(runRoot);
  try {
    const { state, snapshot } = await loadCheckpoint(runRoot);
    const config = parseConfig(state.config);
    if (hashValue(config) !== state.configHash) throw new Error('Checkpoint configuration hash is corrupt.');
    await assertDisjointPaths(state.sourceRoot, runRoot);
    if (options.maxEvaluations !== undefined) config.budget.maxEvaluations = options.maxEvaluations;
    if (options.maxSeconds !== undefined) config.budget.maxSeconds = options.maxSeconds;
    state.config = parseConfig(config);
    state.configHash = hashValue(state.config);
    return await continueReduction(runRoot, state, snapshot, options, true);
  } finally { await release(); }
}
