import ts from 'typescript';
import { isLegalPath } from './protection.ts';
import { matchesPath } from './snapshot.ts';

import type { Config, Snapshot, Transformation, TransformKind } from './types.ts';

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const PROTECTED_BASENAME = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i;

interface ProposedRange {
  start: number;
  end: number;
  label: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPreserved(path: string, config: Config): boolean {
  return matchesPath(path, config.preserve);
}

function isProtectedPath(path: string, config: Config): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return PROTECTED_BASENAME.test(basename) || isLegalPath(path) || isPreserved(path, config);
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|js)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function diagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
}

function parseSource(path: string, source: string): ts.SourceFile | null {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  return diagnostics(parsed).length === 0 ? parsed : null;
}

function listItemRange<T extends ts.Node>(
  items: readonly T[],
  index: number,
  sourceFile: ts.SourceFile,
): ProposedRange {
  const item = items[index];
  if (!item) throw new Error('list item index is out of bounds');
  if (items.length === 1) return { start: item.getStart(sourceFile), end: item.end, label: 'list item' };
  const next = items[index + 1];
  if (next) return { start: item.getStart(sourceFile), end: next.getStart(sourceFile), label: 'list item' };
  const previous = items[index - 1];
  if (!previous) throw new Error('missing previous list item');
  return { start: previous.end, end: item.end, label: 'list item' };
}

function isDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
}

function statementRanges(statements: readonly ts.Statement[], label: string): ProposedRange[] {
  const ranges: ProposedRange[] = [];
  let inPrologue = true;
  for (const statement of statements) {
    if (inPrologue && isDirective(statement)) continue;
    inPrologue = false;
    ranges.push({
      start: statement.getStart(),
      end: statement.end,
      label: `${label} ${ts.SyntaxKind[statement.kind]}`,
    });
  }
  return ranges;
}

function buildCandidates(
  path: string,
  original: string,
  ranges: ProposedRange[],
  kind: TransformKind,
  valid: (text: string) => boolean,
): Transformation[] {
  const seen = new Set<string>();
  const candidates: Array<Transformation & { start: number; end: number }> = [];
  const firstLineEnd = original.startsWith('#!') ? original.indexOf('\n') + 1 : 0;
  const legalComments: Array<{ start: number; end: number }> = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, original);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const text = scanner.getTokenText();
    if (text.startsWith('/*!') || /@license|@preserve|copyright|SPDX-License-Identifier|SPDX-FileCopyrightText|permission is hereby granted/i.test(text)) {
      legalComments.push({ start: scanner.getTokenPos(), end: scanner.getTextPos() });
    }
  }
  for (const range of ranges) {
    const start = firstLineEnd > 0 && range.start < firstLineEnd ? firstLineEnd : range.start;
    if (start < 0 || range.end <= start || range.end > original.length) continue;
    if (legalComments.some(comment => start < comment.end && range.end > comment.start)) continue;
    const content = original.slice(0, start) + original.slice(range.end);
    if (content === original || !valid(content) || seen.has(content)) continue;
    seen.add(content);
    candidates.push({
      id: `${kind}:${path}:${start}:${range.end}:${range.label}`,
      kind,
      description: `Remove ${range.label} from ${path}`,
      paths: [path],
      edits: [{ path, content: Buffer.from(content) }],
      start,
      end: range.end,
    });
  }
  candidates.sort(
    (left, right) =>
      compareText(left.paths[0]!, right.paths[0]!) ||
      left.start - right.start ||
      left.end - right.end ||
      compareText(left.description, right.description),
  );
  return candidates.map(({ start: _start, end: _end, ...candidate }) => candidate);
}

export function syntaxCandidates(snapshot: Snapshot, config: Config): Transformation[] {
  const all: Transformation[] = [];
  for (const [path, entry] of [...snapshot.entries()].sort(([a], [b]) => compareText(a, b))) {
    if (!SOURCE_EXTENSIONS.test(path) || isProtectedPath(path, config)) continue;
    const source = entry.content.toString('utf8');
    const sourceFile = parseSource(path, source);
    if (!sourceFile) continue;
    const ranges = statementRanges(sourceFile.statements, 'top-level statement');

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          bindings.elements.forEach((element, index) => {
            const range = listItemRange(bindings.elements, index, sourceFile);
            ranges.push({ ...range, label: `import specifier ${element.name.text}` });
          });
        }
      }
      if (ts.isVariableStatement(node)) {
        const declarations = node.declarationList.declarations;
        declarations.forEach((_declaration, index) => {
          const range = declarations.length === 1
            ? { start: node.getStart(), end: node.end, label: 'variable declaration' }
            : { ...listItemRange(declarations, index, sourceFile), label: 'variable declaration' };
          ranges.push(range);
        });
      }
      if (ts.isBlock(node)) ranges.push(...statementRanges(node.statements, 'statement'));
      if (ts.isObjectLiteralExpression(node)) {
        node.properties.forEach((property, index) => {
          const range = listItemRange(node.properties, index, sourceFile);
          const name = property.name && ts.isIdentifier(property.name) ? ` ${property.name.text}` : '';
          ranges.push({ ...range, label: `object member${name}` });
        });
      }
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        node.children.forEach((child) => {
          if (ts.isJsxText(child) && child.getText(sourceFile).trim() === '') return;
          ranges.push({ start: child.getFullStart(), end: child.end, label: 'JSX child' });
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    all.push(...buildCandidates(path, source, ranges, 'syntax', (candidate) => parseSource(path, candidate) !== null));
  }
  return all.sort((left, right) => compareText(left.id, right.id));
}

export function jsonCandidates(snapshot: Snapshot, config: Config): Transformation[] {
  const all: Transformation[] = [];
  for (const [path, entry] of [...snapshot.entries()].sort(([a], [b]) => compareText(a, b))) {
    if (!/\.jsonc?$/i.test(path) || isProtectedPath(path, config)) continue;
    const source = entry.content.toString('utf8');
    if (ts.parseConfigFileTextToJson(path, source).error) continue;
    const sourceFile = ts.parseJsonText(path, source);
    if (diagnostics(sourceFile).length > 0) continue;
    const ranges: ProposedRange[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        node.properties.forEach((property, index) => {
          const range = listItemRange(node.properties, index, sourceFile);
          const key = property.name && ts.isStringLiteral(property.name) ? ` ${property.name.text}` : '';
          ranges.push({ ...range, label: `JSON member${key}` });
        });
      } else if (ts.isArrayLiteralExpression(node)) {
        node.elements.forEach((_element, index) => {
          ranges.push({ ...listItemRange(node.elements, index, sourceFile), label: 'JSON array item' });
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    all.push(...buildCandidates(path, source, ranges, 'json', candidate => !ts.parseConfigFileTextToJson(path, candidate).error));
  }
  return all.sort((left, right) => compareText(left.id, right.id));
}
