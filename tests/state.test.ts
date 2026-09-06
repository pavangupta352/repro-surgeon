import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { saveCheckpoint, loadCheckpoint, acquireRunLock, assertCompatibleRuntime } from '../src/state.ts';
import { snapshotHash } from '../src/snapshot.ts';
import type { RunState, Snapshot, RuntimeInfo } from '../src/types.ts';

test('checkpoint roundtrips exact bytes and rejects modified state or snapshot blobs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot: Snapshot = new Map([['file.js', { content: Buffer.from([1, 2, 3]), mode: 0o755 }]]);
  const state = { version: 1, id: 'test', bestHash: snapshotHash(snapshot) } as RunState;
  await saveCheckpoint(root, state, snapshot);
  const loaded = await loadCheckpoint(root);
  assert.equal(snapshotHash(loaded.snapshot), snapshotHash(snapshot));
  assert.equal(loaded.state.id, 'test');
  const statePath = path.join(root, 'state.json');
  const text = await readFile(statePath, 'utf8');
  await writeFile(statePath, text.replace('test', 'tampered'));
  await assert.rejects(loadCheckpoint(root), /checksum|corrupt/i);
  await writeFile(statePath, text);
  const manifest = JSON.parse(await readFile(path.join(root, 'snapshots', state.bestHash + '.json'), 'utf8'));
  await writeFile(path.join(root, 'blobs', manifest[0].blob), 'not the same source');
  await assert.rejects(loadCheckpoint(root), /checksum|corrupt/i);
});

test('checkpoint refuses to commit a snapshot that differs from the accepted hash', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(saveCheckpoint(root, { bestHash: 'incorrect' } as RunState, new Map()), /hash|accepted/i);
});

test('run lock prevents concurrent writers and releases for the next run', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireRunLock(root);
  await assert.rejects(acquireRunLock(root), /active|locked/i);
  await release();
  const next = await acquireRunLock(root);
  await next();
});

test('stale-lock contenders both refuse recovery without changing the lock', { timeout: 5_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const formerOwner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(formerOwner, 'exit');
  const lockPath = path.join(root, 'run.lock');
  const staleBytes = JSON.stringify({ pid: formerOwner.pid, nonce: 'original-stale-lock' });
  await writeFile(lockPath, staleBytes);
  const source = `
    import { readFile } from 'node:fs/promises';
    import { acquireRunLock } from ${JSON.stringify(new URL('../src/state.ts', import.meta.url).href)};
    const observed = await readFile(${JSON.stringify(lockPath)}, 'utf8');
    process.once('message', async () => {
      try {
        const release = await acquireRunLock(${JSON.stringify(root)});
        process.send({ acquired: true }, () => { void release().then(() => process.disconnect()); });
      } catch (error) {
        process.send({ acquired: false, error: error.message }, () => process.disconnect());
      }
    });
    process.send({ ready: true, observed });
  `;
  const contenders = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => { for (const child of contenders) child.kill('SIGKILL'); });
  const ready = await Promise.all(contenders.map(child => once(child, 'message')));
  for (const [message] of ready) assert.deepEqual(message, { ready: true, observed: staleBytes });
  const outcomes = contenders.map(child => once(child, 'message'));
  const exits = contenders.map(child => once(child, 'exit'));
  for (const child of contenders) child.send('acquire');
  const results = await Promise.all(outcomes);
  await Promise.all(exits);
  assert.deepEqual(results.map(([result]) => result.acquired), [false, false]);
  for (const [result] of results) {
    assert.match(result.error, /stale/i);
    assert.match(result.error, /stop.*(?:process|run)|(?:process|run).*stop/i);
    assert.match(result.error, /manually.*remove|remove.*manually/i);
    assert(result.error.includes(lockPath));
  }
  assert.equal(await readFile(lockPath, 'utf8'), staleBytes);
  await rm(lockPath);
  const release = await acquireRunLock(root);
  const ownerBytes = await readFile(lockPath, 'utf8');
  await assert.rejects(acquireRunLock(root), /active|locked/i);
  assert.equal(await readFile(lockPath, 'utf8'), ownerBytes);
  await release();
});

test('a release cannot remove a lock with a different owner nonce', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-replaced-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireRunLock(root);
  const replacement = JSON.stringify({ pid: process.pid, nonce: 'replacement-owner' });
  await writeFile(path.join(root, 'run.lock'), replacement);
  await release();
  assert.equal(await readFile(path.join(root, 'run.lock'), 'utf8'), replacement);
});

test('resume refuses different runtime and tool versions', () => {
  const before: RuntimeInfo = { node: 'v24.7.0', npm: '11.5.1', platform: 'darwin', arch: 'arm64', tool: '0.1.0' };
  assert.doesNotThrow(() => assertCompatibleRuntime(before, { ...before }));
  for (const field of ['node', 'npm', 'arch', 'platform', 'tool'] as const) assert.throws(() => assertCompatibleRuntime(before, { ...before, [field]: 'changed' }), /runtime|version|environment/i);
});
