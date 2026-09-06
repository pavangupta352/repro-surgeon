import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'repro-surgeon-package-'));
function run(command, args, cwd = project, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function sourceFiles(root, relative = '') {
  const files = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.join(relative, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected bundled source symlink: ${name}`);
    if (entry.isDirectory()) files.push([name, null], ...await sourceFiles(root, name));
    else files.push([name, await readFile(path.join(root, name))]);
  }
  return files;
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary]));
  const entry = packed[0];
  assert(entry.files.some(file => file.path === 'dist/cli.js'));
  assert(entry.files.some(file => file.path === 'LICENSE'));
  for (const asset of ['repro-surgeon.json', 'package.json', 'package-lock.json', 'check.mjs', 'src/totals.mjs', 'fixtures/invoice.json']) {
    assert(entry.files.some(file => file.path === `examples/rounding/${asset}`), `Package is missing demo asset ${asset}`);
  }
  assert(!entry.files.some(file => /(?:^|\/)(?:\.local|AGENTS\.md|node_modules)(?:\/|$)/.test(file.path)));
  const prefix = path.join(temporary, 'installed');
  run('npm', ['install', '--prefix', prefix, path.join(temporary, entry.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = path.join(prefix, 'node_modules', 'repro-surgeon');
  const cli = path.join(prefix, 'node_modules', '.bin', 'repro-surgeon');
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.match(run(cli, ['--help'], temporary), /repro-surgeon demo/);
  assert.equal(run(cli, ['--version'], temporary).trim(), metadata.version);
  const output = path.join(temporary, 'result');
  const source = path.join(installed, 'examples', 'rounding');
  const before = await sourceFiles(source);
  await writeFile(path.join(temporary, 'repro-surgeon.json'), 'The demo must use its own bundled configuration.');
  const report = JSON.parse(run(cli, ['demo', '--out', output, '--json'], temporary));
  assert.equal(report.verification.status, 'verified');
  assert.equal(report.verification.runs, 3);
  assert.deepEqual(report.baseline, { completed: 3, required: 3 });
  const accepted = report.trials.filter(trial => trial.accepted);
  assert(accepted.length > 0);
  assert(accepted.every(trial => trial.confirmations === 2));
  assert(report.current.sourceBytes < report.initial.sourceBytes);
  assert.deepEqual(await sourceFiles(source), before);
  const checkpoint = JSON.parse(await readFile(path.join(output, 'state.json'), 'utf8'));
  assert.equal(checkpoint.state.sourceRoot, await realpath(source));
  await rm(prefix, { recursive: true, force: true });
  run(process.execPath, [path.join(output, 'repro', '.repro', 'verify.mjs')], temporary);
  assert.match(await readFile(path.join(output, 'report.html'), 'utf8'), /Fresh verification passed/);
  console.log(JSON.stringify({ package: entry.filename, version: metadata.version, command: 'demo', files: entry.entryCount, bytes: entry.size, initial: report.initial, current: report.current, baselineRuns: report.baseline.completed, candidateRuns: 2, independentRuns: report.verification.runs, standaloneAfterToolRemoval: true }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
