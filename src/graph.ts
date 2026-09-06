import path from 'node:path';
import ts from 'typescript';
import { isLegalPath } from './protection.ts';

import type { AdapterInfo, Config, ProjectGraph, Snapshot } from './types.ts';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?)$/i;
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const APP_ENTRYPOINT = /\/(?:page|layout|loading|error|not-found|template|default|global-error|route)\.(?:[cm]?[jt]sx?)$/i;
const ROOT_ENTRYPOINT = /^(?:src\/)?(?:middleware|proxy|instrumentation|instrumentation-client)\.(?:[cm]?[jt]sx?)$/i;
const NEXT_CONFIG = /^next\.config\.(?:[cm]?[jt]s)$/i;

interface AliasRule { key: string; targets: string[]; baseUrl: string }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|js)$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function readAliases(snapshot: Snapshot): AliasRule[] {
  const configPath = snapshot.has('tsconfig.json') ? 'tsconfig.json' : snapshot.has('jsconfig.json') ? 'jsconfig.json' : null;
  if (!configPath) return [];
  const entry = snapshot.get(configPath);
  if (!entry) return [];
  const parsed = ts.parseConfigFileTextToJson(configPath, entry.content.toString('utf8'));
  if (parsed.error || typeof parsed.config !== 'object' || parsed.config === null) return [];
  const compilerOptions = (parsed.config as { compilerOptions?: unknown }).compilerOptions;
  if (typeof compilerOptions !== 'object' || compilerOptions === null) return [];
  const options = compilerOptions as { baseUrl?: unknown; paths?: unknown };
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  if (typeof options.paths !== 'object' || options.paths === null) return [];
  const rules: AliasRule[] = [];
  for (const [key, value] of Object.entries(options.paths)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((target): target is string => typeof target === 'string');
    if (targets.length > 0) rules.push({ key, targets, baseUrl });
  }
  return rules.sort((left, right) => compareText(left.key, right.key));
}

function aliasTargets(specifier: string, rules: AliasRule[]): string[] | null {
  for (const rule of rules) {
    const star = rule.key.indexOf('*');
    if (star === -1) {
      if (specifier === rule.key) return rule.targets.map((target) => path.posix.normalize(path.posix.join(rule.baseUrl, target)));
      continue;
    }
    const prefix = rule.key.slice(0, star);
    const suffix = rule.key.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    return rule.targets.map((target) => path.posix.normalize(path.posix.join(rule.baseUrl, target.replace('*', middle))));
  }
  return null;
}

function possibleSourcePaths(base: string): string[] {
  const normalized = path.posix.normalize(base);
  const extension = path.posix.extname(normalized);
  const candidates = [normalized];
  if (extension) {
    const stem = normalized.slice(0, -extension.length);
    if (extension === '.js' || extension === '.jsx') candidates.push(`${stem}.ts`, `${stem}.tsx`);
    if (extension === '.mjs') candidates.push(`${stem}.mts`);
    if (extension === '.cjs') candidates.push(`${stem}.cts`);
  } else {
    for (const candidateExtension of SOURCE_EXTENSIONS) candidates.push(normalized + candidateExtension);
    for (const candidateExtension of SOURCE_EXTENSIONS) candidates.push(path.posix.join(normalized, `index${candidateExtension}`));
  }
  return [...new Set(candidates)];
}

function resolveInternal(snapshot: Snapshot, bases: string[]): string | null {
  for (const base of bases) {
    for (const candidate of possibleSourcePaths(base)) if (snapshot.has(candidate)) return candidate;
  }
  return null;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const found: string[] = [];
  const addLiteral = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addLiteral(argument);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') addLiteral(argument);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(found)];
}

function stableRecord(entries: Array<[string, string[]]>): Record<string, string[]> {
  return Object.fromEntries(entries.sort(([a], [b]) => compareText(a, b)).map(([key, values]) => [key, [...new Set(values)].sort()]));
}

