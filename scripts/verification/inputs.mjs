import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { computeFingerprint } from 'stalegreen';

const POLICY = 'repro-development-inputs-v1';
const ROOT_EXCLUDES = new Set(['.git', '.local', 'dist', 'coverage', 'output', '.repro-surgeon', '.superpowers', '.impeccable']);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function excluded(path) {
  const parts = path.split('/');
  return ROOT_EXCLUDES.has(parts[0]) || parts.includes('node_modules') || parts.at(-1) === '.DS_Store'
    || (parts.length === 1 && (path === 'AGENTS.md' || path.endsWith('.tgz')));
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Capture checkout inputs, independently reading bytes that Git may ignore or cache. */
export async function captureInputs(cwd, options = {}) {
  const started = performance.now();
  const budgetMs = options.budgetMs ?? 5_000;
  const maxFiles = options.maxFiles ?? 10_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let root = typeof cwd === 'string' ? resolve(cwd) : '';
  let head = null;
  let stalegreen = { head: null, tree: null, available: false, reason: 'not-captured' };
  const unavailable = (reason) => ({ policy: POLICY, root, head, available: false, tree: null, stalegreen, reason });
  const left = () => budgetMs - (performance.now() - started);
  const checkBudget = () => {
    if (left() <= 0) throw new Error('input capture budget exhausted');
  };
  const git = (args) => {
    checkBudget();
    const result = spawnSync('git', args, {
      cwd: root, encoding: 'utf8', timeout: Math.max(1, Math.ceil(left())),
      maxBuffer: Math.min(64 * 1024 * 1024, Math.max(65_536, maxFiles * 1_024)),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true,
    });
    checkBudget();
    if (result.error || result.status !== 0) throw new Error(`git ${args[0]} unavailable${result.error?.code ? ` (${result.error.code})` : ''}`);
    return result.stdout;
  };
  const inspectIndex = () => {
    for (const entry of git(['ls-files', '--stage', '-z']).split('\0')) {
      if (!entry) continue;
      const match = /^(\d{6}) ([a-f0-9]+) (\d)\t/.exec(entry);
      if (!match) throw new Error('Git index could not be parsed');
      if (match[3] !== '0') throw new Error('unresolved Git index entries');
      if (match[1] === '160000') throw new Error('submodules are not supported by input capture');
    }
  };

  try {
    if (typeof cwd !== 'string' || !cwd || !Number.isFinite(budgetMs) || budgetMs <= 0
      || !Number.isSafeInteger(maxFiles) || maxFiles <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return unavailable('invalid or exhausted input capture limits');
    }
    root = await realpath(root);
    checkBudget();
    const top = await realpath(git(['rev-parse', '--show-toplevel']).trim());
    if (root !== top) return unavailable('input capture requires the Git repository root');
    head = git(['rev-parse', '--verify', 'HEAD']).trim();
    if (!COMMIT.test(head)) return unavailable('full Git HEAD is unavailable');
    inspectIndex();

    const entries = [];
    const observed = [];
    const ignore = [...ROOT_EXCLUDES].flatMap((path) => [`./${path}`, `${path}/**`]);
    ignore.push('./AGENTS.md', './*.tgz', '.DS_Store');
    let count = 0;
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);

    const walk = async (path, relative) => {
      checkBudget();
      const before = await lstat(path, { bigint: true });
      checkBudget();
      if (before.isSymbolicLink()) throw new Error(`symlink input is unsupported: ${relative}`);
      if (!before.isFile() && !before.isDirectory()) throw new Error(`special input file is unsupported: ${relative}`);
      observed.push({ path, stat: before });
      if (before.isDirectory()) {
        const directory = await opendir(path);
        for await (const entry of directory) {
          checkBudget();
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (excluded(child)) {
            if (entry.name === 'node_modules') ignore.push(`./${child}`, `${child}/**`);
            continue;
          }
          if (++count > maxFiles) throw new Error('input file limit exceeded');
          await walk(join(path, entry.name), child);
        }
      } else {
        if (before.size > BigInt(maxBytes - bytes)) throw new Error('input byte limit exceeded');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!sameStat(before, await handle.stat({ bigint: true }))) throw new Error(`input changed before reading: ${relative}`);
          const digest = createHash('sha256');
          let read = 0;
          while (true) {
            checkBudget();
            const result = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
            checkBudget();
            if (result.bytesRead === 0) break;
            read += result.bytesRead;
            bytes += result.bytesRead;
            if (bytes > maxBytes) throw new Error('input byte limit exceeded');
            digest.update(buffer.subarray(0, result.bytesRead));
          }
          if (BigInt(read) !== before.size || !sameStat(before, await handle.stat({ bigint: true }))) throw new Error(`input changed while reading: ${relative}`);
          entries.push([relative, (before.mode & 0o7777n).toString(8), read, digest.digest('hex')]);
        } finally {
          await handle.close();
        }
      }
      checkBudget();
      if (!sameStat(before, await lstat(path, { bigint: true }))) throw new Error(`input changed during capture: ${relative || '.'}`);
    };
    await walk(root, '');
    checkBudget();
    stalegreen = computeFingerprint(root, {
      ignore, budgetMs: Math.max(1, Math.floor(left())), maxRehashFiles: maxFiles, maxRehashBytes: maxBytes,
    });
    checkBudget();
    if (!stalegreen.available || !SHA256.test(stalegreen.tree ?? '')) return unavailable(`stalegreen fingerprint unavailable: ${stalegreen.reason ?? 'unknown'}`);
    inspectIndex();
    head = git(['rev-parse', '--verify', 'HEAD']).trim();
    if (!COMMIT.test(head)) return unavailable('full Git HEAD is unavailable');
    for (const item of observed) {
      checkBudget();
      if (!sameStat(item.stat, await lstat(item.path, { bigint: true }))) throw new Error('input changed before capture completed');
    }
    checkBudget();
    const hash = createHash('sha256');
    entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`);
    checkBudget();
    return { policy: POLICY, root, head, available: true, tree: hash.digest('hex'), stalegreen };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message.slice(0, 240) : 'input capture unavailable');
  }
}

/** Unknown evidence or a different checkout/policy cannot establish freshness. */
export function compareInputs(a, b) {
  const valid = (value) => value?.policy === POLICY && typeof value.root === 'string' && value.root.length > 0
    && value.available === true && typeof value.head === 'string' && COMMIT.test(value.head)
    && typeof value.tree === 'string' && SHA256.test(value.tree) && value.stalegreen?.available === true
    && typeof value.stalegreen.tree === 'string' && SHA256.test(value.stalegreen.tree);
  if (!valid(a) || !valid(b) || a.root !== b.root) return 'unknown';
  return a.tree === b.tree && a.stalegreen.tree === b.stalegreen.tree ? 'same' : 'different';
}
