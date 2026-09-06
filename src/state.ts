import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { hashValue, safeRelativePath, snapshotHash } from './snapshot.ts';
import type { RunState, RuntimeInfo, Snapshot } from './types.ts';

export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function saveCheckpoint(root: string, state: RunState, snapshot: Snapshot): Promise<void> {
  if (snapshotHash(snapshot) !== state.bestHash) throw new Error('Checkpoint snapshot hash differs from the accepted state.');
  await mkdir(path.join(root, 'blobs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'snapshots'), { recursive: true, mode: 0o700 });
  const manifest: { path: string; mode: number; blob: string }[] = [];
  for (const [name, file] of [...snapshot].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    safeRelativePath(name);
    const blob = createHash('sha256').update(file.content).digest('hex');
    const blobPath = path.join(root, 'blobs', blob);
    try {
      const handle = await open(blobPath, 'wx', 0o600);
      try { await handle.writeFile(file.content); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(blobPath);
      if (createHash('sha256').update(existing).digest('hex') !== blob) throw new Error('Corrupt source blob in checkpoint.');
    }
    manifest.push({ path: name, mode: file.mode, blob });
  }
  await atomicWrite(path.join(root, 'snapshots', state.bestHash + '.json'), JSON.stringify(manifest));
  await atomicWrite(path.join(root, 'state.json'), JSON.stringify({ checksum: hashValue(state), state }, null, 2) + '\n');
}

export async function loadCheckpoint(root: string): Promise<{ state: RunState; snapshot: Snapshot }> {
  let envelope: { checksum: string; state: RunState };
  try { envelope = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')) as typeof envelope; }
  catch { throw new Error('Could not read the checkpoint. It is missing or corrupt.'); }
  if (!envelope.state || envelope.state.version !== 1 || hashValue(envelope.state) !== envelope.checksum || !/^[a-f0-9]{64}$/.test(envelope.state.bestHash)) throw new Error('Checkpoint checksum is corrupt or its version is unsupported.');
  const { state } = envelope;
  const manifest: unknown = JSON.parse(await readFile(path.join(root, 'snapshots', state.bestHash + '.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('Corrupt snapshot manifest.');
  const snapshot: Snapshot = new Map();
  for (const row of manifest) {
    if (!row || typeof row.path !== 'string' || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777 || typeof row.blob !== 'string' || !/^[a-f0-9]{64}$/.test(row.blob)) throw new Error('Corrupt snapshot entry.');
    safeRelativePath(row.path);
    if (snapshot.has(row.path)) throw new Error('Corrupt snapshot has duplicate files.');
    const content = await readFile(path.join(root, 'blobs', row.blob));
    if (createHash('sha256').update(content).digest('hex') !== row.blob) throw new Error('Source blob checksum is corrupt.');
    snapshot.set(row.path, { content, mode: row.mode });
  }
  if (snapshotHash(snapshot) !== state.bestHash) throw new Error('Snapshot checksum is corrupt.');
  return { state, snapshot };
}

export async function acquireRunLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.resolve(root, 'run.lock');
  const nonce = randomUUID();
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await handle.close(); }
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as { nonce: string };
        if (current.nonce === nonce) await rm(lockPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = `Stop all processes using this run directory and confirm it has no active owner, then manually remove ${JSON.stringify(lockPath)} and retry.`;
    let stale = false;
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('invalid lock');
      try { process.kill(lock.pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = true; }
    } catch { throw new Error(`Run is locked and its owner cannot be verified. ${recovery}`); }
    if (!stale) throw new Error('This run has an active process and is locked. Wait for it to finish.');
    // A stale pathname can be replaced by another contender after any read.
    // Refusing recovery avoids unlinking a newly acquired live lock.
    throw new Error(`This run has a stale lock. Automatic recovery is disabled. ${recovery}`);
  }
}

export function assertCompatibleRuntime(recorded: RuntimeInfo, current: RuntimeInfo): void {
  for (const field of ['node', 'npm', 'platform', 'arch', 'tool'] as const) {
    if (recorded[field] !== current[field]) throw new Error(`Runtime environment changed (${field}: ${recorded[field]} to ${current[field]}). Start a new run with this environment.`);
  }
}
