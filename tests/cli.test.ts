import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, realpath, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadCheckpoint, saveCheckpoint } from '../src/state.ts';
import { loadConfig } from '../src/config.ts';
import { inventoryProject, snapshotHash } from '../src/snapshot.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));
function run(args: string[], cwd?: string) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000 }); }

test('CLI help/version work and unknown commands/options fail', async () => {
  const metadata = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /reduce/);
  assert.match(run(['--help']).stdout, /repro-surgeon demo/);
  assert.equal(run(['--version']).stdout.trim(), metadata.version);
  assert.equal(run(['unrecognized']).status, 2);
  assert.equal(run(['reduce', '--fake-option']).status, 2);
});

test('demo uses the bundled source from any directory and runs the complete verified flow without changing it', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-demo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(base, 'repro-surgeon.json'), 'This unrelated local config must not be read.');
  const source = path.join(project, 'examples', 'rounding');
  const config = await loadConfig(path.join(source, 'repro-surgeon.json'));
  const before = snapshotHash((await inventoryProject(source, config)).snapshot);
  const entries = await readdir(source, { recursive: true });
  const output = path.join(base, 'result with spaces');
  const result = run(['demo', '--out', output, '--max-evaluations', '12', '--max-seconds', '60', '--json'], base);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verification.status, 'verified');
  assert.equal(report.verification.runs, 3);
  assert.deepEqual(report.baseline, { completed: 3, required: 3 });
  assert(report.current.sourceBytes < report.initial.sourceBytes);
  assert(report.trials.some((trial: { accepted: boolean }) => trial.accepted));
  assert(report.trials.filter((trial: { accepted: boolean }) => trial.accepted).every((trial: { confirmations: number }) => trial.confirmations === 2));
  const { state } = await loadCheckpoint(output);
  assert.equal(state.sourceRoot, await realpath(source));
  assert.equal(state.config.budget.maxEvaluations, 12);
  assert.equal(state.config.budget.maxSeconds, 60);
  assert.match(await readFile(path.join(output, 'report.html'), 'utf8'), /Fresh verification passed/);
  const standalone = spawnSync(process.execPath, [path.join(output, 'repro', '.repro', 'verify.mjs')], { cwd: base, encoding: 'utf8', timeout: 10000 });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(snapshotHash((await inventoryProject(source, config)).snapshot), before);
  assert.deepEqual(await readdir(source, { recursive: true }), entries);
  const repeated = run(['demo', '--out', output], base);
  assert.equal(repeated.status, 2);
  assert.match(repeated.stderr, /already exists.*new directory|already exists.*resume/i);
  assert.equal((await loadCheckpoint(output)).state.bestHash, state.bestHash);
});

test('demo defaults to a timestamped output directory under the current working directory', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-demo-default-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = run(['demo', '--max-evaluations', '1', '--json'], base);
  assert.equal(result.status, 0, result.stderr);
  const names = await readdir(base);
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^repro-surgeon-demo-\d+$/);
  const { state } = await loadCheckpoint(path.join(base, names[0]!));
  assert.equal(state.verification.status, 'verified');
});

test('demo rejects project, configuration and oracle overrides instead of ignoring them', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-demo-args-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const args of [['some-project'], ['--config', 'custom.json'], ['--match', 'different target'], ['--forbid', 'other text'], ['--exit', '0']]) {
    const result = run(['demo', ...args], base);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /demo.*bundled|bundled.*demo/i);
  }
  const command = run(['demo', '--', 'node', 'custom.mjs'], base);
  assert.equal(command.status, 2);
  assert.match(command.stderr, /only by init|bundled.*demo/i);
  assert.deepEqual(await readdir(base), []);
});

test('an incomplete package explains missing demo assets and reads its own version metadata', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-demo-assets-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await cp(path.join(project, 'src'), path.join(base, 'src'), { recursive: true });
  await symlink(path.join(project, 'node_modules'), path.join(base, 'node_modules'), 'dir');
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'repro-surgeon', version: '9.8.7', type: 'module' }));
  const copiedCli = path.join(base, 'src', 'cli.ts');
  const missing = spawnSync(process.execPath, [copiedCli, 'demo'], { cwd: base, encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /bundled.*demo.*reinstall|bundled.*demo.*restore/i);
  const version = spawnSync(process.execPath, [copiedCli, '--version'], { cwd: base, encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '9.8.7');
  assert(!(await readdir(base)).some(name => name.startsWith('repro-surgeon-demo-')));
});

