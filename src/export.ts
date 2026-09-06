import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { parseConfig } from './config.ts';
import { assertTemporaryDirectoryOutsideSource, createIsolatedDirectory, WorkspaceManager } from './dependencies.ts';
import { evaluateOracle } from './oracle.ts';
import { runCommand } from './runner.ts';
import { assertDisjointPaths, hashValue, safeRelativePath, snapshotHash, writeSnapshot } from './snapshot.ts';
import { acquireRunLock, loadCheckpoint, saveCheckpoint } from './state.ts';
import type { Config, RunState, Snapshot, Verification } from './types.ts';

interface ManifestFile {
  path: string;
  mode: number;
  bytes: number;
  sha256: string;
}

interface ExportManifest {
  version: 1;
  format: 'repro-surgeon-export-v1';
  runId: string;
  createdAt: string;
  sourceHash: string;
  files: ManifestFile[];
  generated: ManifestFile[];
}

const MANIFEST_PATH = '.repro/manifest.json';
const GENERATED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vercel',
  'dist',
  'out',
  'build',
  'coverage',
]);

function fileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestFiles(snapshot: Snapshot): ManifestFile[] {
  return [...snapshot]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, entry]) => ({
      path: name,
      mode: entry.mode & 0o777,
      bytes: entry.content.length,
      sha256: fileHash(entry.content),
    }));
}

function validateRow(value: unknown, section: string): ManifestFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${section} manifest entry.`);
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(',') !== 'bytes,mode,path,sha256') throw new Error(`Invalid ${section} manifest fields.`);
  if (typeof row.path !== 'string') throw new Error(`Invalid ${section} manifest path.`);
  safeRelativePath(row.path);
  if (!Number.isInteger(row.mode) || (row.mode as number) < 0 || (row.mode as number) > 0o777) {
    throw new Error(`Invalid ${section} manifest mode for ${row.path}.`);
  }
  if (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0) {
    throw new Error(`Invalid ${section} manifest byte count for ${row.path}.`);
  }
  if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw new Error(`Invalid ${section} manifest checksum for ${row.path}.`);
  }
  return row as unknown as ManifestFile;
}

function parseManifest(value: unknown): ExportManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid export manifest.');
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (keys.join(',') !== 'createdAt,files,format,generated,runId,sourceHash,version') throw new Error('Invalid export manifest fields.');
  if (manifest.version !== 1 || manifest.format !== 'repro-surgeon-export-v1') throw new Error('Unsupported export manifest.');
  if (typeof manifest.runId !== 'string' || manifest.runId.length === 0) throw new Error('Invalid export manifest run identifier.');
  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Invalid export manifest timestamp.');
  if (typeof manifest.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)) throw new Error('Invalid export source hash.');
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.generated)) throw new Error('Invalid export manifest file lists.');

  const files = manifest.files.map((row) => validateRow(row, 'source'));
  const generated = manifest.generated.map((row) => validateRow(row, 'generated'));
  const seen = new Set<string>();
  for (const row of files) {
    if (row.path.startsWith('.repro/')) throw new Error('Source manifest may not own reserved .repro metadata.');
    if (seen.has(row.path)) throw new Error(`Duplicate export manifest path: ${row.path}`);
    seen.add(row.path);
  }
  for (const row of generated) {
    if (!row.path.startsWith('.repro/') || row.path === MANIFEST_PATH) throw new Error('Generated manifest paths must be reserved .repro files.');
    if (seen.has(row.path)) throw new Error(`Duplicate export manifest path: ${row.path}`);
    seen.add(row.path);
  }
  return { version: 1, format: 'repro-surgeon-export-v1', runId: manifest.runId, createdAt: manifest.createdAt, sourceHash: manifest.sourceHash, files, generated };
}

async function walkFiles(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelativePath(name);
    const full = path.join(root, name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Export contains a symbolic link: ${name}`);
    if (info.isDirectory()) {
      if (relative === '' && GENERATED_DIRECTORIES.has(entry.name)) continue;
      files.push(...await walkFiles(root, name));
    } else if (info.isFile()) files.push(name);
    else throw new Error(`Export contains a non-regular file: ${name}`);
  }
  return files;
}

