import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exportReproduction, verifyReproduction } from '../src/export.ts';
import { runCommand } from '../src/runner.ts';
import { snapshotHash } from '../src/snapshot.ts';
import { acquireRunLock, loadCheckpoint, saveCheckpoint } from '../src/state.ts';
import type { Config, RunState, Snapshot } from '../src/types.ts';

const config: Config = {
  version: 1,
  name: 'controlled failure',
  command: ['node', 'fail.mjs'],
  oracle: { exitCode: 7, allOf: ['ReferenceError: targetMarker', 'fail.mjs:1'], noneOf: ['different failure'] },
  adapter: 'generic',
  budget: { maxEvaluations: 20, maxSeconds: 60 },
  runs: { baseline: 3, candidate: 2, final: 3 },
  execution: { timeoutMs: 2_000, maxOutputBytes: 64 * 1024, installTimeoutMs: 20_000, allowInstallScripts: false, env: [] },
  reduce: { files: true, syntax: true, json: true, dependencies: true },
  include: [],
  exclude: [],
  preserve: [],
};

function project(failure = "import { existsSync } from 'node:fs';if (!process.env.HOME || !existsSync(process.env.HOME)) { process.stderr.write('different failure: missing isolated home\\n'); process.exit(7) } process.stderr.write('ReferenceError: targetMarker at fail.mjs:1\\n');process.exit(7)\n"): Snapshot {
  const pkg = { name: 'repro-export-case', version: '1.0.0', private: true, scripts: { build: 'node fail.mjs' } };
  const lock = { name: 'repro-export-case', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'repro-export-case', version: '1.0.0' } } };
  return new Map([
    ['package.json', { content: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 }],
    ['package-lock.json', { content: Buffer.from(JSON.stringify(lock, null, 2) + '\n'), mode: 0o644 }],
    ['fail.mjs', { content: Buffer.from(failure), mode: 0o644 }],
    ['LICENSE', { content: Buffer.from('Test fixture license\n'), mode: 0o644 }],
  ]);
}

function state(sourceRoot: string, snapshot: Snapshot, overrides: Partial<RunState> = {}): RunState {
  const hash = snapshotHash(snapshot);
  return {
    version: 1,
    id: `export-test-${Date.now()}-${Math.random()}`,
    sourceRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: structuredClone(config),
    configHash: 'config-hash',
    runtime: { node: process.version, npm: 'test', platform: process.platform, arch: process.arch, tool: '0.1.0' },
    originalHash: hash,
    bestHash: hash,
    initial: { files: snapshot.size, bytes: 1, sourceBytes: 1, dependencies: 0 },
    current: { files: snapshot.size, bytes: 1, sourceBytes: 1, dependencies: 0 },
    adapter: { name: 'generic', version: null, router: 'none', entrypoints: [], protectedPaths: [], warnings: [] },
    status: 'verifying',
    stopReason: '',
    evaluations: 0,
    elapsedMs: 0,
    baseline: [],
    trials: [],
    rejectedHashes: [],
    excluded: [],
    warnings: [],
    verification: { status: 'pending', runs: 0, reason: 'Not exported yet', snapshotHash: '', environment: 'fresh-directory' },
    reviewFindings: [],
    ...overrides,
  };
}

async function fixture(t: test.TestContext): Promise<{ base: string; sourceRoot: string; runRoot: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'repro-export-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source');
  const runRoot = path.join(base, 'run');
  await mkdir(sourceRoot);
  await writeFile(path.join(sourceRoot, 'untouched.txt'), 'original');
  return { base, sourceRoot, runRoot };
}

async function checkpointedExport(runRoot: string, runState: RunState, snapshot: Snapshot): Promise<RunState> {
  await saveCheckpoint(runRoot, runState, snapshot);
  return exportReproduction(runRoot, runState, snapshot);
}

