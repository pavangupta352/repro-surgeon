import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

import { jsonCandidates, syntaxCandidates } from '../src/transforms.ts';
import type { Config, Snapshot, Transformation } from '../src/types.ts';

const config: Config = {
  version: 1,
  name: 'transform test',
  command: ['npm', 'test'],
  oracle: { exitCode: 1, allOf: ['target'], noneOf: [] },
  adapter: 'generic',
  budget: { maxEvaluations: 100, maxSeconds: 60 },
  runs: { baseline: 3, candidate: 2, final: 3 },
  execution: {
    timeoutMs: 1_000,
    maxOutputBytes: 10_000,
    installTimeoutMs: 10_000,
    allowInstallScripts: false,
    env: [],
  },
  reduce: { files: true, syntax: true, json: true, dependencies: false },
  include: [],
  exclude: [],
  preserve: ['src/routes/[id].tsx', 'src/pinned/**'],
};

function snapshot(files: Record<string, string>): Snapshot {
  return new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      { content: Buffer.from(content), mode: 0o644 },
    ]),
  );
}

function appliedText(candidate: Transformation): string {
  assert.equal(candidate.edits.length, 1);
  const edit = candidate.edits[0];
  assert.ok(edit?.content);
  return edit.content.toString('utf8');
}

function parseDiagnostics(path: string, source: string): readonly ts.Diagnostic[] {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  return (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
}

test('syntax candidates preserve prologues and produce parseable narrow edits', () => {
  const source = `#!/usr/bin/env node
"use client";
import primary, { alpha as renamed, beta } from "./dep.js";
const first = 1, second = 2;
const model = { keep: 1, drop: 2 };
function render() {
  const nested = { left: 1, right: 2 };
  return <main><span>A</span><span>B</span></main>;
}
console.log(primary, renamed, beta, first, second, model, render);
`;
  const candidates = syntaxCandidates(snapshot({ 'src/example.tsx': source }), config);
  assert.ok(candidates.length > 8);

  const outputs = candidates.map(appliedText);
  for (const output of outputs) {
    assert.ok(output.startsWith('#!/usr/bin/env node\n'));
    assert.match(output, /["']use client["'];/);
    assert.deepEqual(parseDiagnostics('src/example.tsx', output), []);
  }

  assert.ok(outputs.some((output) => !output.includes('alpha as renamed') && output.includes('beta')));
  assert.ok(outputs.some((output) => !output.includes('first = 1') && output.includes('second = 2')));
  assert.ok(outputs.some((output) => !output.includes('drop: 2') && output.includes('keep: 1')));
  assert.ok(outputs.some((output) => output.split('<span>').length === 2));
});

test('syntax candidates skip malformed and explicitly preserved source paths', () => {
  const candidates = syntaxCandidates(
    snapshot({
      'src/broken.ts': 'export const = ;',
      'src/routes/[id].tsx': 'export default function Page() { return <p>route</p>; }',
      'src/pinned/keep.ts': 'export const keep = 1;',
      'src/live.ts': 'export const removable = 1;',
    }),
    config,
  );

  assert.deepEqual([...new Set(candidates.flatMap((candidate) => candidate.paths))], ['src/live.ts']);
});

test('syntax candidates never remove a shebang when it is the only prologue', () => {
  const candidates = syntaxCandidates(
    snapshot({ 'bin/run.js': '#!/usr/bin/env node\nconst removable = true;\nconsole.log(removable);\n' }),
    config,
  );

  assert.ok(candidates.length > 0);
  for (const candidate of candidates) assert.ok(appliedText(candidate).startsWith('#!/usr/bin/env node\n'));
});

test('all syntax candidates preserve legal comments, including nested and list trivia', () => {
  const header = '/*! @license MIT Copyright 2026 Example */';
  const nested = '/* SPDX-License-Identifier: MIT */';
  const member = '/* Copyright 2026 Example */';
  const source = `${header}\nconst unused = 1;\nfunction helper() { ${nested}\nconst dead = 2; return dead; }\nconst items = { left: 1, ${member} right: 2 };\nconsole.error("TARGET"); process.exit(1);`;
  const candidates = syntaxCandidates(snapshot({ 'case.js': source }), config);
  assert(candidates.length > 0);
  assert(candidates.some(candidate => !appliedText(candidate).includes('unused = 1')));
  for (const candidate of candidates) {
    for (const notice of [header, nested, member]) assert(appliedText(candidate).includes(notice), candidate.description);
  }
});

test('directory pins and conventional license files survive structural reduction', () => {
  const input = snapshot({
    'src/keep/child.js': 'const x = 1; console.log(x);',
    'data/keep/case.json': '{"a":1,"b":2}',
    'LICENSE-MIT.json': '{"license":"MIT","copyright":"Example"}',
    'legal/THIRD_PARTY_NOTICES.json': '{"copyright":"Example"}',
  });
  const pins = { ...config, preserve: ['src/keep', 'data/keep/'] };
  assert.deepEqual(syntaxCandidates(input, pins), []);
  assert.deepEqual(jsonCandidates(input, pins), []);
});

test('JSONC reductions retain comments and accept configuration trailing commas', () => {
  const source = '/* Copyright 2026 Example */\n{\n  // Local configuration\n  "keep": 1,\n  "drop": {"a": 2, "b": 3,},\n}\n';
  const candidates = jsonCandidates(snapshot({ 'settings.jsonc': source, 'tsconfig.json': source }), config);
  assert(candidates.some(candidate => candidate.paths[0] === 'settings.jsonc'));
  assert(candidates.some(candidate => candidate.paths[0] === 'tsconfig.json'));
  assert(candidates.some(candidate => !appliedText(candidate).includes('"drop"')));
  for (const candidate of candidates) {
    const output = appliedText(candidate);
    assert(output.includes('/* Copyright 2026 Example */'));
    assert.equal(ts.parseConfigFileTextToJson(candidate.paths[0]!, output).error, undefined);
  }
  assert.deepEqual(jsonCandidates(snapshot({ 'broken.jsonc': '{"a":}' }), config), []);
});

test('JSON candidates remove nested members and array items while remaining valid', () => {
  const candidates = jsonCandidates(
    snapshot({
      'fixtures/case.json': `{
  "name": "case",
  "options": { "keep": true, "drop": false },
  "steps": ["open", "click", "observe"]
}\n`,
    }),
    config,
  );
  assert.ok(candidates.length >= 8);

  const outputs = candidates.map(appliedText);
  for (const output of outputs) assert.doesNotThrow(() => JSON.parse(output));
  assert.ok(outputs.some((output) => !output.includes('"drop"') && output.includes('"keep"')));
  assert.ok(outputs.some((output) => !output.includes('"click"') && output.includes('"open"')));
});

test('JSON candidates protect package metadata, lockfiles, legal files, and preserve patterns', () => {
  const candidates = jsonCandidates(
    snapshot({
      'package.json': '{"scripts":{"test":"node test.js"}}',
      'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
      'LICENSE.json': '{"notice":"retain"}',
      'fixtures/[stable].json': '{"retain":true}',
      'src/pinned/data.json': '{"retain":true}',
      'fixtures/live.json': '{"remove":true}',
    }),
    { ...config, preserve: [...config.preserve, 'fixtures/[stable].json'] },
  );

  assert.ok(candidates.length > 0);
  assert.deepEqual([...new Set(candidates.flatMap((candidate) => candidate.paths))], [
    'fixtures/live.json',
  ]);
});