async function readValidatedExport(root: string): Promise<{ manifest: ExportManifest; config: Config; snapshot: Snapshot }> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Export root must be a real directory.');

  let manifest: ExportManifest;
  let manifestContent: Buffer;
  try {
    manifestContent = await readFile(path.join(root, MANIFEST_PATH));
    manifest = parseManifest(JSON.parse(manifestContent.toString('utf8')) as unknown);
  } catch (error) {
    throw new Error(`Export manifest is missing, invalid, or unrelated: ${error instanceof Error ? error.message : String(error)}`);
  }

  const expected = new Map<string, ManifestFile>();
  for (const row of [...manifest.files, ...manifest.generated]) expected.set(row.path, row);
  const actual = await walkFiles(root);
  for (const name of actual) {
    if (name !== MANIFEST_PATH && !expected.has(name)) throw new Error(`Export has an extra unlisted source file: ${name}`);
  }
  if (!actual.includes(MANIFEST_PATH)) throw new Error('Export manifest is missing.');

  const snapshot: Snapshot = new Map();
  for (const [name, row] of expected) {
    let info;
    let content;
    try {
      info = await lstat(path.join(root, name));
      content = await readFile(path.join(root, name));
    } catch {
      throw new Error(`Export source is missing: ${name}`);
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Export source is not a regular file: ${name}`);
    if ((info.mode & 0o777) !== row.mode || content.length !== row.bytes || fileHash(content) !== row.sha256) {
      throw new Error(`Export source changed after creation: ${name}`);
    }
    snapshot.set(name, { content, mode: row.mode });
  }
  snapshot.set(MANIFEST_PATH, { content: manifestContent, mode: (await lstat(path.join(root, MANIFEST_PATH))).mode & 0o777 });

  const sourceSnapshot: Snapshot = new Map(manifest.files.map((row) => [row.path, snapshot.get(row.path)!]));
  if (snapshotHash(sourceSnapshot) !== manifest.sourceHash) throw new Error('Export source checksum differs from its manifest.');
  const config = parseConfig(JSON.parse(snapshot.get('.repro/config.json')?.content.toString('utf8') ?? 'null') as unknown);
  return { manifest, config, snapshot };
}

async function runtimeModule(name: 'runner' | 'oracle'): Promise<string> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  try {
    return (await readFile(path.join(directory, `${name}.js`), 'utf8')).replace(/\n?\/\/# sourceMappingURL=.*$/u, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const source = await readFile(path.join(directory, `${name}.ts`), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
    fileName: `${name}.ts`,
  }).outputText;
}

function readme(config: Config): string {
  return `# ${config.name}\n\nThis directory is a reduced reproduction. Review its source before sharing it.\n\n## Verify\n\n1. Use Node.js 22.18 or newer and npm 10 or newer.\n2. Run \`node .repro/verify.mjs\`.\n\nThe verifier checks every exported source file, copies the export to a separate temporary directory, installs its locked dependencies there, and starts this argv command there without a shell:\n\n\`\`\`json\n${JSON.stringify(config.command, null, 2)}\n\`\`\`\n\nThe original command is expected to exit with code ${config.oracle.exitCode}. The verifier exits successfully only when that failure also contains every required fragment and no forbidden fragment. This establishes the configured observation, not semantic root-cause identity or global minimality.\n\n## Execution boundary\n\nThe temporary working directory is not a security sandbox. The command can change directory and use ../ or absolute paths with your process permissions, including reads or writes to the original checkout or other host files. Paths are not rewritten or confined. Review and trust the source, command and dependencies, or run the entire verification inside your own container or virtual machine. A fresh directory on the same host does not prove independence from external files or network state.\n`;
}

const STANDALONE_VERIFIER = String.raw`#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git','node_modules','.next','.nuxt','.turbo','.cache','.vercel','dist','out','build','coverage']);
const cancellation = new AbortController();
let interruptionExitCode = 0;
const interrupt = code => {
  interruptionExitCode ||= code;
  cancellation.abort();
};
const interruptSignal = () => interrupt(130);
const terminateSignal = () => interrupt(143);
process.once('SIGINT', interruptSignal);
process.once('SIGTERM', terminateSignal);
const safe = value => {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe manifest path');
};
const sha = value => createHash('sha256').update(value).digest('hex');
const walk = async (base, relative = '') => {
  const result = [];
  for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    safe(name);
    const info = await lstat(path.join(base, name));
    if (info.isSymbolicLink()) throw new Error('Symbolic link in export: ' + name);
    if (info.isDirectory()) {
      if (relative === '' && ignored.has(entry.name)) continue;
      result.push(...await walk(base, name));
    } else if (info.isFile()) result.push(name);
    else throw new Error('Non-regular file in export: ' + name);
  }
  return result;
};

const validateFiles = async (base, manifest, expected, manifestContent) => {
  const currentManifest = await readFile(path.join(base, '.repro/manifest.json'));
  if (!currentManifest.equals(manifestContent)) throw new Error('Export manifest changed');
  for (const name of await walk(base)) if (name !== '.repro/manifest.json' && !expected.has(name)) throw new Error('Extra unlisted source file: ' + name);
  const contents = new Map();
  const source = [];
  for (const [name, row] of expected) {
    const info = await lstat(path.join(base, name));
    const content = await readFile(path.join(base, name));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 511) !== row.mode || content.length !== row.bytes || sha(content) !== row.sha256) throw new Error('Export source changed: ' + name);
    contents.set(name, content);
    if (!name.startsWith('.repro/')) source.push([name, row, content]);
  }
  const combined = createHash('sha256');
  for (const [name, row, content] of source.sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    combined.update(JSON.stringify([name, row.mode, content.length]) + '\n');
    combined.update(content);
  }
  if (combined.digest('hex') !== manifest.sourceHash) throw new Error('Export source checksum changed');
  return contents;
};

const writeExportFile = async (base, name, content, mode) => {
  const destination = path.join(base, name);
  await mkdir(path.dirname(destination), { recursive: true, mode: 448 });
  await writeFile(destination, content, { mode });
  await chmod(destination, mode);
};

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

const assertIsolatedAncestors = async workspace => {
  let current = path.dirname(await realpath(workspace));
  for (;;) {
    try {
      await lstat(path.join(current, 'node_modules'));
      throw new Error('Temporary verification directory has an ancestor node_modules: ' + current);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
};

try {
  const manifestContent = await readFile(path.join(root, '.repro/manifest.json'));
  const manifest = JSON.parse(manifestContent.toString('utf8'));
  if (manifest.version !== 1 || manifest.format !== 'repro-surgeon-export-v1' || !Array.isArray(manifest.files) || !Array.isArray(manifest.generated)) throw new Error('Invalid export manifest');
  const expected = new Map();
  for (const [section, rows] of [['source', manifest.files], ['generated', manifest.generated]]) {
    for (const row of rows) {
      if (!row || typeof row.path !== 'string' || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 511 || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid ' + section + ' manifest entry');
      safe(row.path);
      if (section === 'source' ? row.path.startsWith('.repro/') : !row.path.startsWith('.repro/') || row.path === '.repro/manifest.json') throw new Error('Invalid reserved manifest path');
      if (expected.has(row.path)) throw new Error('Duplicate manifest path: ' + row.path);
      expected.set(row.path, row);
    }
  }
  const contents = await validateFiles(root, manifest, expected, manifestContent);
  const config = JSON.parse(contents.get('.repro/config.json').toString('utf8'));
  if (!Array.isArray(config.command) || config.command.length === 0 || !config.oracle || !Array.isArray(config.oracle.allOf) || !Array.isArray(config.oracle.noneOf)) throw new Error('Invalid verifier configuration');
  const canonicalRoot = await realpath(root);
  const temporaryBase = await realpath(tmpdir());
  if (isWithin(canonicalRoot, temporaryBase)) throw new Error('The temporary directory is inside the exported source. Choose a TMPDIR outside the export directory and retry.');
  const temporary = await realpath(await mkdtemp(path.join(temporaryBase, 'repro-verifier-')));
  try {
    const workspace = path.join(temporary, 'work');
    await mkdir(workspace, { mode: 448 });
    await assertIsolatedAncestors(workspace);
    for (const [name, row] of expected) await writeExportFile(workspace, name, contents.get(name), row.mode);
    await writeExportFile(workspace, '.repro/manifest.json', manifestContent, 420);
    const home = path.join(temporary, 'home');
    await mkdir(home, { mode: 448 });
    await writeFile(path.join(home, 'npmrc'), '');
    await writeFile(path.join(home, 'global-npmrc'), '');
    const runtimeUrl = pathToFileURL(path.join(workspace, '.repro/runtime/runner.mjs')).href;
    const oracleUrl = pathToFileURL(path.join(workspace, '.repro/runtime/oracle.mjs')).href;
    const { runCommand, cleanEnvironment } = await import(runtimeUrl);
    const { evaluateOracle } = await import(oracleUrl);
    const environment = cleanEnvironment(home, config.execution.env);
    environment.NPM_CONFIG_USERCONFIG = path.join(home, 'npmrc');
    environment.NPM_CONFIG_GLOBALCONFIG = path.join(home, 'global-npmrc');
    environment.NPM_CONFIG_CACHE = path.join(temporary, 'npm-cache');
    environment.NEXT_TELEMETRY_DISABLED = '1';
    environment.NO_COLOR = '1';
    environment.CI = '1';
    const install = ['npm', 'ci', '--no-audit', '--no-fund'];
    if (!config.execution.allowInstallScripts) install.push('--ignore-scripts');
    const installed = await runCommand(install, { cwd: workspace, timeoutMs: config.execution.installTimeoutMs, maxOutputBytes: config.execution.maxOutputBytes, env: environment, signal: cancellation.signal });
    if (installed.exitCode !== 0 || installed.error || installed.timedOut || installed.aborted || installed.signal || installed.outputLimitExceeded) throw new Error('Dependency installation failed in isolated verification workspace');
    await validateFiles(workspace, manifest, expected, manifestContent);
    const execution = await runCommand(config.command, { cwd: workspace, timeoutMs: config.execution.timeoutMs, maxOutputBytes: config.execution.maxOutputBytes, env: environment, signal: cancellation.signal });
    const observation = evaluateOracle(execution, config.oracle);
    if (observation.status !== 'reproduced') throw new Error('Configured failure was not reproduced: ' + observation.reason);
    process.stdout.write('Configured failure reproduced.\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = interruptionExitCode || 1;
} finally {
  process.removeListener('SIGINT', interruptSignal);
  process.removeListener('SIGTERM', terminateSignal);
  if (interruptionExitCode !== 0) process.exitCode = interruptionExitCode;
}
`;

async function generatedSnapshot(state: RunState): Promise<Snapshot> {
  return new Map([
    ['.repro/LICENSE', { content: await readFile(new URL('../LICENSE', import.meta.url)), mode: 0o644 }],
    ['.repro/README.md', { content: Buffer.from(readme(state.config)), mode: 0o644 }],
    ['.repro/config.json', { content: Buffer.from(JSON.stringify(state.config, null, 2) + '\n'), mode: 0o644 }],
    ['.repro/verify.mjs', { content: Buffer.from(STANDALONE_VERIFIER), mode: 0o755 }],
    ['.repro/runtime/runner.mjs', { content: Buffer.from(await runtimeModule('runner')), mode: 0o644 }],
    ['.repro/runtime/oracle.mjs', { content: Buffer.from(await runtimeModule('oracle')), mode: 0o644 }],
  ]);
}

async function writeExport(root: string, state: RunState, snapshot: Snapshot): Promise<void> {
  await writeSnapshot(snapshot, root);
  const generated = await generatedSnapshot(state);
  await writeSnapshot(generated, root);
  const manifest: ExportManifest = {
    version: 1,
    format: 'repro-surgeon-export-v1',
    runId: state.id,
    createdAt: new Date().toISOString(),
    sourceHash: snapshotHash(snapshot),
    files: manifestFiles(snapshot),
    generated: manifestFiles(generated),
  };
  await writeSnapshot(new Map([[MANIFEST_PATH, { content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 }]]), root);
}

async function destinationState(destination: string, runId: string): Promise<'missing' | 'empty' | 'replaceable'> {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Existing export destination is not a real directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  if ((await readdir(destination)).length === 0) return 'empty';
  const existing = await readValidatedExport(destination);
  if (existing.manifest.runId !== runId) throw new Error('Existing export belongs to an unrelated run; refusing to replace it.');
  return 'replaceable';
}

async function installExport(stage: string, destination: string, current: 'missing' | 'empty' | 'replaceable'): Promise<void> {
  if (current === 'missing') {
    await rename(stage, destination);
    return;
  }
  if (current === 'empty') {
    await rm(destination, { recursive: true });
    await rename(stage, destination);
    return;
  }

  const backup = `${destination}.previous-${randomUUID()}`;
  await rename(destination, backup);
  try {
    await rename(stage, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    try { await rename(backup, destination); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function assertCurrentCheckpoint(state: RunState, snapshot: Snapshot, current: { state: RunState; snapshot: Snapshot }): void {
  const suppliedSnapshotHash = snapshotHash(snapshot);
  if (
    state.id !== current.state.id
    || state.configHash !== current.state.configHash
    || state.bestHash !== current.state.bestHash
    || state.status !== current.state.status
    || suppliedSnapshotHash !== current.state.bestHash
    || hashValue(state.config) !== hashValue(current.state.config)
    || hashValue(state) !== hashValue(current.state)
  ) {
    throw new Error('Export request is stale and no longer agrees with the current accepted checkpoint. Reload or resume the run before exporting.');
  }
  if (snapshotHash(current.snapshot) !== suppliedSnapshotHash) {
    throw new Error('Export snapshot no longer agrees with the current accepted checkpoint. Reload or resume the run before exporting.');
  }
}

export async function verifyReproduction(exportRoot: string, options?: { signal?: AbortSignal }): Promise<Verification> {
  let exportHash = '';
  let runs = 0;
  let validationRoot: string | undefined;
  let manager: WorkspaceManager | undefined;
  let result: Verification | undefined;
  try {
    const absoluteExportRoot = path.resolve(exportRoot);
    await assertTemporaryDirectoryOutsideSource(absoluteExportRoot);
    const { config, snapshot } = await readValidatedExport(absoluteExportRoot);
    exportHash = snapshotHash(snapshot);
    validationRoot = await createIsolatedDirectory('repro-surgeon-verification-state-');
    manager = new WorkspaceManager(validationRoot, config, options?.signal);
    for (let run = 0; run < config.runs.final; run++) {
      const cwd = await manager.prepare(snapshot);
      await readValidatedExport(cwd);
      const execution = await runCommand(config.command, {
        cwd,
        timeoutMs: config.execution.timeoutMs,
        maxOutputBytes: config.execution.maxOutputBytes,
        env: await manager.environment(),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      runs++;
      const observation = evaluateOracle(execution, config.oracle);
      if (observation.status !== 'reproduced') {
        result = { status: 'failed', runs, reason: `Fresh verification failed: ${observation.reason}`, snapshotHash: exportHash, environment: 'fresh-directory' };
        break;
      }
    }
    result ??= { status: 'verified', runs, reason: `The exported source reproduced in ${runs} fresh-directory runs.`, snapshotHash: exportHash, environment: 'fresh-directory' };
  } catch (error) {
    result = { status: 'failed', runs, reason: error instanceof Error ? error.message : String(error), snapshotHash: exportHash, environment: 'fresh-directory' };
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await manager?.dispose();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (validationRoot !== undefined) {
      try {
        await rm(validationRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length > 0) {
      result = { status: 'failed', runs, reason: `Fresh verification cleanup failed: ${cleanupErrors.join('; ')}`, snapshotHash: exportHash, environment: 'fresh-directory' };
    }
  }
  return result ?? { status: 'failed', runs, reason: 'Fresh verification did not produce a result.', snapshotHash: exportHash, environment: 'fresh-directory' };
}

export async function exportReproduction(
  runRoot: string,
  state: RunState,
  snapshot: Snapshot,
  options?: { signal?: AbortSignal },
): Promise<RunState> {
  if (snapshotHash(snapshot) !== state.bestHash) throw new Error('Export snapshot differs from the accepted state.');
  const absoluteRunRoot = path.resolve(runRoot);
  const destination = path.join(absoluteRunRoot, 'repro');
  await assertDisjointPaths(state.sourceRoot, destination);
  const release = await acquireRunLock(absoluteRunRoot);
  try {
    assertCurrentCheckpoint(state, snapshot, await loadCheckpoint(absoluteRunRoot));
    await assertTemporaryDirectoryOutsideSource(state.sourceRoot);
    const current = await destinationState(destination, state.id);
    const stage = path.join(absoluteRunRoot, `.repro-stage-${randomUUID()}`);
    state.status = 'verifying';
    state.verification = { status: 'pending', runs: 0, reason: 'Writing and checking the independent export.', snapshotHash: '', environment: 'fresh-directory' };
    state.updatedAt = new Date().toISOString();
    await saveCheckpoint(absoluteRunRoot, state, snapshot);

    try {
      await mkdir(stage, { mode: 0o700 });
      await writeExport(stage, state, snapshot);
      const staged = await readValidatedExport(stage);
      if (staged.manifest.runId !== state.id) throw new Error('Staged export ownership could not be verified.');
      await installExport(stage, destination, current);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }

    state.verification = await verifyReproduction(destination, options);
    state.updatedAt = new Date().toISOString();
    if (state.verification.status === 'verified') {
      state.status = 'complete';
      state.stopReason ||= 'Independent export verified';
    } else {
      state.status = 'failed';
      state.stopReason ||= `Export verification failed: ${state.verification.reason}`;
    }
    await saveCheckpoint(absoluteRunRoot, state, snapshot);
    return state;
  } finally {
    await release();
  }
}
