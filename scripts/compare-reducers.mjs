#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { reduceProject } from '../dist/engine.js';
import { evaluateOracle } from '../dist/oracle.js';
import { cleanEnvironment, runCommand } from '../dist/runner.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repository, 'examples', 'comparison');
const { values } = parseArgs({ options: { out: { type: 'string' }, treereduce: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node scripts/compare-reducers.mjs --out <new-directory> [--treereduce <treereduce-javascript-0.4.1>]\nBuild Repro Surgeon first. The experiment runs only its owned frozen fixture.');
  process.exit(0);
}
if (!values.out) throw new Error('--out must name a new experiment directory');
const output = path.resolve(values.out);
const treereduce = values.treereduce ?? 'treereduce-javascript';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const protocol = JSON.parse(await readFile(path.join(fixture, 'freeze.json'), 'utf8'));
for (const [name, expected] of Object.entries(protocol.sha256)) {
  assert.equal(digest(await readFile(path.join(repository, name))), expected, `Frozen experiment changed: ${name}`);
}
const config = await loadConfig(path.join(fixture, 'repro-surgeon.json'));
assert.equal(config.budget.maxSeconds, protocol.searchSeconds);
assert.equal(protocol.treereduceVersion, '0.4.1');
await mkdir(output, { mode: 0o700 });
await mkdir(path.join(output, 'home'), { mode: 0o700 });
const environment = cleanEnvironment(path.join(output, 'home'), []);
const execute = (command, cwd, env = environment, timeoutMs = 2000) => runCommand(command, { cwd, env, timeoutMs, maxOutputBytes: 1048576 });
const treeVersion = await execute([treereduce, '--version'], output);
assert.equal(treeVersion.exitCode, 0, treeVersion.stderr);
assert.equal(treeVersion.stdout.trim(), 'treereduce 0.4.1');
const nodeVersion = await execute(['node', '--version'], output);
assert.equal(nodeVersion.stdout.trim(), process.version, 'Both tools must use the same Node version');
const npmVersion = await execute(['npm', '--version'], output, environment, 10000);
assert.equal(npmVersion.exitCode, 0);
const source = await readFile(path.join(fixture, 'subject.cjs'));
const checker = path.join(fixture, 'check.cjs');

async function inspect(code, label) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'repro-comparison-check-'));
  try {
    await writeFile(path.join(directory, 'subject.cjs'), code);
    await copyFile(checker, path.join(directory, 'check.cjs'));
    const execution = await execute(['node', 'check.cjs'], directory);
    const observation = evaluateOracle(execution, config.oracle);
    return { label, exitCode: execution.exitCode, oracle: observation.status, timedOut: execution.timedOut, aborted: execution.aborted, diagnostics: observation.diagnostics };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const controls = [
  await inspect(source, 'original'),
  await inspect(Buffer.from(source.toString().replace('return numeric.sort();', 'return numeric.sort((left, right) => left - right);')), 'fixed-numeric-comparator'),
  await inspect(Buffer.from('throw new Error("owned different-failure control");\n'), 'different-failure'),
  await inspect(Buffer.from('function {\n'), 'syntax-error'),
];
assert.equal(controls[0].oracle, 'reproduced');
assert.deepEqual(controls.slice(1).map(control => control.oracle), ['absent', 'absent', 'absent']);
assert.deepEqual(controls.slice(1).map(control => control.exitCode), [0, 2, 2]);
await writeFile(path.join(output, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');
await writeFile(path.join(output, 'controls.json'), JSON.stringify(controls, null, 2) + '\n');

async function queries(file) {
  const rows = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { calls: rows.length, uniqueSubjectHashes: new Set(rows.map(row => row.sourceHash)).size, target: rows.filter(row => row.status === 'target').length, absent: rows.filter(row => row.status === 'absent').length, other: rows.filter(row => row.status === 'other').length };
}

async function verifyFresh(code, label) {
  const observations = [];
  const started = performance.now();
  for (let run = 0; run < protocol.finalRuns; run++) {
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'repro-comparison-final-'));
    try {
      for (const name of ['package.json', 'package-lock.json', 'check.cjs']) await copyFile(path.join(fixture, name), path.join(directory, name));
      await writeFile(path.join(directory, 'subject.cjs'), code);
      const home = path.join(directory, 'home');
      await mkdir(home);
      const env = cleanEnvironment(home, []);
      const installed = await execute(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory, env, 20000);
      assert.equal(installed.exitCode, 0, installed.stderr);
      const execution = await execute(['node', 'check.cjs'], directory, env);
      const observed = evaluateOracle(execution, config.oracle);
      observations.push({ exitCode: execution.exitCode, oracle: observed.status });
      assert.equal(observed.status, 'reproduced', `${label} final run ${run + 1}: ${observed.reason}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { runs: observations, elapsedMs: performance.now() - started, freshInstallationPerRun: true };
}

// Order, flags, fixture and ceilings were selected before inspecting reductions.
const results = [];
const treeLog = path.join(output, 'treereduce-queries.jsonl');
const treeOutput = path.join(output, 'treereduce-subject.cjs');
const treeCommand = [treereduce, '--source', path.join(fixture, 'subject.cjs'), '--output', treeOutput, '--jobs', '1', '--stable', '--min-reduction', '1', '--on-parse-error', 'error', '--interesting-exit-code', '1', '--timeout', '2', '--stats', '--', 'node', checker, '@@.cjs'];
console.error('Running treereduce-javascript 0.4.1 (serial; 120-second ceiling)…');
const treeStarted = performance.now();
const treeExecution = await execute(treeCommand, output, { ...environment, COMPARISON_LOG: treeLog }, protocol.searchSeconds * 1000);
const treeElapsed = performance.now() - treeStarted;
await writeFile(path.join(output, 'treereduce-execution.json'), JSON.stringify(treeExecution, null, 2) + '\n');
assert.ok(treeExecution.timedOut || treeExecution.exitCode === 0, `treereduce failed: ${treeExecution.stderr}`);
let treeUsedOriginal = false;
const treeReduced = await readFile(treeOutput).catch(error => {
  if (!treeExecution.timedOut || error.code !== 'ENOENT') throw error;
  treeUsedOriginal = true;
  return source;
});
results.push({ tool: 'treereduce-javascript', version: '0.4.1', searchMs: treeElapsed, processExitCode: treeExecution.exitCode, budgetExpired: treeExecution.timedOut, usedOriginalAfterDeadline: treeUsedOriginal, stop: treeExecution.timedOut ? '120-second outer deadline; checked latest saved output or original if none' : 'stable search completed', queries: await queries(treeLog), reducedBytes: treeReduced.length, sha256: digest(treeReduced), reducedSource: treeReduced.toString(), finalVerification: await verifyFresh(treeReduced, 'treereduce') });

console.error('Running Repro Surgeon syntax-only (serial; 120-second ceiling)…');
const surgeonLog = path.join(output, 'repro-surgeon-queries.jsonl');
const previousLog = process.env.COMPARISON_LOG;
process.env.COMPARISON_LOG = surgeonLog;
const controller = new AbortController();
const surgeonStarted = performance.now();
const timer = setTimeout(() => controller.abort(), protocol.searchSeconds * 1000);
let reduction;
try { reduction = await reduceProject({ sourceRoot: fixture, runRoot: path.join(output, 'repro-surgeon-run'), config, signal: controller.signal }); }
finally {
  clearTimeout(timer);
  if (previousLog === undefined) delete process.env.COMPARISON_LOG;
  else process.env.COMPARISON_LOG = previousLog;
}
const surgeonElapsed = performance.now() - surgeonStarted;
const surgeonReduced = reduction.snapshot.get('subject.cjs').content;
await writeFile(path.join(output, 'repro-surgeon-subject.cjs'), surgeonReduced);
assert.equal(digest(await readFile(path.join(fixture, 'subject.cjs'))), digest(source), 'Original fixture changed');
for (const [name, entry] of reduction.snapshot) {
  if (name !== 'subject.cjs') assert.equal(digest(entry.content), digest(await readFile(path.join(fixture, name))), `Pinned file changed: ${name}`);
}
const packageMetadata = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
assert.equal(packageMetadata.version, protocol.reproSurgeonVersion);
results.push({ tool: 'Repro Surgeon', version: packageMetadata.version, searchMs: surgeonElapsed, engineRecordedMs: reduction.state.elapsedMs, budgetExpired: controller.signal.aborted || /budget/i.test(reduction.state.stopReason), stop: reduction.state.stopReason, candidateEvaluations: reduction.state.evaluations, baselineCalls: reduction.state.baseline.length, acceptedTrials: reduction.state.trials.filter(trial => trial.accepted).length, queries: await queries(surgeonLog), reducedBytes: surgeonReduced.length, sha256: digest(surgeonReduced), reducedSource: surgeonReduced.toString(), finalVerification: await verifyFresh(surgeonReduced, 'Repro Surgeon') });

const result = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  protocol,
  runtime: { node: process.version, npm: npmVersion.stdout.trim(), platform: process.platform, arch: process.arch, osRelease: release(), cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length },
  implementationHashes: Object.fromEntries(await Promise.all(['engine', 'transforms', 'runner', 'oracle', 'dependencies', 'snapshot'].map(async name => [name, digest(await readFile(path.join(repository, 'dist', name + '.js')))]))),
  originalBytes: source.length,
  controls,
  results,
  limitations: ['One seeded, independently authored single-file fixture; one measured run per tool, treereduce first.', 'Same editable subject and precise property, different native transformation sets and repeated-check policies.', 'Repro Surgeon includes three baseline runs and two confirmations per accepted candidate; treereduce uses its native checks. Query counts include all native checks during search.', 'Search times are end-to-end observed tool calls under equal 120-second ceilings. Separate common fresh checks are reported separately; normal Repro Surgeon export generation is not timed.', 'No whole-application, typical-case, independent-maintainer, or general superiority claim.'],
};
for (const [name, expected] of Object.entries(protocol.sha256)) {
  assert.equal(digest(await readFile(path.join(repository, name))), expected, `Frozen experiment changed during measurement: ${name}`);
}
await writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: path.join(output, 'results.json'), originalBytes: source.length, results: results.map(({ tool, reducedBytes, searchMs, queries, stop }) => ({ tool, reducedBytes, searchMs, queries, stop })) }, null, 2));
