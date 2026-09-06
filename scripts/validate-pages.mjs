// Opt-in public-registry/build integration; this is not part of native default tests.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, inventoryProject, snapshotHash, reduceProject, exportReproduction, evaluateOracle } from '../dist/index.js';
import { createIsolatedDirectory, WorkspaceManager } from '../dist/dependencies.js';
import { runCommand } from '../dist/runner.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = path.join(root, 'examples', 'next-pages');
const output = path.resolve(process.argv[2] ?? await createIsolatedDirectory('repro-pages-validation-'));
await mkdir(output, { recursive: true });
const config = await loadConfig(path.join(sourceRoot, 'repro-surgeon.json'));
const { snapshot } = await inventoryProject(sourceRoot, config);
const before = snapshotHash(snapshot);
const signal = AbortSignal.timeout(1200000);
const controlRoot = path.join(output, 'controls');
const manager = new WorkspaceManager(controlRoot, config, signal);
const observations = [];
try {
  for (const kind of ['trigger-removed', 'different-failure']) {
    const selected = new Map(snapshot);
    const page = selected.get('pages/index.jsx');
    const trigger = "throw new Error('OWNED_PAGES_TOTAL_MISMATCH: expected 12, got 13');";
    assert(page.content.toString().includes(trigger));
    selected.set('pages/index.jsx', { ...page, content: Buffer.from(page.content.toString().replace(trigger, '')) });
    if (kind === 'different-failure') selected.set('next.config.mjs', { mode: 0o644, content: Buffer.from("throw new Error('UNRELATED_PAGES_FAILURE');\n") });
    const cwd = await manager.prepare(selected);
    const execution = await runCommand(config.command, { cwd, env: await manager.environment(), timeoutMs: config.execution.timeoutMs, maxOutputBytes: config.execution.maxOutputBytes, signal });
    const oracle = evaluateOracle(execution, config.oracle);
    await writeFile(path.join(controlRoot, kind + '.json'), JSON.stringify({ execution, oracle }, null, 2) + '\n');
    assert.equal(execution.exitCode, kind === 'trigger-removed' ? 0 : 1, `${execution.stdout}\n${execution.stderr}`);
    assert.equal(oracle.status, 'absent', oracle.reason);
    observations.push({ kind, exitCode: execution.exitCode, status: oracle.status });
    process.stderr.write(`pages: ${kind} control rejected as expected\n`);
  }
} finally { await manager.dispose(); }
const started = Date.now();
const runRoot = path.join(output, 'run');
const reduction = await reduceProject({ sourceRoot, runRoot, config, signal, onEvent: event => process.stderr.write(`pages: ${event.message}\n`) });
assert.equal(reduction.state.status, 'verifying');
assert.equal(reduction.state.adapter.name, 'next');
assert.equal(reduction.state.adapter.router, 'pages');
assert(reduction.state.current.sourceBytes < reduction.state.initial.sourceBytes);
const state = await exportReproduction(runRoot, reduction.state, reduction.snapshot, { signal });
assert.equal(state.verification.status, 'verified', state.verification.reason);
assert.equal(state.verification.runs, 3);
assert.equal(snapshotHash((await inventoryProject(sourceRoot, config)).snapshot), before, 'Original source changed');
const summary = { case: 'owned-next-pages-static-props-failure', provenance: 'Independently authored seeded application failure; no external reproduction source', sourceHash: before, sourceUnchanged: true, runtime: state.runtime, adapter: state.adapter, initial: state.initial, current: state.current, baseline: state.baseline.map(value => value.status), evaluations: state.evaluations, accepted: state.trials.filter(trial => trial.accepted), searchMs: state.elapsedMs, totalMs: Date.now() - started, verification: state.verification, controls: observations };
await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
await rm(path.join(runRoot, 'installations'), { recursive: true, force: true });
await rm(path.join(controlRoot, 'installations'), { recursive: true, force: true });
console.log(JSON.stringify({ output, ...summary }, null, 2));