test('export creates a standalone verified reproduction without changing package scripts', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const beforeHash = snapshotHash(snapshot);
  const runState = state(sourceRoot, snapshot, { stopReason: 'Search budget reached' });
  const result = await checkpointedExport(runRoot, runState, snapshot);
  const exportRoot = path.join(runRoot, 'repro');

  assert.equal(result.status, 'complete');
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.runs, 3);
  assert.match(result.verification.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(result.bestHash, beforeHash);
  assert.equal(result.stopReason, 'Search budget reached');
  assert.equal(await readFile(path.join(sourceRoot, 'untouched.txt'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(exportRoot, 'LICENSE'), 'utf8'), 'Test fixture license\n');
  await access(path.join(exportRoot, '.repro', 'README.md'));
  await access(path.join(exportRoot, '.repro', 'config.json'));
  await access(path.join(exportRoot, '.repro', 'manifest.json'));

  const exportedPackage = JSON.parse(await readFile(path.join(exportRoot, 'package.json'), 'utf8')) as { scripts: object; dependencies?: object };
  assert.deepEqual(exportedPackage.scripts, { build: 'node fail.mjs' });
  assert.equal(exportedPackage.dependencies, undefined);

  const direct = await runCommand(config.command, { cwd: exportRoot, timeoutMs: 2_000, maxOutputBytes: 64 * 1024 });
  assert.equal(direct.exitCode, 7);
  const standalone = await runCommand(['node', '.repro/verify.mjs'], { cwd: exportRoot, timeoutMs: 4_000, maxOutputBytes: 64 * 1024 });
  assert.equal(standalone.exitCode, 0, standalone.stderr);

  const verifierSource = await readFile(path.join(exportRoot, '.repro', 'verify.mjs'), 'utf8');
  assert.doesNotMatch(verifierSource, /from ['"]repro-surgeon['"]/);
  const separatelyVerified = await verifyReproduction(exportRoot);
  assert.equal(separatelyVerified.status, 'verified');
  assert.equal(separatelyVerified.runs, 3);
});

test('standalone and CLI verification reject extra or changed exported source before running it', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);
  const exportRoot = path.join(runRoot, 'repro');

  await writeFile(path.join(exportRoot, 'unexpected.mjs'), "throw new Error('must not run')\n");
  let standalone = await runCommand(['node', '.repro/verify.mjs'], { cwd: exportRoot, timeoutMs: 4_000, maxOutputBytes: 64 * 1024 });
  assert.notEqual(standalone.exitCode, 0);
  let checked = await verifyReproduction(exportRoot);
  assert.equal(checked.status, 'failed');
  assert.equal(checked.runs, 0);

  await rm(path.join(exportRoot, 'unexpected.mjs'));
  await writeFile(path.join(exportRoot, 'fail.mjs'), "process.stderr.write('different failure\\n');process.exit(7)\n");
  standalone = await runCommand(['node', '.repro/verify.mjs'], { cwd: exportRoot, timeoutMs: 4_000, maxOutputBytes: 64 * 1024 });
  assert.notEqual(standalone.exitCode, 0);
  checked = await verifyReproduction(exportRoot);
  assert.equal(checked.status, 'failed');
  assert.equal(checked.runs, 0);
});

test('fresh verification fails when intact exported source produces a different error', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project("process.stderr.write('different failure at fail.mjs:1\\n');process.exit(7)\n");
  const result = await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);

  assert.equal(result.status, 'failed');
  assert.equal(result.verification.status, 'failed');
  assert.equal(result.verification.runs, 1);
  assert.match(result.verification.reason, /forbidden|required|oracle|failure/i);
  const standalone = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: path.join(runRoot, 'repro'),
    timeoutMs: 4_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.notEqual(standalone.exitCode, 0);
  assert.match(standalone.stderr, /not reproduced|required|forbidden|failure/i);
});

test('fresh and standalone verification reject a target timeout', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project("setInterval(() => {}, 1_000)\n");
  const runState = state(sourceRoot, snapshot);
  runState.config.execution.timeoutMs = 100;
  const result = await checkpointedExport(runRoot, runState, snapshot);

  assert.equal(result.verification.status, 'failed');
  assert.equal(result.verification.runs, 1);
  assert.match(result.verification.reason, /time|invalid|oracle|failure/i);
  const standalone = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: path.join(runRoot, 'repro'),
    timeoutMs: 4_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.notEqual(standalone.exitCode, 0);
  assert.match(standalone.stderr, /not reproduced|time|invalid/i);
});

