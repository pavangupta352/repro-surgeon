import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanEnvironment, runCommand } from './runner.ts';
import { hashValue, matchesPath, writeSnapshot } from './snapshot.ts';
import type { Config, RuntimeInfo, Snapshot, Transformation } from './types.ts';

type PackageJson = Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
type NpmLock = { lockfileVersion?: number; packages?: Record<string, Record<string, unknown>> };
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function validateNpmProject(snapshot: Snapshot): { pkg: PackageJson; lock: NpmLock } {
  if (snapshot.has('npm-shrinkwrap.json')) throw new Error('npm-shrinkwrap.json is unsupported. Use a standalone project whose authoritative npm lockfile is package-lock.json.');
  const manifest = snapshot.get('package.json');
  const lockfile = snapshot.get('package-lock.json');
  if (!manifest || !lockfile) throw new Error('A package.json and package-lock.json are required. Create an npm lockfile before reducing.');
  let pkg: PackageJson;
  let lock: NpmLock;
  try { pkg = JSON.parse(manifest.content.toString()) as PackageJson; lock = JSON.parse(lockfile.content.toString()) as NpmLock; }
  catch { throw new Error('package.json or package-lock.json is not valid JSON.'); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || !lock || typeof lock !== 'object') throw new Error('Invalid npm package metadata.');
  if (pkg.workspaces) throw new Error('npm workspaces are not supported yet. Select a standalone package with portable dependencies.');
  if (typeof pkg.packageManager === 'string' && !pkg.packageManager.startsWith('npm@')) throw new Error('This project declares a different package manager. The current adapter requires an npm package and lockfile.');
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || !lock.packages || !lock.packages['']) throw new Error('Use an npm lockfile version 2 or 3 with a root package entry.');
  for (const section of sections) {
    const entries = pkg[section];
    if (entries !== undefined && (!entries || typeof entries !== 'object' || Array.isArray(entries))) throw new Error(`Invalid ${section} in package.json.`);
    for (const [name, version] of Object.entries(entries ?? {})) {
      if (typeof version !== 'string' || /^(?:file:|link:|workspace:|git[+:]|github:|https?:|\.\.?\/|\/)/.test(version) || /^[^@\s]+\/[^\s]+$/.test(version)) throw new Error(`Dependency ${name} is not a portable registry dependency. Local, workspace, Git and direct URL dependencies are unsupported.`);
    }
  }
  for (const [name, record] of Object.entries(lock.packages)) {
    if (name === '') continue;
    if (record.link === true) throw new Error(`Lockfile contains a local/workspace link: ${name}`);
    if (typeof record.resolved === 'string') {
      let url: URL;
      try { url = new URL(record.resolved); } catch { throw new Error(`Lockfile has a non-portable package location: ${name}`); }
      if (url.protocol !== 'https:' || url.username || url.password || !['registry.npmjs.org', 'registry.yarnpkg.com'].includes(url.hostname)) throw new Error(`Lockfile requires a private or unsupported registry for ${name}. Export requires public npm packages.`);
    }
  }
  return { pkg, lock };
}

export function assertLockIntegrity(before: NpmLock, after: NpmLock): void {
  if (!after.packages) throw new Error('Reconciled lockfile has no package records.');
  for (const [name, value] of Object.entries(after.packages)) {
    if (!name) continue;
    const previous = before.packages?.[name];
    if (!previous) throw new Error(`Lock reconciliation added a new resolved location: ${name}`);
    for (const field of ['version', 'resolved', 'integrity', 'link']) {
      if (previous[field] !== value[field]) throw new Error(`Retained dependency ${name} changed ${field}; refusing version drift.`);
    }
  }
}

export function dependencyCandidates(snapshot: Snapshot, config: Pick<Config, 'preserve'>): Transformation[] {
  if (['package.json', 'package-lock.json'].some(name => matchesPath(name, config.preserve))) return [];
  const { pkg } = validateNpmProject(snapshot);
  const names = [...new Set(sections.flatMap(section => Object.keys(pkg[section] ?? {})))].sort();
  return names.map(name => {
    const next = structuredClone(pkg);
    for (const section of sections) if (next[section]) delete next[section]![name];
    return { id: `dependency:${name}`, kind: 'dependencies', description: `Remove dependency ${name}`, paths: ['package.json', 'package-lock.json'], edits: [{ path: 'package.json', content: Buffer.from(JSON.stringify(next, null, 2) + '\n') }] };
  });
}

