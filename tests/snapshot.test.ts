import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inventoryProject, writeSnapshot, snapshotHash, metrics, applyTransformation, assertDisjointPaths, scanForReview } from '../src/snapshot.ts';
import type { Config, Snapshot } from '../src/types.ts';

const options = { include: [], exclude: [], preserve: [] } as unknown as Config;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), '{"name":"case","dependencies":{"a":"1"}}');
  return root;
}

test('inventory includes untracked source and honors nested ignores without copying generated or credential files', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, '.gitignore'), '*.log\n');
  await writeFile(path.join(root, 'src/.gitignore'), 'private.txt\n');
  for (const name of ['src/index.ts', 'src/private.txt', 'debug.log', '.env.local', '.npmrc', 'node_modules/secret.js']) {
    await writeFile(path.join(root, name), 'content');
  }
  const result = await inventoryProject(root, options);
  assert(result.snapshot.has('src/index.ts'));
  for (const name of ['src/private.txt', 'debug.log', '.env.local', '.npmrc', 'node_modules/secret.js']) assert(!result.snapshot.has(name), name);
  assert(result.excluded.some(x => x.path === '.env.local'));
  const withInclude = await inventoryProject(root, { ...options, include: ['src/private.txt', '.env.local'] });
  assert(withInclude.snapshot.has('src/private.txt'));
  assert(!withInclude.snapshot.has('.env.local'));
});

test('nested ignore rules apply after parent rules while unmatched rules preserve earlier decisions', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'nested/deeper'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '*.txt\n!keep.txt\n');
  await writeFile(path.join(root, 'nested/.gitignore'), '!restore.txt\nkeep.txt\n');
  await writeFile(path.join(root, 'nested/deeper/.gitignore'), '!keep.txt\nunrelated.js\n');
  for (const name of ['nested/restore.txt', 'nested/keep.txt', 'nested/other.txt', 'nested/deeper/restore.txt', 'nested/deeper/keep.txt', 'nested/deeper/other.txt']) {
    await writeFile(path.join(root, name), name);
  }
  const { snapshot } = await inventoryProject(root, options);
  for (const name of ['nested/restore.txt', 'nested/deeper/restore.txt', 'nested/deeper/keep.txt']) assert(snapshot.has(name), name);
  for (const name of ['nested/keep.txt', 'nested/other.txt', 'nested/deeper/other.txt']) assert(!snapshot.has(name), name);
});

test('ignored parents remain closed and explicitly reopened directories honor nested negation', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'closed'), { recursive: true });
  await mkdir(path.join(root, 'nested/cache/open'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'closed/\ncache/\n*.txt\n');
  await writeFile(path.join(root, 'closed/.gitignore'), '!keep.txt\n');
  await writeFile(path.join(root, 'nested/.gitignore'), '!cache/\n');
  await writeFile(path.join(root, 'nested/cache/.gitignore'), '!keep.txt\n');
  for (const name of ['closed/keep.txt', 'closed/selected.txt', 'nested/cache/keep.txt', 'nested/cache/open/keep.txt', 'nested/cache/other.txt']) {
    await writeFile(path.join(root, name), name);
  }
  const { snapshot } = await inventoryProject(root, options);
  assert(!snapshot.has('closed/keep.txt'));
  assert(snapshot.has('nested/cache/keep.txt'));
  assert(snapshot.has('nested/cache/open/keep.txt'));
  assert(!snapshot.has('nested/cache/other.txt'));
  const included = await inventoryProject(root, { ...options, include: ['closed/selected.txt'] });
  assert(included.snapshot.has('closed/selected.txt'));
  assert(!included.snapshot.has('closed/keep.txt'));
});