test('fresh verification checks manifest integrity again after enabled install scripts', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const pkg = JSON.parse(snapshot.get('package.json')!.content.toString()) as { scripts: Record<string, string> };
  pkg.scripts.preinstall = 'node mutate.mjs';
  snapshot.set('package.json', { content: Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), mode: 0o644 });
  snapshot.set('mutate.mjs', {
    content: Buffer.from("import { appendFileSync } from 'node:fs';appendFileSync('fail.mjs', '\\n// changed during install\\n')\n"),
    mode: 0o644,
  });
  const runState = state(sourceRoot, snapshot);
  runState.config.execution.allowInstallScripts = true;
  const result = await checkpointedExport(runRoot, runState, snapshot);

  assert.equal(result.verification.status, 'failed');
  assert.equal(result.verification.runs, 0);
  assert.match(result.verification.reason, /changed|manifest|checksum/i);
});

test('standalone verification cannot resolve an undeclared dependency from the export parent', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const ambient = path.join(base, 'node_modules', 'ambient-only');
  await mkdir(ambient, { recursive: true });
  await writeFile(path.join(ambient, 'package.json'), JSON.stringify({ name: 'ambient-only', version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(ambient, 'index.js'), 'module.exports = true\n');

  const failure = "import { createRequire } from 'node:module';try { createRequire(import.meta.url)('ambient-only');process.stderr.write('ReferenceError: targetMarker at fail.mjs:1\\n');process.exit(7) } catch { process.stderr.write('different failure: ambient module unavailable\\n');process.exit(7) }\n";
  const snapshot = project(failure);
  const exported = await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);
  assert.equal(exported.verification.status, 'failed');

  const exportRoot = path.join(runRoot, 'repro');
  const controlledTmp = path.join(base, 'standalone-tmp');
  await mkdir(controlledTmp);
  const standalone = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: exportRoot,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', TMPDIR: controlledTmp },
  });
  assert.notEqual(standalone.exitCode, 0, 'standalone verification must execute outside ancestor node_modules');
  assert.match(standalone.stderr, /ancestor node_modules/i);
  await assert.rejects(access(path.join(exportRoot, 'node_modules')));
});

test('standalone verification checks the physical ancestry of a symlinked TMPDIR', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const ambient = path.join(base, 'node_modules', 'ambient-only');
  await mkdir(ambient, { recursive: true });
  await writeFile(path.join(ambient, 'package.json'), JSON.stringify({ name: 'ambient-only', version: '1.0.0', main: 'index.js' }));
  await writeFile(path.join(ambient, 'index.js'), 'module.exports = true\n');

  const physicalTmp = path.join(base, 'physical-tmp');
  await mkdir(physicalTmp);
  const aliasParent = await mkdtemp(path.join(tmpdir(), 'repro-export-tmp-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const linkedTmp = path.join(aliasParent, 'linked-tmp');
  await symlink(physicalTmp, linkedTmp, 'dir');

  const failure = "import { createRequire } from 'node:module';try { createRequire(import.meta.url)('ambient-only');process.stderr.write('ReferenceError: targetMarker at fail.mjs:1\\n');process.exit(7) } catch { process.stderr.write('different failure: ambient module unavailable\\n');process.exit(7) }\n";
  const snapshot = project(failure);
  const exported = await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);
  assert.equal(exported.verification.status, 'failed');

  const standalone = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: path.join(runRoot, 'repro'),
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', TMPDIR: linkedTmp },
  });
  assert.notEqual(standalone.exitCode, 0, 'standalone verification must inspect the physical temporary-directory ancestry');
  assert.match(standalone.stderr, /ancestor node_modules/i);
});