test('init preserves argv, refuses overwriting configuration, and doctor is read-only', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"name":"case"}');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{"name":"case"}}}');
  const args = ['init', root, '--match', 'expected failure', '--', 'node', 'a file.js', '--literal'];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(path.join(root, 'repro-surgeon.json'), 'utf8'));
  assert.deepEqual(config.command, ['node', 'a file.js', '--literal']);
  assert.equal(run(args).status, 2);
  const doctor = run(['doctor', root, '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  const summary = JSON.parse(doctor.stdout);
  assert.equal(summary.adapter.name, 'generic');
  assert.equal(summary.metrics.dependencies, 0);
  await writeFile(path.join(root, 'ignored-by-config.txt'), 'private fixture');
  config.exclude = ['ignored-by-config.txt'];
  await writeFile(path.join(root, 'repro-surgeon.json'), JSON.stringify(config));
  const configured = JSON.parse(run(['doctor', root, '--json']).stdout);
  assert(configured.excluded.some((entry: { path: string }) => entry.path === 'ignored-by-config.txt'));
  await writeFile(path.join(root, 'repro-surgeon.json'), '{broken');
  assert.equal(run(['doctor', root, '--json']).status, 2, 'Invalid default configuration must not be silently ignored');
});

test('CLI delivers an exported reproduction that verifies without the tool package', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-cli-flow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'input');
  await mkdir(source);
  await writeFile(path.join(source, 'package.json'), '{"name":"case","version":"1.0.0"}');
  await writeFile(path.join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{"name":"case","version":"1.0.0"}}}');
  await writeFile(path.join(source, 'check.cjs'), 'console.error("RANGE_MISMATCH: actual 8 expected 7"); process.exit(1);');
  await writeFile(path.join(source, 'unneeded.txt'), 'irrelevant\n'.repeat(30));
  await writeFile(path.join(source, 'repro-surgeon.json'), JSON.stringify({ command: ['node', 'check.cjs'], oracle: { exitCode: 1, allOf: ['RANGE_MISMATCH: actual 8 expected 7'] }, preserve: ['check.cjs'], reduce: { syntax: false, json: false, dependencies: false } }));
  const output = path.join(base, 'result');
  const result = run(['reduce', source, '--out', output, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.verification.status, 'verified');
  assert(summary.current.files < summary.initial.files);
  assert.match(await readFile(path.join(output, 'report.html'), 'utf8'), /Repro Surgeon/);
  const standalone = spawnSync(process.execPath, ['.repro/verify.mjs'], { cwd: path.join(output, 'repro'), encoding: 'utf8', timeout: 10000 });
  assert.equal(standalone.status, 0, standalone.stderr);
  const verified = run(['verify', path.join(output, 'repro'), '--json']);
  assert.equal(verified.status, 0, verified.stderr);
  const { state, snapshot } = await loadCheckpoint(output);
  const privateLogSentinel = 'LIFECYCLE_PRIVATE_OUTPUT_SENTINEL_4927';
  state.status = 'failed';
  state.stopReason = `Export setup failed: ${privateLogSentinel}`;
  state.verification.status = 'failed';
  state.verification.reason = `Installation failed: ${privateLogSentinel}`;
  await saveCheckpoint(output, state, snapshot);
  const failureReport = run(['report', output, '--json']);
  assert.equal(failureReport.status, 0, failureReport.stderr);
  assert(!failureReport.stdout.includes(privateLogSentinel));
  assert(!(await readFile(path.join(output, 'report.html'), 'utf8')).includes(privateLogSentinel));
  assert((await readFile(path.join(output, 'state.json'), 'utf8')).includes(privateLogSentinel), 'Private checkpoint retains diagnostic evidence');
});
