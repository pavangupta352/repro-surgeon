import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary]));
  const entry = packed[0];
  assert(entry.files.some(file => file.path === 'dist/cli.js'));
  assert(entry.files.some(file => file.path === 'LICENSE'));
  assert(!entry.files.some(file => /(?:^|\/)(?:\.local|AGENTS\.md|node_modules)(?:\/|$)/.test(file.path)));
  const prefix = path.join(temporary, 'installed');
  run('npm', ['install', '--prefix', prefix, path.join(temporary, entry.filename), '--ignore-scripts', '--no-audit', '--no-fund']);
  const installed = path.join(prefix, 'node_modules', 'repro-surgeon');
  const cli = path.join(prefix, 'node_modules', '.bin', 'repro-surgeon');
  assert.match(run(cli, ['--help'], temporary), /smaller source/);
  const output = path.join(temporary, 'result');
  const source = path.join(installed, 'examples', 'rounding');
  const before = await readFile(path.join(source, 'src', 'totals.mjs'));
  const report = JSON.parse(run(cli, ['reduce', source, '--out', output, '--json'], temporary));
  assert.equal(report.verification.status, 'verified');
  assert.equal(report.verification.runs, 3);
  assert(report.current.sourceBytes < report.initial.sourceBytes);
  assert.deepEqual(await readFile(path.join(source, 'src', 'totals.mjs')), before);
  run(process.execPath, [path.join(output, 'repro', '.repro', 'verify.mjs')], temporary);
  assert.match(await readFile(path.join(output, 'report.html'), 'utf8'), /Fresh verification passed/);
  console.log(JSON.stringify({ package: entry.filename, files: entry.entryCount, bytes: entry.size, initial: report.initial, current: report.current, independentRuns: report.verification.runs }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
