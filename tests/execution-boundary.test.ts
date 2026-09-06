import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.ts';
import { reduceProject } from '../src/engine.ts';
import { exportReproduction, verifyReproduction } from '../src/export.ts';
import { evaluateOracle } from '../src/oracle.ts';
import { runCommand } from '../src/runner.ts';
import { inventoryProject, snapshotHash } from '../src/snapshot.ts';

interface BoundaryRecord {
  cwd: string;
  relativePath: string;
  absolutePath: string;
  child: { cwd: string; relativeRead: string; absoluteRead: string };
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

test('oracle startup uses scratch directories, while child processes retain host filesystem access', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'repro-execution-boundary-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source');
  const runRoot = path.join(base, 'run');
  await mkdir(sourceRoot);
  const relativeSentinel = path.join(base, 'caller-relative.txt');
  const absoluteSentinel = path.join(sourceRoot, 'caller-absolute.txt');
  const recordsFile = path.join(base, 'oracle-records.jsonl');
  const relativeMarker = 'Harmless relative sentinel owned by this test.\n';
  const absoluteMarker = 'Harmless absolute sentinel owned by this test.\n';
  await writeFile(relativeSentinel, relativeMarker);
  await writeFile(absoluteSentinel, absoluteMarker);
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'boundary-case', version: '1.0.0', private: true, type: 'module' }));
  await writeFile(path.join(sourceRoot, 'package-lock.json'), JSON.stringify({ name: 'boundary-case', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'boundary-case', version: '1.0.0' } } }));
  await writeFile(path.join(sourceRoot, 'unused.txt'), 'An irrelevant file that the reducer can remove.\n');

  // Every path below was created inside this test's unique temporary directory.
  // The excluded source sentinel deliberately demonstrates that inventory
  // exclusions and a temporary cwd do not revoke a subprocess's host permissions.
  const childSource = `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
const [relative, absolute] = process.argv.slice(1);
const relativeRead = readFileSync(relative, 'utf8').split('\\n')[0];
const absoluteRead = readFileSync(absolute, 'utf8').split('\\n')[0];
assert.equal(relativeRead, ${JSON.stringify(relativeMarker.trim())});
assert.equal(absoluteRead, ${JSON.stringify(absoluteMarker.trim())});
appendFileSync(relative, 'child visited\\n');
appendFileSync(absolute, 'child visited\\n');
process.stdout.write(JSON.stringify({ cwd: realpathSync(process.cwd()), relativeRead, absoluteRead }));
`;
  const oracleSource = `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
const cwd = realpathSync(process.cwd());
assert.notEqual(cwd, ${JSON.stringify(sourceRoot)}, 'Oracle started in the original source');
const relativePath = path.relative(cwd, ${JSON.stringify(relativeSentinel)});
assert(relativePath.startsWith('..' + path.sep), 'Relative sentinel must be outside scratch');
const absolutePath = ${JSON.stringify(absoluteSentinel)};
const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}, '--', relativePath, absolutePath], { encoding: 'utf8', timeout: 2000 });
assert.equal(child.status, 0, child.stderr);
appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify({ cwd, relativePath, absolutePath, child: JSON.parse(child.stdout) }) + '\\n');
process.stderr.write('BOUNDARY_TARGET: caller-owned sentinels reached\\n');
process.exit(7);
`;
  await writeFile(path.join(sourceRoot, 'check.mjs'), oracleSource);
  const config = parseConfig({
    command: [process.execPath, 'check.mjs'],
    oracle: { exitCode: 7, allOf: ['BOUNDARY_TARGET: caller-owned sentinels reached'] },
    preserve: ['check.mjs'], exclude: ['caller-absolute.txt'],
    reduce: { files: true, syntax: false, json: false, dependencies: false },
    budget: { maxEvaluations: 4, maxSeconds: 60 },
  });
  const inventory = await inventoryProject(sourceRoot, config);
  assert(!inventory.snapshot.has('caller-absolute.txt'));
  const originalHash = snapshotHash(inventory.snapshot);

  // A wrong-cwd control establishes that moving oracle startup back into source
  // would fail this fixture before any child can read or write the sentinels.
  const wrongCwd = await runCommand(config.command, { cwd: sourceRoot, timeoutMs: 4_000, maxOutputBytes: 64 * 1024 });
  assert.equal(evaluateOracle(wrongCwd, config.oracle).status, 'absent');
  assert.match(wrongCwd.stderr, /Oracle started in the original source/);
  await assert.rejects(access(recordsFile));
  assert.equal(await readFile(relativeSentinel, 'utf8'), relativeMarker);
  assert.equal(await readFile(absoluteSentinel, 'utf8'), absoluteMarker);

  let recordedExecutions = 0;
  async function assertExecutions(additional: number): Promise<void> {
    const records = (await readFile(recordsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as BoundaryRecord);
    assert.equal(records.length, recordedExecutions + additional);
    for (const record of records.slice(recordedExecutions)) {
      assert(isWithin(base, record.cwd), 'Oracle cwd must belong to the controlled temporary parent');
      assert(!isWithin(sourceRoot, record.cwd), 'Oracle must start outside original source');
      assert(!isWithin(runRoot, record.cwd), 'Oracle must start outside persistent run/export directories');
      assert.equal(record.child.cwd, record.cwd, 'The nested child inherits the scratch cwd');
      assert(record.relativePath.startsWith('..' + path.sep));
      assert.equal(path.resolve(record.cwd, record.relativePath), relativeSentinel);
      assert.equal(record.absolutePath, absoluteSentinel);
      assert.equal(record.child.relativeRead, relativeMarker.trim());
      assert.equal(record.child.absoluteRead, absoluteMarker.trim());
      await assert.rejects(access(record.cwd), 'Completed phases must dispose their execution workspace');
    }
    recordedExecutions = records.length;
    assert.equal(await readFile(relativeSentinel, 'utf8'), relativeMarker + 'child visited\n'.repeat(recordedExecutions));
    assert.equal(await readFile(absoluteSentinel, 'utf8'), absoluteMarker + 'child visited\n'.repeat(recordedExecutions));
    assert.equal(snapshotHash((await inventoryProject(sourceRoot, config)).snapshot), originalHash, 'Captured source remains unchanged even though the child changed the excluded source sentinel');
    assert.deepEqual((await readdir(base)).filter(name => name.startsWith('repro-surgeon-') || name.startsWith('repro-verifier-')), []);
  }

  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = base;
  try {
    const reduced = await reduceProject({ sourceRoot, runRoot, config });
    assert.equal(reduced.state.status, 'verifying');
    assert.equal(reduced.state.baseline.length, 3);
    assert.equal(reduced.state.trials.length, 1);
    assert.equal(reduced.state.trials[0]!.accepted, true);
    assert.equal(reduced.state.trials[0]!.confirmations, 2);
    assert(!reduced.snapshot.has('unused.txt'));
    await assertExecutions(5);

    const exported = await exportReproduction(runRoot, reduced.state, reduced.snapshot);
    assert.equal(exported.verification.status, 'verified');
    assert.equal(exported.verification.runs, 3);
    await assertExecutions(3);

    const exportRoot = path.join(runRoot, 'repro');
    const verified = await verifyReproduction(exportRoot);
    assert.equal(verified.status, 'verified');
    assert.equal(verified.runs, 3);
    await assertExecutions(3);

    const standalone = await runCommand([process.execPath, '.repro/verify.mjs'], {
      cwd: exportRoot, timeoutMs: 20_000, maxOutputBytes: 64 * 1024,
      env: { PATH: process.env.PATH ?? '', TMPDIR: base },
    });
    assert.equal(standalone.exitCode, 0, standalone.stderr);
    assert.match(standalone.stdout, /Configured failure reproduced/);
    await assertExecutions(1);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});