test('nested ignore scoping preserves anchored, recursive, escaped and directory-only patterns', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'scope[1]/deeper/folder'), { recursive: true });
  await mkdir(path.join(root, 'scope1'), { recursive: true });
  await writeFile(path.join(root, 'scope[1]/.gitignore'), '/top.txt\nany.txt\nfolder/\n\\#literal\n\\!literal\nname\\ \n');
  for (const name of ['scope[1]/top.txt', 'scope[1]/deeper/top.txt', 'scope[1]/deeper/any.txt', 'scope[1]/deeper/folder/file.js', 'scope[1]/#literal', 'scope[1]/!literal', 'scope[1]/name ', 'scope1/top.txt']) {
    await writeFile(path.join(root, name), name);
  }
  const { snapshot } = await inventoryProject(root, options);
  for (const name of ['scope[1]/deeper/top.txt', 'scope1/top.txt']) assert(snapshot.has(name), name);
  for (const name of ['scope[1]/top.txt', 'scope[1]/deeper/any.txt', 'scope[1]/deeper/folder/file.js', 'scope[1]/#literal', 'scope[1]/!literal', 'scope[1]/name ']) assert(!snapshot.has(name), name);
});

test('symlink targets are never read and materialization refuses a destination symlink', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'surgeon-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret'), 'do not copy');
  await symlink(outside, path.join(root, 'escape'));
  const inventory = await inventoryProject(root, options);
  assert(!inventory.snapshot.has('escape/secret'));
  assert(inventory.excluded.some(x => x.path === 'escape' && /link/i.test(x.reason)));
  await assert.rejects(writeSnapshot(new Map([['escape/secret', { content: Buffer.from('overwritten'), mode: 0o644 }]]), root), /symbolic|symlink/i);
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'do not copy');
});

test('snapshot roundtrip preserves binary bytes and executable modes and hashes ignore insertion order', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'run'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(root, 'run'), 0o755);
  await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 255, 45, 13]));
  const { snapshot } = await inventoryProject(root, options);
  const destination = await mkdtemp(path.join(tmpdir(), 'surgeon-copy-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await writeSnapshot(snapshot, destination);
  const copy = (await inventoryProject(destination, options)).snapshot;
  assert.equal(snapshotHash(copy), snapshotHash(snapshot));
  assert.equal(snapshotHash(new Map([...snapshot].reverse())), snapshotHash(snapshot));
  assert.equal((await stat(path.join(destination, 'run'))).mode & 0o777, 0o755);
  assert.deepEqual(await readFile(path.join(destination, 'data.bin')), Buffer.from([0, 255, 45, 13]));
});

test('path traversal and overlapping source/output directories are refused including symlink parents', async t => {
  const root = await fixture(t);
  await assert.rejects(writeSnapshot(new Map([['../escape', { content: Buffer.from('x'), mode: 0o644 }]]), root), /unsafe|relative|path/i);
  await assert.rejects(assertDisjointPaths(root, path.join(root, 'run')), /overlap|inside/i);
  await assert.rejects(assertDisjointPaths(root, path.dirname(root)), /overlap|inside/i);
  const outside = await mkdtemp(path.join(tmpdir(), 'surgeon-links-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(root, path.join(outside, 'alias'));
  await assert.rejects(assertDisjointPaths(root, path.join(outside, 'alias/new-output')), /overlap|inside/i);
});

test('transformation application is immutable and metrics separate dependency lock bytes from source', () => {
  const snapshot: Snapshot = new Map([
    ['a.js', { content: Buffer.from('hello'), mode: 0o644 }],
    ['package-lock.json', { content: Buffer.from('{}'), mode: 0o644 }],
  ]);
  const next = applyTransformation(snapshot, { id: 'remove-a', kind: 'files', description: 'remove a', paths: ['a.js'], edits: [{ path: 'a.js', content: null }] });
  assert(snapshot.has('a.js'));
  assert(!next.has('a.js'));
  assert.deepEqual(metrics(snapshot), { files: 2, bytes: 7, sourceBytes: 5, dependencies: 0 });
});

test('review findings identify retained credential shapes and local paths without returning secret values', () => {
  const value = 'ghp_' + 'a'.repeat(36);
  const snapshot: Snapshot = new Map([['settings.js', { content: Buffer.from(`const token="${value}"; const p="/Users/someone/private";`), mode: 0o644 }]]);
  const findings = scanForReview(snapshot);
  assert(findings.some(x => x.kind === 'secret'));
  assert(findings.some(x => x.kind === 'local-path'));
  assert(!JSON.stringify(findings).includes(value));
});
