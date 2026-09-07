import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyzeMasking, detect, parseCommand, parseOutput } from 'stalegreen';
import { runCommand } from '../../src/runner.ts';
import { captureInputs, compareInputs } from './inputs.mjs';

const require = createRequire(import.meta.url);
export const DEFAULT_CHECKS = ['typecheck', 'test', 'build'];
export const CHECKS = {
  typecheck: { args: ['run', 'typecheck'], category: 'typecheck', script: 'typecheck' },
  test: { args: ['test'], category: 'test', script: 'test' },
  build: { args: ['run', 'build'], category: 'build', script: 'build' },
  package: { args: ['run', 'test:package'], category: 'test', script: 'test:package' },
};
const SCHEMA = 'repro-development-verification-v1';
const MAX_OUTPUT = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = (status, reason, record) => ({ status, reason, checks: [], ...(record ? { record } : {}) });

export function selectChecks(checks = DEFAULT_CHECKS) {
  if (!Array.isArray(checks) || checks.length === 0 || new Set(checks).size !== checks.length
    || checks.some(id => !Object.hasOwn(CHECKS, id))) throw new Error('Select distinct checks: typecheck,test,build,package');
  return [...checks];
}

async function directory(root, parts, create = false) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence directories must be ordinary directories');
  }
  return current;
}