async function assertNoAncestorDependencies(directory: string): Promise<void> {
  let ancestor = path.dirname(await realpath(directory));
  for (;;) {
    const dependencyPath = path.join(ancestor, 'node_modules');
    try {
      await lstat(dependencyPath);
      throw new Error(`Cannot isolate dependency resolution: ancestor ${dependencyPath} exists. Choose a TMPDIR outside dependency trees and retry.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

/** An execution directory must not inherit packages from any filesystem ancestor. */
export async function createIsolatedDirectory(prefix = 'repro-surgeon-'): Promise<string> {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), prefix));
  try { await assertNoAncestorDependencies(directory); return directory; }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Temporary work may be a sibling of source, but must never be created within it. */
export async function assertTemporaryDirectoryOutsideSource(sourceRoot: string): Promise<void> {
  const source = await realpath(sourceRoot).catch((error: NodeJS.ErrnoException) => {
    // Resume uses the saved snapshot even when the original checkout was removed.
    if (error.code === 'ENOENT') return path.resolve(sourceRoot);
    throw error;
  });
  const temporary = await realpath(tmpdir());
  const relative = path.relative(source, temporary);
  if (relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('The temporary directory is inside the original source. Choose a TMPDIR outside the source directory and retry.');
  }
}

export class WorkspaceManager {
  readonly root: string;
  readonly config: Config;
  readonly signal: AbortSignal | undefined;
  private executionRoot: Promise<string> | undefined;
  private disposed = false;
  constructor(root: string, config: Config, signal?: AbortSignal) { this.root = root; this.config = config; this.signal = signal; }

  private async directory(name: string): Promise<string> {
    this.signal?.throwIfAborted();
    if (this.disposed) throw new Error('Execution workspace has already been disposed.');
    this.executionRoot ??= createIsolatedDirectory();
    const cwd = path.join(await this.executionRoot, name);
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { mode: 0o700 });
    await assertNoAncestorDependencies(cwd);
    this.signal?.throwIfAborted();
    return cwd;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const directory = await this.executionRoot?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  async environment(): Promise<Record<string, string>> {
    this.signal?.throwIfAborted();
    const home = path.join(this.root, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const userconfig = path.join(home, 'npmrc');
    const globalconfig = path.join(home, 'global-npmrc');
    await writeFile(userconfig, '');
    await writeFile(globalconfig, '');
    return { ...cleanEnvironment(home, this.config.execution.env), NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig, NPM_CONFIG_CACHE: path.join(this.root, 'npm-cache'), NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1', CI: '1' };
  }

  async install(cwd: string, lockOnly = false): Promise<void> {
    this.signal?.throwIfAborted();
    await assertNoAncestorDependencies(cwd);
    const command = ['npm', ...(lockOnly ? ['install', '--package-lock-only'] : ['ci']), '--no-audit', '--no-fund'];
    if (lockOnly || !this.config.execution.allowInstallScripts) command.push('--ignore-scripts');
    const result = await runCommand(command, { cwd, timeoutMs: this.config.execution.installTimeoutMs, maxOutputBytes: this.config.execution.maxOutputBytes, env: await this.environment(), ...(this.signal ? { signal: this.signal } : {}) });
    if (result.exitCode !== 0 || result.error || result.timedOut || result.aborted || result.signal || result.outputLimitExceeded) {
      throw new Error(`Dependency installation failed${result.timedOut ? ' (timeout)' : ''}. ${result.error ?? result.stderr.slice(-2000)}`);
    }
  }

  async prepare(snapshot: Snapshot): Promise<string> {
    validateNpmProject(snapshot);
    const cwd = await this.directory('work');
    await writeSnapshot(snapshot, cwd);
    if (this.config.execution.allowInstallScripts) { await this.install(cwd); return cwd; }
    const key = hashValue([snapshot.get('package.json')!.content.toString(), snapshot.get('package-lock.json')!.content.toString()]);
    const cache = path.join(this.root, 'installations', key);
    let installed = false;
    try { installed = (await stat(path.join(cache, 'complete'))).isFile(); } catch { /* First use of this manifest. */ }
    if (!installed) {
      await rm(cache, { recursive: true, force: true });
      const installation = await this.directory('install');
      await writeSnapshot(new Map([...snapshot].filter(([name]) => name === 'package.json' || name === 'package-lock.json')), installation);
      await this.install(installation);
      this.signal?.throwIfAborted();
      await mkdir(path.dirname(cache), { recursive: true, mode: 0o700 });
      await cp(installation, cache, { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      await writeFile(path.join(cache, 'complete'), 'installed\n');
    }
    try {
      await cp(path.join(cache, 'node_modules'), path.join(cwd, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.signal?.throwIfAborted();
    return cwd;
  }

  async reconcile(snapshot: Snapshot, original: Snapshot): Promise<Snapshot> {
    const { lock: before } = validateNpmProject(original);
    validateNpmProject(snapshot);
    const cwd = await this.directory('reconcile');
    await writeSnapshot(snapshot, cwd);
    await this.install(cwd, true);
    this.signal?.throwIfAborted();
    const content = await readFile(path.join(cwd, 'package-lock.json'));
    assertLockIntegrity(before, JSON.parse(content.toString()) as NpmLock);
    const result = new Map(snapshot);
    result.set('package-lock.json', { content, mode: snapshot.get('package-lock.json')!.mode });
    validateNpmProject(result);
    return result;
  }
}

export async function runtimeInfo(cwd: string, signal?: AbortSignal): Promise<RuntimeInfo> {
  const result = await runCommand(['npm', '--version'], { cwd, timeoutMs: 10000, maxOutputBytes: 1024, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0 || result.error || result.timedOut) throw new Error('npm could not be started. Install npm 10 or newer.');
  const npm = result.stdout.trim();
  if (Number(npm.split('.')[0]) < 10) throw new Error('npm 10 or newer is required.');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return { node: process.version, npm, platform: process.platform, arch: process.arch, tool: version };
}