test('standalone verification interrupts its target, returns 130, and removes temporary files', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const pidFile = path.join(base, 'standalone-target.pid');
  const temporaryRoot = path.join(base, 'signal-tmp');
  await mkdir(temporaryRoot);
  const keepaliveName = 'REPRO_SURGEON_TEST_KEEPALIVE';
  const pidPathName = 'REPRO_SURGEON_TEST_PID_PATH';
  const failure = `import fs from 'node:fs';if(process.env.${keepaliveName}){fs.writeFileSync(process.env.${pidPathName},String(process.pid));setInterval(()=>{},1000)}else{process.stderr.write('ReferenceError: targetMarker at fail.mjs:1\\n');process.exit(7)}\n`;
  const snapshot = project(failure);
  const runState = state(sourceRoot, snapshot);
  runState.config.execution.env = [keepaliveName, pidPathName];
  const exported = await checkpointedExport(runRoot, runState, snapshot);
  assert.equal(exported.verification.status, 'verified');

  let targetPid: number | undefined;
  const verifier = spawn(process.execPath, ['.repro/verify.mjs'], {
    cwd: path.join(runRoot, 'repro'),
    env: {
      ...process.env,
      TMPDIR: temporaryRoot,
      [keepaliveName]: '1',
      [pidPathName]: pidFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  verifier.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        targetPid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert(targetPid && Number.isInteger(targetPid), 'standalone target did not start');
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      verifier.once('exit', (code, signal) => resolve({ code, signal }));
    });
    verifier.kill('SIGINT');
    let exitTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      exitTimer = setTimeout(() => reject(new Error('standalone verifier did not exit after SIGINT')), 5_000);
    });
    const result = await Promise.race([exited, timeout]).finally(() => clearTimeout(exitTimer));
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 130, stderr);

    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(targetPid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; break; }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'standalone target survived verifier interruption');
    assert.deepEqual((await readdir(temporaryRoot)).filter((name) => name.startsWith('repro-verifier-')), []);
  } finally {
    if (verifier.exitCode === null && verifier.signalCode === null) verifier.kill('SIGKILL');
    if (targetPid !== undefined) {
      try { process.kill(-targetPid, 'SIGKILL'); } catch { /* The expected cleanup path already removed it. */ }
    }
  }
});

test('verification refuses a TMPDIR inside the export while allowing an ancestor temporary root', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const exported = await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);
  assert.equal(exported.verification.status, 'verified');
  const exportRoot = path.join(runRoot, 'repro');
  const manifestBefore = await readFile(path.join(exportRoot, '.repro', 'manifest.json'));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = exportRoot;
  try {
    const checked = await verifyReproduction(exportRoot);
    assert.equal(checked.status, 'failed');
    assert.match(checked.reason, /temporary|TMPDIR|inside|within|source/i);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }

  const contained = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: exportRoot,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', TMPDIR: exportRoot },
  });
  assert.notEqual(contained.exitCode, 0);
  assert.match(contained.stderr, /temporary|TMPDIR|inside|within|source/i);
  assert.deepEqual(await readFile(path.join(exportRoot, '.repro', 'manifest.json')), manifestBefore);
  assert.deepEqual((await readdir(exportRoot)).filter((name) => name.startsWith('repro-verifier-') || name.startsWith('repro-surgeon-')), []);

  const ancestorTemporary = await runCommand(['node', '.repro/verify.mjs'], {
    cwd: exportRoot,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', TMPDIR: base },
  });
  assert.equal(ancestorTemporary.exitCode, 0, ancestorTemporary.stderr);
});

test('fresh verification disposes every isolated temporary workspace', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const isolatedTmp = path.join(base, 'isolated-tmp');
  await mkdir(isolatedTmp);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  try {
    const snapshot = project();
    const result = await checkpointedExport(runRoot, state(sourceRoot, snapshot), snapshot);
    assert.equal(result.verification.status, 'verified');
    assert.deepEqual((await readdir(isolatedTmp)).filter((name) => name.startsWith('repro-surgeon-')), []);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});

test('export refuses overlapping source and unrelated or tampered existing destinations', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();

  await assert.rejects(exportReproduction(sourceRoot, state(sourceRoot, snapshot), snapshot), /overlap/i);

  const originalState = state(sourceRoot, snapshot);
  await saveCheckpoint(runRoot, originalState, snapshot);
  const exportRoot = path.join(runRoot, 'repro');
  await mkdir(exportRoot, { recursive: true });
  await writeFile(path.join(exportRoot, 'foreign.txt'), 'keep me');
  await assert.rejects(exportReproduction(runRoot, originalState, snapshot), /unrelated|owned|manifest|existing/i);
  assert.equal(await readFile(path.join(exportRoot, 'foreign.txt'), 'utf8'), 'keep me');

  await rm(exportRoot, { recursive: true, force: true });
  await exportReproduction(runRoot, originalState, snapshot);
  await writeFile(path.join(exportRoot, 'fail.mjs'), 'tampered');
  await assert.rejects(exportReproduction(runRoot, originalState, snapshot), /changed|checksum|manifest|tamper/i);
});