export function buildGraph(snapshot: Snapshot): ProjectGraph {
  const aliases = readAliases(snapshot);
  const imports: Array<[string, string[]]> = [];
  const external: Array<[string, string[]]> = [];
  const unresolved: Array<[string, string[]]> = [];
  for (const [filePath, entry] of [...snapshot.entries()].sort(([a], [b]) => compareText(a, b))) {
    if (!SOURCE_PATTERN.test(filePath)) continue;
    const sourceFile = ts.createSourceFile(filePath, entry.content.toString('utf8'), ts.ScriptTarget.Latest, true, scriptKind(filePath));
    if (parseDiagnostics(sourceFile).length > 0) continue;
    const internalEdges: string[] = [];
    const externalEdges: string[] = [];
    const unresolvedEdges: string[] = [];
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
        const resolved = resolveInternal(snapshot, [base]);
        if (resolved) internalEdges.push(resolved); else unresolvedEdges.push(specifier);
        continue;
      }
      const targets = aliasTargets(specifier, aliases);
      if (targets) {
        const resolved = resolveInternal(snapshot, targets);
        if (resolved) internalEdges.push(resolved); else unresolvedEdges.push(specifier);
      } else externalEdges.push(specifier);
    }
    imports.push([filePath, internalEdges]);
    external.push([filePath, externalEdges]);
    unresolved.push([filePath, unresolvedEdges]);
  }
  return { imports: stableRecord(imports), external: stableRecord(external), unresolved: stableRecord(unresolved) };
}

function metadataPaths(snapshot: Snapshot): string[] {
  const protectedPaths: string[] = [];
  for (const filePath of snapshot.keys()) {
    const basename = path.posix.basename(filePath);
    if (filePath === 'package.json' || LOCKFILES.has(basename) || isLegalPath(filePath)) protectedPaths.push(filePath);
  }
  return protectedPaths;
}

function nextEntrypoints(snapshot: Snapshot): { app: string[]; pages: string[]; framework: string[] } {
  const app: string[] = [];
  const pages: string[] = [];
  const framework: string[] = [];
  for (const filePath of snapshot.keys()) {
    if (!SOURCE_PATTERN.test(filePath)) continue;
    if ((filePath.startsWith('app/') || filePath.startsWith('src/app/')) && APP_ENTRYPOINT.test(`/${filePath}`)) app.push(filePath);
    if (filePath.startsWith('pages/') || filePath.startsWith('src/pages/')) pages.push(filePath);
    if (ROOT_ENTRYPOINT.test(filePath)) framework.push(filePath);
  }
  return { app: app.sort(), pages: pages.sort(), framework: framework.sort() };
}

function packageInfo(snapshot: Snapshot): { version: string | null; warning: string | null } {
  const entry = snapshot.get('package.json');
  if (!entry) return { version: null, warning: 'package.json is missing.' };
  try {
    const parsed = JSON.parse(entry.content.toString('utf8')) as Record<string, unknown>;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const values = parsed[section];
      if (typeof values !== 'object' || values === null || Array.isArray(values)) continue;
      const version = (values as Record<string, unknown>).next;
      if (typeof version === 'string') return { version, warning: null };
    }
    return { version: null, warning: null };
  } catch {
    return { version: null, warning: 'package.json is not valid JSON.' };
  }
}

export function detectAdapter(snapshot: Snapshot, choice: Config['adapter']): AdapterInfo {
  const baseProtected = metadataPaths(snapshot);
  if (choice === 'generic') {
    return { name: 'generic', version: null, router: 'none', entrypoints: [], protectedPaths: baseProtected.sort(), warnings: [] };
  }
  const packageResult = packageInfo(snapshot);
  const routes = nextEntrypoints(snapshot);
  const hasApp = routes.app.length > 0;
  const hasPages = routes.pages.length > 0;
  if (choice === 'auto' && packageResult.version === null && !hasApp && !hasPages) {
    return {
      name: 'generic', version: null, router: 'none', entrypoints: [], protectedPaths: baseProtected.sort(),
      warnings: packageResult.warning ? [packageResult.warning] : [],
    };
  }
  const entrypoints = [...routes.app, ...routes.pages, ...routes.framework].sort();
  const nextConfigPaths = [...snapshot.keys()].filter((filePath) => NEXT_CONFIG.test(path.posix.basename(filePath)));
  const warnings: string[] = [];
  if (packageResult.warning) warnings.push(packageResult.warning);
  if (packageResult.version === null) warnings.push('Next.js dependency was not found in package.json.');
  if (!hasApp && !hasPages) warnings.push('No App Router or Pages Router entrypoints were found.');
  if (hasApp && hasPages) warnings.push('Project contains both App and Pages Router entrypoints.');
  return {
    name: 'next',
    version: packageResult.version,
    router: hasApp && hasPages ? 'mixed' : hasApp ? 'app' : hasPages ? 'pages' : 'none',
    entrypoints,
    protectedPaths: [...new Set([...baseProtected, ...entrypoints, ...nextConfigPaths])].sort(),
    warnings,
  };
}
