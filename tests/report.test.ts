import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderReport, writeReport } from '../src/report.ts';
import type { RunReport } from '../src/types.ts';

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    version: 1,
    id: 'run-2026-09-06',
    name: 'Next build failure',
    createdAt: '2026-09-06T10:15:00.000Z',
    status: 'complete',
    stopReason: 'Search completed within budget.',
    command: ['npm', 'run', 'build'],
    oracle: {
      exitCode: 1,
      allOf: ['Parsing CSS source code failed', 'Unexpected end of input'],
      noneOf: ['Cannot find module'],
    },
    runtime: {
      node: 'v24.7.0',
      npm: '11.5.1',
      platform: 'darwin',
      arch: 'arm64',
      tool: '0.1.0',
    },
    adapter: {
      name: 'next',
      version: '16.3.4',
      router: 'app',
      entrypoints: ['src/app/page.tsx'],
      protectedPaths: ['package.json'],
      warnings: [],
    },
    initial: { files: 18, bytes: 96_400, sourceBytes: 71_200, dependencies: 6 },
    current: { files: 5, bytes: 12_700, sourceBytes: 8_300, dependencies: 3 },
    evaluations: 42,
    elapsedMs: 91_200,
    baseline: { completed: 3, required: 3 },
    trials: [
      {
        index: 1,
        candidateHash: 'aa11bb22',
        kind: 'files',
        description: 'Remove public assets',
        paths: ['public/hero.svg'],
        status: 'reproduced',
        accepted: true,
        reason: 'Target failure reproduced twice.',
        durationMs: 2_300,
        before: { files: 18, bytes: 96_400, sourceBytes: 71_200, dependencies: 6 },
        after: { files: 17, bytes: 82_100, sourceBytes: 56_900, dependencies: 6 },
        confirmations: 2,
        diagnostics: ['Parsing CSS source code failed'],
      },
      {
        index: 2,
        candidateHash: 'cc33dd44',
        kind: 'syntax',
        description: 'Remove the target rule',
        paths: ['src/app/repro.css'],
        status: 'absent',
        accepted: false,
        reason: 'Required diagnostic disappeared.',
        durationMs: 1_800,
        before: { files: 17, bytes: 82_100, sourceBytes: 56_900, dependencies: 6 },
        after: { files: 17, bytes: 82_020, sourceBytes: 56_820, dependencies: 6 },
        confirmations: 0,
        diagnostics: ['Build completed successfully'],
      },
    ],
    files: [
      { path: 'src/app/repro.css', bytes: 204 },
      { path: 'src/app/page.tsx', bytes: 412 },
      { path: 'package.json', bytes: 520 },
    ],
    excluded: [{ path: '.env.local', reason: 'Credential-bearing environment file' }],
    warnings: ['Review the retained fixture before sharing.'],
    verification: {
      status: 'verified',
      runs: 3,
      reason: 'The exported snapshot reproduced in a fresh directory.',
      snapshotHash: 'ff00ee11',
      environment: 'fresh-directory',
    },
    reviewFindings: [
      { path: 'src/config.ts', kind: 'local-path', message: 'Review an absolute local path.' },
    ],
    ...overrides,
  };
}

test('baseline labels use completed evidence rather than later lifecycle status', () => {
  for (const completed of [0, 1, 2]) {
    const html = renderReport(report({ status: 'paused', trials: [], baseline: { completed, required: 3 } }));
    assert.match(html, new RegExp(`Incomplete \\(${completed}/3\\)`));
    assert(!html.includes('<span>Established'));
  }
  const failedExport = renderReport(report({ status: 'failed', trials: [], baseline: { completed: 3, required: 3 } }));
  assert.match(failedExport, /Established \(3\/3\)/);
});

test('renderReport escapes hostile report fields without exposing executable markup', () => {
  const hostile = '</script><script>globalThis.reportPwned=true</script><img src=x onerror=alert(1)>';
  const rawDiagnostic = 'RAW_DIAGNOSTIC_SHOULD_NOT_APPEAR';
  const value = report({
    name: hostile,
    command: ['node', hostile],
    files: [{ path: `src/${hostile}.tsx`, bytes: 17 }],
    warnings: [hostile],
    trials: [{ ...report().trials[0]!, description: hostile, diagnostics: [rawDiagnostic] }],
  });

  const html = renderReport(value);
  assert.doesNotMatch(html, /<script>globalThis\.reportPwned/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;globalThis\.reportPwned/);
  assert.match(html, /src\/&lt;\/script&gt;/);
  assert.doesNotMatch(html, new RegExp(rawDiagnostic));
  assert.match(html, /Raw execution output is not embedded/);
});