test('a reloaded same-run checkpoint can replace its validated tool-owned export', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const runState = state(sourceRoot, snapshot);
  const first = await checkpointedExport(runRoot, runState, snapshot);
  assert.equal(first.verification.status, 'verified');
  const resumed = await loadCheckpoint(runRoot);
  const second = await exportReproduction(runRoot, resumed.state, resumed.snapshot);
  assert.equal(second.verification.status, 'verified');
  assert.equal(second.verification.runs, 3);
});

test('export refuses to run while another process owns the run lock', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const runState = state(sourceRoot, snapshot);
  await saveCheckpoint(runRoot, runState, snapshot);
  const release = await acquireRunLock(runRoot);
  try {
    await assert.rejects(exportReproduction(runRoot, runState, snapshot), /active|locked/i);
  } finally {
    await release();
  }
  await assert.rejects(access(path.join(runRoot, 'repro')));
});

test('export rejects a stale caller after the accepted checkpoint advances', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const suppliedSnapshot = project();
  const suppliedState = state(sourceRoot, suppliedSnapshot);
  await saveCheckpoint(runRoot, suppliedState, suppliedSnapshot);

  const currentSnapshot = new Map(suppliedSnapshot);
  currentSnapshot.set('newly-accepted.txt', { content: Buffer.from('new accepted source\n'), mode: 0o644 });
  const currentState = structuredClone(suppliedState);
  currentState.bestHash = snapshotHash(currentSnapshot);
  currentState.current = { ...currentState.current, files: currentSnapshot.size };
  currentState.updatedAt = new Date(Date.now() + 1_000).toISOString();
  await saveCheckpoint(runRoot, currentState, currentSnapshot);

  await assert.rejects(exportReproduction(runRoot, suppliedState, suppliedSnapshot), /stale|checkpoint|accepted/i);
  const persisted = await loadCheckpoint(runRoot);
  assert.equal(persisted.state.bestHash, currentState.bestHash);
  assert.equal(snapshotHash(persisted.snapshot), currentState.bestHash);
  await assert.rejects(access(path.join(runRoot, 'repro')));
});

test('export releases the run lock after aborted verification', async (t) => {
  const { sourceRoot, runRoot } = await fixture(t);
  const snapshot = project();
  const runState = state(sourceRoot, snapshot);
  await saveCheckpoint(runRoot, runState, snapshot);
  const controller = new AbortController();
  controller.abort();

  const result = await exportReproduction(runRoot, runState, snapshot, { signal: controller.signal });
  assert.equal(result.verification.status, 'failed');
  assert.match(result.verification.reason, /abort/i);
  const release = await acquireRunLock(runRoot);
  await release();
});

test('export refuses a source-contained TMPDIR before staging or launching the target', async (t) => {
  const { base, sourceRoot, runRoot } = await fixture(t);
  const marker = path.join(base, 'target-launched');
  const markerName = 'REPRO_SURGEON_EXPORT_LAUNCH_MARKER';
  const failure = `import fs from 'node:fs';if(process.env.${markerName})fs.writeFileSync(process.env.${markerName},'launched');process.stderr.write('ReferenceError: targetMarker at fail.mjs:1\\n');process.exit(7)\n`;
  const snapshot = project(failure);
  const runState = state(sourceRoot, snapshot);
  runState.config.execution.env = [markerName];
  await saveCheckpoint(runRoot, runState, snapshot);
  const sourceTemporary = path.join(sourceRoot, 'tmp');
  await mkdir(sourceTemporary);
  const previousTmp = process.env.TMPDIR;
  const previousMarker = process.env[markerName];
  process.env.TMPDIR = sourceTemporary;
  process.env[markerName] = marker;
  try {
    await assert.rejects(exportReproduction(runRoot, runState, snapshot), /temporary|TMPDIR|inside.*source/i);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    if (previousMarker === undefined) delete process.env[markerName];
    else process.env[markerName] = previousMarker;
  }

  await assert.rejects(access(marker));
  await assert.rejects(access(path.join(runRoot, 'repro')));
  assert.deepEqual((await readdir(sourceTemporary)).filter((name) => name.startsWith('repro-')), []);
  const persisted = await loadCheckpoint(runRoot);
  assert.equal(persisted.state.status, 'verifying');
  assert.equal(persisted.state.bestHash, runState.bestHash);
  const release = await acquireRunLock(runRoot);
  await release();
});
