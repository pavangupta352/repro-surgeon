import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraph, detectAdapter } from '../src/graph.ts';
import type { Snapshot } from '../src/types.ts';

function snapshot(files: Record<string, string>): Snapshot {
  return new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      { content: Buffer.from(content), mode: 0o644 },
    ]),
  );
}

test('adapters protect conventional and nested legal filenames', () => {
  const names = ['LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE_MIT', 'THIRD_PARTY_NOTICES.txt', 'legal/COPYING-THIRD-PARTY', 'LICENSES/BSD-2-Clause.txt'];
  const input = snapshot(Object.fromEntries([['package.json', '{"name":"case"}'], ...names.map(name => [name, 'Legal terms'])]));
  for (const adapter of ['generic', 'auto', 'next'] as const) {
    const result = detectAdapter(input, adapter);
    for (const name of names) assert(result.protectedPaths.includes(name), `${adapter}: ${name}`);
  }
});

test('buildGraph resolves static, dynamic, require, re-export, and tsconfig alias imports', () => {
  const graph = buildGraph(
    snapshot({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@lib/*': ['src/lib/*'] } },
      }),
      'src/main.ts': `
import primary, { value as renamed } from '@/utils';
import { feature } from './feature.js';
export { shared } from '@lib/shared';
const lazy = import('./lazy');
const packageValue = require('external-package');
import('./missing');
void [primary, renamed, feature, shared, lazy, packageValue];
`,
      'src/utils.ts': 'export default 1; export const value = 2;',
      'src/feature.ts': 'export const feature = 1;',
      'src/lazy/index.tsx': 'export default <p>lazy</p>;',
      'src/lib/shared.ts': 'export const shared = 1;',
    }),
  );

  assert.deepEqual(graph.imports['src/main.ts'], [
    'src/feature.ts',
    'src/lazy/index.tsx',
    'src/lib/shared.ts',
    'src/utils.ts',
  ]);
  assert.deepEqual(graph.external['src/main.ts'], ['external-package']);
  assert.deepEqual(graph.unresolved['src/main.ts'], ['./missing']);
});

test('buildGraph skips malformed source and returns stable empty records for valid source files', () => {
  const graph = buildGraph(
    snapshot({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const = ;',
    }),
  );

  assert.deepEqual(graph, {
    imports: { 'src/a.ts': [] },
    external: { 'src/a.ts': [] },
    unresolved: { 'src/a.ts': [] },
  });
});

test('detectAdapter inventories mixed Next routers, version, entrypoints, and protected files', () => {
  const info = detectAdapter(
    snapshot({
      'package.json': JSON.stringify({ dependencies: { next: '^15.4.2' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      'LICENSE': 'MIT',
      'NOTICE.md': 'third party notices',
      'next.config.mjs': 'export default {};',
      'src/app/layout.tsx': 'export default function Layout({children}) { return children; }',
      'src/app/page.tsx': 'export default function Page() { return null; }',
      'src/app/api/health/route.ts': 'export function GET() {}',
      'src/middleware.ts': 'export function middleware() {}',
      'proxy.ts': 'export function proxy() {}',
      'pages/_app.tsx': 'export default function App({Component, pageProps}) { return <Component {...pageProps}/>; }',
      'pages/index.tsx': 'export default function Home() { return null; }',
      'src/lib/helper.ts': 'export const helper = 1;',
    }),
    'auto',
  );

  assert.equal(info.name, 'next');
  assert.equal(info.version, '^15.4.2');
  assert.equal(info.router, 'mixed');
  assert.deepEqual(info.entrypoints, [
    'pages/_app.tsx',
    'pages/index.tsx',
    'proxy.ts',
    'src/app/api/health/route.ts',
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'src/middleware.ts',
  ]);
  for (const path of [
    'LICENSE',
    'NOTICE.md',
    'next.config.mjs',
    'package-lock.json',
    'package.json',
    ...info.entrypoints,
  ]) {
    assert.ok(info.protectedPaths.includes(path), `${path} should be protected`);
  }
  assert.ok(info.warnings.some((warning) => warning.includes('both App and Pages')));
});

test('detectAdapter honors explicit generic choice and warns when forced Next lacks its dependency', () => {
  const files = snapshot({
    'package.json': '{"name":"plain"}',
    'app/page.tsx': 'export default function Page() { return null; }',
  });

  const generic = detectAdapter(files, 'generic');
  assert.equal(generic.name, 'generic');
  assert.equal(generic.router, 'none');
  assert.deepEqual(generic.entrypoints, []);

  const forced = detectAdapter(files, 'next');
  assert.equal(forced.name, 'next');
  assert.equal(forced.router, 'app');
  assert.ok(forced.warnings.some((warning) => warning.includes('Next.js dependency')));
});
