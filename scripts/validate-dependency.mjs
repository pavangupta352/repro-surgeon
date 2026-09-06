// Opt-in registry integration: build the tool first, then run this file explicitly.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, inventoryProject, snapshotHash, reduceProject, exportReproduction, evaluateOracle } from '../dist/index.js';
import { createIsolatedDirectory, WorkspaceManager } from '../dist/dependencies.js';
import { runCommand } from '../dist/runner.js';

const output = path.resolve(process.argv[2] ?? await createIsolatedDirectory('repro-dependency-validation-'));
await mkdir(output, { recursive: true });
const sourceRoot = path.join(output, 'input');
await mkdir(sourceRoot);
const target = 'OWNED_DEPENDENCY_TOTAL_MISMATCH: expected 12, got 13';
const config = parseConfig({
  name: 'Owned unused public dependency integration',
  command: ['node', 'check.cjs'],
  oracle: { exitCode: 1, allOf: [target], noneOf: ['UNRELATED_DEPENDENCY_FAILURE', 'Cannot find module'] },
  budget: { maxEvaluations: 8, maxSeconds: 120 },
  execution: { timeoutMs: 10000, installTimeoutMs: 120000, allowInstallScripts: false },
  reduce: { files: false, syntax: false, json: false, dependencies: true },
});
await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'owned-dependency-removal', version: '1.0.0', private: true, dependencies: { picomatch: '4.0.7' } }, null, 2) + '\n');
await writeFile(path.join(sourceRoot, 'check.cjs'), `const { readFileSync } = require('node:fs');
const value = JSON.parse(readFileSync('invoice.json', 'utf8'));
if (value.total !== value.expected) {
  console.error(${JSON.stringify(target)});
  process.exit(1);
}
console.log('Owned control passed');
`);
await writeFile(path.join(sourceRoot, 'invoice.json'), '{ "expected": 12, "total": 13 }\n');
const signal = AbortSignal.timeout(300000);
const controlRoot = path.join(output, 'controls');
const manager = new WorkspaceManager(controlRoot, config, signal);
const observations = [];
let installedVersion;
try {
  // Generate the real public-registry lock without running inside the input tree.
  const lockRoot = await createIsolatedDirectory('repro-dependency-lock-');
  try {
    await writeFile(path.join(lockRoot, 'package.json'), await readFile(path.join(sourceRoot, 'package.json')));
    await manager.install(lockRoot, true);
    await writeFile(path.join(sourceRoot, 'package-lock.json'), await readFile(path.join(lockRoot, 'package-lock.json')));
  } finally { await rm(lockRoot, { recursive: true, force: true }); }
  const { snapshot } = await inventoryProject(sourceRoot, config);
  const originalLock = JSON.parse(snapshot.get('package-lock.json').content);
  assert.equal(originalLock.packages['node_modules/picomatch'].version, '4.0.7');
  assert.match(originalLock.packages['node_modules/picomatch'].resolved, /^https:\/\/registry\.npmjs\.org\//);
  const installed = await manager.prepare(snapshot);
  assert.equal(JSON.parse(await readFile(path.join(installed, 'node_modules', 'picomatch', 'package.json'))).version, '4.0.7');
  const version = await runCommand(['node', '-p', "require('picomatch/package.json').version"], { cwd: installed, env: await manager.environment(), timeoutMs: 10000, maxOutputBytes: 4096, signal });
  assert.equal(version.exitCode, 0, version.stderr);
  installedVersion = version.stdout.trim();
  assert.equal(installedVersion, '4.0.7');
  for (const kind of ['trigger-removed', 'different-failure']) {
    const control = new Map(snapshot);
    if (kind === 'trigger-removed') control.set('invoice.json', { mode: 0o644, content: Buffer.from('{ "expected": 12, "total": 12 }\n') });
    else control.set('check.cjs', { mode: 0o644, content: Buffer.from("console.error('UNRELATED_DEPENDENCY_FAILURE'); process.exit(1);\n") });
    const cwd = await manager.prepare(control);
    const execution = await runCommand(config.command, { cwd, env: await manager.environment(), timeoutMs: config.execution.timeoutMs, maxOutputBytes: config.execution.maxOutputBytes, signal });
    const oracle = evaluateOracle(execution, config.oracle);
    assert.equal(execution.exitCode, kind === 'trigger-removed' ? 0 : 1, execution.stderr);
    assert.equal(oracle.status, 'absent', oracle.reason);
    observations.push({ kind, execution, oracle });
    await writeFile(path.join(controlRoot, kind + '.json'), JSON.stringify({ execution, oracle }, null, 2) + '\n');
  }
} finally { await manager.dispose(); }
const before = snapshotHash((await inventoryProject(sourceRoot, config)).snapshot);
const runRoot = path.join(output, 'run');
const started = Date.now();
const reduction = await reduceProject({ sourceRoot, runRoot, config, signal, onEvent: event => process.stderr.write(`dependency: ${event.message}\n`) });
assert.equal(reduction.state.status, 'verifying');
assert(reduction.state.trials.some(trial => trial.kind === 'dependencies' && trial.accepted && trial.confirmations === 2));
const pkg = JSON.parse(reduction.snapshot.get('package.json').content);
const lock = JSON.parse(reduction.snapshot.get('package-lock.json').content);
assert.equal(pkg.dependencies?.picomatch, undefined);
assert.equal(lock.packages[''].dependencies?.picomatch, undefined);
assert.equal(lock.packages['node_modules/picomatch'], undefined);
const state = await exportReproduction(runRoot, reduction.state, reduction.snapshot, { signal });
assert.equal(state.verification.status, 'verified', state.verification.reason);
assert.equal(state.verification.runs, 3);
assert.deepEqual(JSON.parse(await readFile(path.join(runRoot, 'repro', 'package.json'))), pkg);
assert.deepEqual(JSON.parse(await readFile(path.join(runRoot, 'repro', 'package-lock.json'))), lock);
assert.equal(snapshotHash((await inventoryProject(sourceRoot, config)).snapshot), before, 'Original source changed');
const standalone = await runCommand(['node', path.join(runRoot, 'repro', '.repro', 'verify.mjs')], { cwd: output, timeoutMs: 120000, maxOutputBytes: 16384, signal });
assert.equal(standalone.exitCode, 0, standalone.stderr);
const summary = { case: 'owned-public-dependency-removal', package: 'picomatch', installedVersion, sourceHash: before, sourceUnchanged: true, manifestDependencyRemoved: true, lockDependencyRemoved: true, runtime: state.runtime, initial: state.initial, current: state.current, baseline: state.baseline.map(value => value.status), evaluations: state.evaluations, accepted: state.trials.filter(trial => trial.accepted), totalMs: Date.now() - started, verification: state.verification, standalone: { exitCode: standalone.exitCode, stdout: standalone.stdout }, controls: observations.map(({ kind, execution, oracle }) => ({ kind, exitCode: execution.exitCode, status: oracle.status })) };
await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, ...summary }, null, 2));