test('renderReport presents verification first and exposes accessible evidence controls', () => {
  const html = renderReport(report());

  assert.ok(html.indexOf('id="verification"') < html.indexOf('id="result"'));
  assert.doesNotMatch(html, /THESIS:|seed 9572d1b4/);
  assert.match(html, /Next build failure/);
  assert.match(html, /96\.4 kB/);
  assert.match(html, /12\.7 kB/);
  assert.match(html, /Fresh verification passed/);
  assert.match(html, /aria-label="Evidence path"/);
  assert.match(html, /Baseline[\s\S]*Reduction[\s\S]*Fresh verification/);
  assert.match(html, /<input[^>]+id="trial-search"[^>]+aria-controls="trial-list"/);
  assert.match(html, /data-trial-filter="accepted"[^>]+aria-pressed="true"/);
  assert.match(html, /data-trial-filter="rejected"[^>]+aria-pressed="true"/);
  assert.match(html, /data-trial-filter="invalid"[^>]+aria-pressed="true"/);
  assert.match(html, /<input[^>]+id="file-search"[^>]+aria-controls="file-list"/);
  assert.match(html, /<details[^>]+class="trial-detail"/);
  assert.match(html, /data-copy-command/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /src\/app\/repro\.css/);
  assert.match(html, /Review the retained fixture before sharing\./);
});

test('renderReport keeps a large discarded history compact without removing trial evidence', () => {
  const rejected = report().trials[1]!;
  const trials = Array.from({ length: 83 }, (_, index) => ({
    ...rejected,
    index: index + 1,
    candidateHash: `discarded-${index + 1}`,
  }));

  const html = renderReport(report({ trials }));

  assert.match(html, /<strong>83<\/strong> discarded branches/);
  assert.equal(html.match(/<article class="trial" data-trial-entry/g)?.length, 83);
  assert.doesNotMatch(html, /class="branch-yard"/);
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /\.route-node \{[^}]*min-width:0/);
  assert.match(html, /\.filter-button \{[^}]*min-height:44px/);
  assert.doesNotMatch(html, /prefers-reduced-motion/);
});

test('renderReport labels paused, failed verification, and no-reduction states honestly', () => {
  const html = renderReport(
    report({
      status: 'paused',
      stopReason: 'Evaluation budget reached.',
      current: { files: 18, bytes: 96_400, sourceBytes: 71_200, dependencies: 6 },
      trials: [],
      files: [],
      verification: {
        status: 'failed',
        runs: 1,
        reason: 'Fresh install did not complete.',
        snapshotHash: 'bad00bad',
        environment: 'fresh-directory',
      },
    }),
  );

  assert.match(html, /Run paused/);
  assert.match(html, /Fresh verification failed/);
  assert.match(html, /No reduction accepted/);
  assert.match(html, /No trials recorded/);
  assert.match(html, /No retained files recorded/);
  assert.match(html, /Evaluation budget reached\./);
});

test('writeReport writes self-contained HTML and omits raw diagnostics from JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = report();

  await writeReport(value, directory);

  const html = await readFile(join(directory, 'report.html'), 'utf8');
  const json = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.match(html, /<script>[\s\S]+<\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.deepEqual(json, { ...value, trials: value.trials.map(trial => ({ ...trial, diagnostics: [] })) });
});

test('report API also removes private setup errors from failure summaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-report-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateOutput = 'PRIVATE_SETUP_STDERR_8492';
  const value = report({ status: 'failed', stopReason: privateOutput, verification: { ...report().verification, status: 'failed', reason: privateOutput } });
  assert(!renderReport(value).includes(privateOutput));
  await writeReport(value, directory);
  assert(!(await readFile(join(directory, 'report.json'), 'utf8')).includes(privateOutput));
  assert.equal(value.stopReason, privateOutput, 'Projection does not erase original private evidence');
});