async function boundedRead(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit)) throw new Error('Evidence file is unavailable or exceeds its limit');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error('Evidence file exceeds its limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const final = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if ([final, current].some(value => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(key => value[key] !== stat[key]))
      || BigInt(total) !== stat.size) throw new Error('Evidence file changed while reading');
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function atomicRecord(base, record) {
  for (const destination of [path.join(base, 'runs', record.id, 'result.json'), path.join(base, 'latest.json')]) {
    const temporary = path.join(path.dirname(destination), `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  }
}

async function packageVersion(name) {
  const file = path.resolve(require.resolve(name), '..', '..', 'package.json');
  return JSON.parse(await readFile(file, 'utf8')).version;
}

async function runtime() {
  const npm = await runCommand(['npm', '--version'], { cwd: process.cwd(), env: process.env, timeoutMs: 10000, maxOutputBytes: 4096 });
  if (npm.exitCode !== 0 || npm.signal || npm.error || !/^\d+\.\d+\.\d+\s*$/.test(npm.stdout)) throw new Error('Cannot establish npm version');
  return {
    node: process.version, npm: npm.stdout.trim(), typescript: await packageVersion('typescript'),
    stalegreen: await packageVersion('stalegreen'), platform: process.platform, arch: process.arch,
    nodeOptionsHash: hash(process.env.NODE_OPTIONS ?? ''), reporter: 'tap',
  };
}

function validateResult(result) {
  return result && (result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= 0))
    && (result.signal === null || typeof result.signal === 'string')
    && ['timedOut', 'aborted', 'outputLimitExceeded'].every(key => typeof result[key] === 'boolean')
    && Number.isFinite(result.durationMs) && result.durationMs >= 0
    && (result.error === undefined || typeof result.error === 'string');
}

function classify(id, result, stdout, stderr, script) {
  if (!validateResult(result)) return { status: 'unverified', reason: 'Invalid process result' };
  if (result.signal || result.aborted || result.timedOut || result.outputLimitExceeded || result.error || result.exitCode === null) {
    return { status: 'unverified', reason: 'Process interrupted, unavailable, timed out or output exceeded its limit' };
  }
  if (result.exitCode !== 0) return { status: 'failed', reason: `Process exited ${result.exitCode}` };
  const parsedScript = parseCommand(script);
  if (!parsedScript.confident || parsedScript.grouping || parsedScript.processSubstitution || parsedScript.heredoc
    || !parsedScript.segments.length || parsedScript.segments.some((segment, index) => {
    const masking = analyzeMasking(parsedScript, index);
    return !['start', '&&'].includes(segment.op) || !masking.exitPreserved || !masking.outputVisible || masking.background;
  })) return { status: 'unverified', reason: 'Configured script masks command status or output' };
  const check = CHECKS[id];
  const detection = detect(['npm', ...check.args].join(' '));
  if (!detection || detection.category !== check.category || detection.notRun) return { status: 'unverified', reason: 'Runner not recognized' };
  const parsed = parseOutput(check.category, `${stdout}\n${stderr}`, { exit: result.exitCode, interrupted: false });
  if (parsed.verdict !== 'pass') return { status: parsed.verdict === 'fail' ? 'failed' : 'unverified', reason: parsed.signal ?? 'No conclusive runner summary', parsed };
  if (check.category === 'test') {
    // Node's terminal TAP summary is evidence only alongside the actual exit status.
    // Require the complete summary, including cancellation and empty-suite controls.
    const summary = stdout.match(/(?:^|\n)# tests (\d+)\n# suites (\d+)\n# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n# skipped (\d+)\n# todo (\d+)\n# duration_ms [\d.]+\s*$/);
    const values = summary?.slice(1).map(Number);
    if (!values || values.some(value => !Number.isSafeInteger(value)) || values[2] <= 0 || values[3] !== 0 || values[4] !== 0
      || values[0] !== values[2] + values[3] + values[4] + values[5] + values[6]) {
      return { status: 'unverified', reason: 'Missing, empty or inconsistent terminal TAP summary', parsed };
    }
  }
  return { status: 'passed', parsed };
}

export async function readVerification(root, options = {}) {
  const requested = selectChecks(options.checks);
  let record;
  try {
    root = await realpath(root);
    const base = await directory(root, ['.local', 'dev-verification']);
    record = JSON.parse((await boundedRead(path.join(base, 'latest.json'), 1024 * 1024)).toString('utf8'));
    if (record.schema !== SCHEMA || record.root !== root || !/^[a-f0-9-]{36}$/.test(record.id) || record.state !== 'complete'
      || !Array.isArray(record.checks) || record.checks.length > 4 || !Array.isArray(record.selected)
      || !same(selectChecks(record.selected), record.selected) || !record.before || !record.after || !record.runtimeBefore || !record.runtimeAfter) {
      return failure('unverified', 'Missing, incomplete or incompatible evidence record', record);
    }
    if (record.checks.length !== record.selected.length || !same(record.checks.map(check => check.id), record.selected)) {
      return failure('unverified', 'Incomplete check records', record);
    }
    const currentInputs = await captureInputs(root);
    const currentRuntime = await runtime();
    const comparisons = [compareInputs(record.before, record.after), compareInputs(record.after, currentInputs)];
    if (comparisons.includes('unknown')) return failure('unverified', 'Input fingerprint unavailable', record);
    if (comparisons.includes('different') || !same(record.runtimeBefore, record.runtimeAfter) || !same(record.runtimeAfter, currentRuntime)) {
      return failure('stale', 'Inputs or recorded runtime changed', record);
    }
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const runDirectory = await directory(base, ['runs', record.id]);
    const evaluated = [];
    for (const saved of record.checks) {
      const definition = CHECKS[saved.id];
      if (!definition || !same(saved.command, ['npm', ...definition.args]) || saved.script !== packageJson.scripts?.[definition.script]
        || saved.category !== definition.category || saved.scope !== 'configured-package-script') {
        return failure('unverified', 'Check identity does not match the configured script', record);
      }
      const before = compareInputs(record.before, saved.before);
      const after = compareInputs(saved.before, saved.after);
      if ([before, after].includes('unknown')) return failure('unverified', 'Check fingerprint unavailable', record);
      if ([before, after].includes('different')) return failure('stale', 'Inputs changed during verification', record);
      const logs = {};
      for (const stream of ['stdout', 'stderr']) {
        const file = `${saved.id}.${stream}.log`;
        const bytes = await boundedRead(path.join(runDirectory, file), MAX_OUTPUT);
        if (saved.logs?.[stream]?.file !== file || saved.logs[stream].sha256 !== hash(bytes) || saved.logs[stream].bytes !== bytes.length) {
          return failure('unverified', 'Missing or changed command log', record);
        }
        logs[stream] = bytes.toString('utf8');
      }
      evaluated.push({ id: saved.id, ...classify(saved.id, saved.result, logs.stdout, logs.stderr, saved.script) });
    }
    const finalInputs = await captureInputs(root);
    const finalComparison = compareInputs(currentInputs, finalInputs);
    if (finalComparison === 'unknown') return failure('unverified', 'Final input fingerprint unavailable', record);
    if (finalComparison === 'different') return failure('stale', 'Inputs changed while checking saved evidence', record);
    const checks = requested.map(id => evaluated.find(check => check.id === id) ?? { id, status: 'missing' });
    const status = checks.some(check => check.status === 'missing') ? 'incomplete'
      : checks.some(check => check.status === 'unverified') ? 'unverified'
        : checks.some(check => check.status === 'failed') ? 'failed' : 'fresh';
    return { status, checks, record, currentInputs: finalInputs };
  } catch {
    return failure('unverified', 'Evidence, inputs or runtime could not be verified', record);
  }
}

export async function runVerification(root, options = {}) {
  const selected = selectChecks(options.checks);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT) {
    throw new Error('Invalid process limits');
  }
  root = await realpath(root);
  const base = await directory(root, ['.local', 'dev-verification'], true);
  const lockPath = path.join(base, 'run.lock');
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Verification lock exists; ensure its process has stopped before removing .local/dev-verification/run.lock'); throw error; }
  try {
    await lock.writeFile(token);
    const id = randomUUID();
    const runDirectory = await directory(base, ['runs', id], true);
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    // Reporter flags are repeatable in Node; adding one to an existing choice can
    // require additional destinations. Preserve explicit (including quoted) flags.
    const reporterPresent = /(?:^|\s|")--test-reporter(?:[=\s"]|$)/.test(nodeOptions);
    const reporterAppend = reporterPresent ? null : '--test-reporter=tap';
    const env = { ...process.env, NODE_OPTIONS: reporterAppend ? `${nodeOptions} ${reporterAppend}`.trim() : nodeOptions };
    // A parent Node test runner's private transport is not a contributor setting.
    delete env.NODE_TEST_CONTEXT;
    const record = { schema: SCHEMA, id, root, provenance: 'repository-development-script', state: 'running', selected, limits: { timeoutMs, maxOutputBytes }, reporter: { nodeOptionsAppend: reporterAppend, removedEnvironment: ['NODE_TEST_CONTEXT'] }, startedAt: new Date().toISOString(), checks: [] };
    await atomicRecord(base, record);
    record.before = await captureInputs(root);
    record.runtimeBefore = await runtime();
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (record.before.available) for (const id of selected) {
      if (options.signal?.aborted) break;
      const definition = CHECKS[id];
      const script = packageJson.scripts?.[definition.script];
      if (typeof script !== 'string' || !script.trim()) throw new Error(`Missing npm script: ${definition.script}`);
      const before = await captureInputs(root);
      if (!before.available) break;
      options.onProgress?.(id);
      const command = ['npm', ...definition.args];
      const result = await runCommand(command, {
        cwd: root, env,
        timeoutMs, maxOutputBytes, ...(options.signal ? { signal: options.signal } : {}),
      });
      const after = await captureInputs(root);
      const logs = {};
      let remainingBytes = maxOutputBytes;
      for (const stream of ['stdout', 'stderr']) {
        const file = `${id}.${stream}.log`;
        const encoded = Buffer.from(result[stream]);
        if (encoded.length > remainingBytes) result.outputLimitExceeded = true;
        const bytes = encoded.subarray(0, remainingBytes);
        remainingBytes -= bytes.length;
        await writeFile(path.join(runDirectory, file), bytes, { flag: 'wx', mode: 0o600 });
        logs[stream] = { file, bytes: bytes.length, sha256: hash(bytes) };
      }
      const { stdout, stderr, ...processResult } = result;
      record.checks.push({ id, command, script, category: definition.category, scope: 'configured-package-script', before, after, result: processResult, logs, analysis: classify(id, result, stdout, stderr, script) });
      await atomicRecord(base, record);
      if (result.aborted || options.signal?.aborted) break;
    }
    record.after = await captureInputs(root);
    record.runtimeAfter = await runtime();
    record.state = record.checks.length === selected.length ? 'complete' : 'incomplete';
    record.finishedAt = new Date().toISOString();
    await atomicRecord(base, record);
    return await readVerification(root, { checks: selected });
  } finally {
    await lock.close();
    if (await readFile(lockPath, 'utf8').catch(() => '') === token) await unlink(lockPath);
  }
}
