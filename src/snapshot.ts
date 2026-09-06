import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import type { Config, Inventory, Metrics, ReviewFinding, Snapshot, Transformation } from './types.ts';

const generated = new Set(['.git', 'node_modules', '.next', '.nuxt', '.turbo', '.cache', '.vercel', '.repro', '.repro-surgeon', '.local', '.superpowers', 'dist', 'out', 'build', 'coverage']);
const credentials = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.ssh|\.aws|\.azure|\.config|id_rsa.*|id_ed25519.*|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx))$/i;
const locks = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

export function safeRelativePath(value: string): void {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(value)}`);
  }
}

export function matchesPath(name: string, patterns: string[]): boolean {
  return patterns.some(pattern => name === pattern || name.startsWith(pattern.replace(/\/$/, '') + '/') || picomatch(pattern, { dot: true })(name));
}

async function canonicalFuturePath(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(absolute));
  }
}

export async function assertDisjointPaths(source: string, destination: string): Promise<void> {
  const [a, b] = await Promise.all([canonicalFuturePath(source), canonicalFuturePath(destination)]);
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
    throw new Error('Source and output directories overlap. Choose an output beside the project, outside its tree.');
  }
}

function addIgnoreRules(matcher: ReturnType<typeof ignore>, relative: string, contents: string): void {
  if (!relative) { matcher.add(contents); return; }
  const prefix = relative.replace(/[\\*?\[\]]/g, '\\$&') + '/';
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^ *$/.test(line) || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (/^ *$/.test(pattern) || pattern === '/') continue;
    // A slash before the optional directory suffix anchors a pattern to its
    // .gitignore directory. Basename patterns also apply in its descendants.
    const anchored = pattern.replace(/ +$/, '').replace(/\/$/, '').includes('/');
    const scoped = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    matcher.add(`${negated ? '!' : ''}/${prefix}${anchored ? '' : '**/'}${scoped}`);
  }
}

export async function inventoryProject(root: string, config: Pick<Config, 'include' | 'exclude'>, maxBytes = 128 * 1024 * 1024): Promise<Inventory> {
  const absolute = await realpath(root);
  const result: Inventory = { snapshot: new Map(), excluded: [], warnings: [] };
  let bytes = 0;
  const visit = async (relative: string, inherited: ReturnType<typeof ignore>) => {
    const full = path.join(absolute, relative);
    const rules = ignore().add(inherited);
    try {
      const ignorePath = path.join(full, '.gitignore');
      const info = await lstat(ignorePath);
      if (info.isFile()) addIgnoreRules(rules, relative, await readFile(ignorePath, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const entries = (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelativePath(name);
      let reason: string | undefined;
      if (entry.isSymbolicLink()) reason = 'Symbolic link excluded; target was not read';
      else if (generated.has(entry.name)) reason = 'Generated or internal directory';
      else if (credentials.test(entry.name)) reason = 'Credential or environment file';
      else if (entry.name === '.DS_Store') reason = 'Operating-system metadata';
      else if (matchesPath(name, config.exclude)) reason = 'Explicit exclude rule';
      else if (!matchesPath(name, config.include)) {
        if (rules.ignores(name + (entry.isDirectory() ? '/' : ''))) reason = 'Git ignore rule';
      }
      if (reason) {
        result.excluded.push({ path: name, reason });
        // Explicit inclusion can reach a file inside an ignored directory, but never a hard exclusion.
        if (entry.isDirectory() && reason === 'Git ignore rule' && config.include.some(p => p.startsWith(name + '/') || p.includes('*'))) await visit(name, rules);
        continue;
      }
      if (entry.isDirectory()) await visit(name, rules);
      else if (entry.isFile()) {
        const filePath = path.join(absolute, name);
        const before = await lstat(filePath);
        if (!before.isFile()) throw new Error(`Source changed while scanning: ${name}`);
        if (bytes + before.size > maxBytes) throw new Error(`Source snapshot exceeds ${maxBytes} bytes. Exclude large fixtures or generated files.`);
        const content = await readFile(filePath);
        const after = await lstat(filePath);
        if (!after.isFile() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== content.length) throw new Error(`Source changed while scanning: ${name}`);
        bytes += content.length;
        result.snapshot.set(name, { content, mode: after.mode & 0o777 });
      } else result.excluded.push({ path: name, reason: 'Non-regular file' });
    }
  };
  await visit('', ignore());
  if (!result.snapshot.has('package.json')) throw new Error('No package.json was included. Choose the root of a single npm package.');
  if (result.excluded.some(x => /Symbolic/.test(x.reason))) result.warnings.push('Symbolic links were excluded. A failure depending on them may not reproduce.');
  return result;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing a symbolic link or non-directory destination: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent !== directory) await ensureRealDirectory(parent);
    await mkdir(directory);
  }
}

export async function writeSnapshot(snapshot: Snapshot, root: string): Promise<void> {
  const absolute = path.resolve(root);
  await ensureRealDirectory(absolute);
  for (const [name, file] of [...snapshot].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    safeRelativePath(name);
    const parts = name.split('/');
    let directory = absolute;
    for (const segment of parts.slice(0, -1)) { directory = path.join(directory, segment); await ensureRealDirectory(directory); }
    const destination = path.join(absolute, name);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing a symbolic link or non-file destination: ${name}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(destination, file.content, { flag: 'w', mode: file.mode & 0o777 });
    await chmod(destination, file.mode & 0o777);
  }
}

export function snapshotHash(snapshot: Snapshot): string {
  const hash = createHash('sha256');
  for (const [name, file] of [...snapshot].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    hash.update(JSON.stringify([name, file.mode, file.content.length]) + '\n');
    hash.update(file.content);
  }
  return hash.digest('hex');
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function metrics(snapshot: Snapshot): Metrics {
  let bytes = 0;
  let sourceBytes = 0;
  for (const [name, file] of snapshot) { bytes += file.content.length; if (!locks.has(name) && name !== 'package.json') sourceBytes += file.content.length; }
  let dependencies = 0;
  try {
    const pkg = JSON.parse(snapshot.get('package.json')?.content.toString() ?? '{}') as Record<string, Record<string, unknown>>;
    dependencies = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]).size;
  } catch { /* Invalid manifests are diagnosed before execution. */ }
  return { files: snapshot.size, bytes, sourceBytes, dependencies };
}

export function applyTransformation(snapshot: Snapshot, transformation: Transformation): Snapshot {
  const next = new Map(snapshot);
  for (const edit of transformation.edits) {
    safeRelativePath(edit.path);
    if (edit.content === null) next.delete(edit.path);
    else next.set(edit.path, { content: Buffer.from(edit.content), mode: snapshot.get(edit.path)?.mode ?? 0o644 });
  }
  return next;
}

export function scanForReview(snapshot: Snapshot): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const [name, entry] of snapshot) {
    if (entry.content.includes(0)) continue;
    const text = entry.content.toString('utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,})/.test(text)) findings.push({ path: name, kind: 'secret', message: 'Possible credential found. Inspect this file before sharing.' });
    if (/(?:\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\/|[A-Za-z]:\\Users\\)/.test(text)) findings.push({ path: name, kind: 'local-path', message: 'An absolute personal-directory path remains.' });
    if (/https?:\/\/[^\s/:]+:[^\s/@]+@/.test(text)) findings.push({ path: name, kind: 'secret', message: 'A URL may contain embedded credentials.' });
  }
  return findings;
}
