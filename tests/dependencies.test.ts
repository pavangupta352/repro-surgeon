import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateNpmProject, dependencyCandidates, assertLockIntegrity, createIsolatedDirectory, WorkspaceManager } from '../src/dependencies.ts';
import { applyTransformation, snapshotHash } from '../src/snapshot.ts';
import { runCommand } from '../src/runner.ts';
import type { Config, Snapshot } from '../src/types.ts';

function project(pkg: object = { name: 'case', version: '1.0.0' }, lock: object = { name: 'case', lockfileVersion: 3, packages: { '': { name: 'case', version: '1.0.0' } } }): Snapshot {
  return new Map([['package.json', { content: Buffer.from(JSON.stringify(pkg)), mode: 0o644 }], ['package-lock.json', { content: Buffer.from(JSON.stringify(lock)), mode: 0o644 }]]);
}

test('npm validation rejects unpinned, workspace and local dependencies before executing anything', () => {
  assert.doesNotThrow(() => validateNpmProject(project()));
  assert.throws(() => validateNpmProject(new Map([['package.json', { content: Buffer.from('{}'), mode: 0o644 }]])), /lockfile|package-lock/i);
  for (const value of ['file:../private', 'workspace:*', 'link:../pkg', 'git+https://example.com/a.git']) {
    assert.throws(() => validateNpmProject(project({ dependencies: { private: value } })), /portable|local|workspace|git/i);
  }
  assert.throws(() => validateNpmProject(project({ workspaces: ['packages/*'] })), /workspace/i);
});

test('dependency candidates remove only named direct declarations and retain unrelated metadata', () => {
  const source = project({ name: 'case', scripts: { build: 'node check.js' }, dependencies: { a: '1', b: '2' }, devDependencies: { a: '1' } });
  const candidates = dependencyCandidates(source, { preserve: [] } as unknown as Config);
  assert.equal(candidates.length, 2);
  const a = candidates.find(x => x.description.includes('a'))!;
  const pkg = JSON.parse(a.edits[0]!.content!.toString());
  assert(!pkg.dependencies.a);
  assert(!pkg.devDependencies.a);
  assert.equal(pkg.dependencies.b, '2');
  assert.equal(pkg.scripts.build, 'node check.js');
});

test('shrinkwrap is refused before either preparation or reconciliation can select a different lock', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-shrinkwrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = project();
  source.set('npm-shrinkwrap.json', { content: Buffer.from('invalid shrinkwrap'), mode: 0o644 });
  const config = { execution: { timeoutMs: 10000, maxOutputBytes: 1048576, installTimeoutMs: 20000, allowInstallScripts: false, env: [] } } as unknown as Config;
  const manager = new WorkspaceManager(root, config);
  t.after(() => manager.dispose());
  assert.throws(() => validateNpmProject(source), /shrinkwrap.*unsupported|unsupported.*shrinkwrap/i);
  await assert.rejects(manager.prepare(source), /shrinkwrap/i);
  await assert.rejects(manager.reconcile(source, project()), /shrinkwrap/i);
});

test('pinning either dependency metadata file suppresses proposals and preserves its exact bytes', () => {
  const source = project({ name: 'case', dependencies: { a: '1.0.0' } });
  const before = snapshotHash(source);
  for (const preserve of [['package.json'], ['package-lock.json'], ['package*.json'], ['**/package-lock.json']]) {
    assert.deepEqual(dependencyCandidates(source, { preserve }), [], preserve.join(', '));
    assert.equal(snapshotHash(source), before);
  }
});

test('execution cannot resolve an undeclared package from state ancestors, including after dependency removal', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-ambient-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const name = 'surgeon-ambient-sentinel';
  await mkdir(path.join(base, 'node_modules', name), { recursive: true });
  await writeFile(path.join(base, 'node_modules', name, 'index.js'), 'module.exports = "ambient";');
  const config = { execution: { timeoutMs: 10000, maxOutputBytes: 1048576, installTimeoutMs: 20000, allowInstallScripts: false, env: [] } } as unknown as Config;
  const manager = new WorkspaceManager(path.join(base, 'run'), config);
  t.after(() => manager.dispose());
  const source = project();
  source.set('check.cjs', { content: Buffer.from(`try { require('${name}'); process.exit(9); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; console.log('ISOLATED'); }`), mode: 0o644 });
  const original = new Map(source);
  original.set('package.json', { content: Buffer.from(JSON.stringify({ name: 'case', version: '1.0.0', dependencies: { [name]: '1.0.0' } })), mode: 0o644 });
  const removal = applyTransformation(original, dependencyCandidates(original, { preserve: [] })[0]!);
  for (const snapshot of [source, removal]) {
    const candidate = await manager.reconcile(snapshot, original);
    const cwd = await manager.prepare(candidate);
    const result = await runCommand([process.execPath, 'check.cjs'], { cwd, timeoutMs: 10000, maxOutputBytes: 1024, env: await manager.environment() });
    assert.equal(result.exitCode, 0, result.stderr || 'Resolved the undeclared ancestor package');
    assert.match(result.stdout, /ISOLATED/);
  }
});

test('a temporary directory inside an ancestor dependency tree is refused and cleaned', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-unsafe-temp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'node_modules'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = base;
  try { await assert.rejects(createIsolatedDirectory(), /ancestor.*node_modules.*TMPDIR/); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  assert.deepEqual(await readdir(base), ['node_modules']);
});

test('lock reconciliation cannot silently upgrade retained dependencies', () => {
  const before = { packages: { '': {}, 'node_modules/a': { version: '1', integrity: 'same', resolved: 'https://registry.npmjs.org/a.tgz' } } };
  assert.doesNotThrow(() => assertLockIntegrity(before, before));
  assert.throws(() => assertLockIntegrity(before, { packages: { '': {}, 'node_modules/a': { version: '2', integrity: 'changed' } } }), /changed|drift|version/i);
  assert.throws(() => assertLockIntegrity(before, { packages: { '': {}, 'node_modules/new': { version: '1' } } }), /new|changed|drift/i);
});

test('each prepared command starts with fresh source and a tool-owned dependency tree', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { execution: { timeoutMs: 10000, maxOutputBytes: 1048576, installTimeoutMs: 20000, allowInstallScripts: false, env: [] } } as unknown as Config;
  const manager = new WorkspaceManager(root, config);
  t.after(() => manager.dispose());
  const source = project();
  source.set('index.js', { content: Buffer.from('original'), mode: 0o644 });
  let cwd = await manager.prepare(source);
  await writeFile(path.join(cwd, 'index.js'), 'dirty');
  await writeFile(path.join(cwd, 'generated.txt'), 'stale build');
  cwd = await manager.prepare(source);
  assert.equal(await readFile(path.join(cwd, 'index.js'), 'utf8'), 'original');
  await assert.rejects(readFile(path.join(cwd, 'generated.txt')), /ENOENT/);
  await manager.dispose();
  await assert.rejects(readFile(path.join(cwd, 'index.js')), /ENOENT/);
  await assert.rejects(manager.prepare(source), /disposed/);
});
