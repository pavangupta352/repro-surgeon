import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadCheckpoint, saveCheckpoint } from '../src/state.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(args: string[], cwd?: string) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000 }); }

test('CLI help/version work and unknown commands/options fail', () => {
  assert.equal(run(['--help']).status, 0);
  assert.match(run(['--help']).stdout, /reduce/);
  assert.match(run(['--version']).stdout, /0\.1\.0/);
  assert.equal(run(['unrecognized']).status, 2);
  assert.equal(run(['reduce', '--fake-option']).status, 2);
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
