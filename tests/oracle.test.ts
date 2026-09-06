import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateOracle } from '../src/oracle.ts';
import { runCommand } from '../src/runner.ts';
import type { CommandResult, Oracle } from '../src/types.ts';

const oracle: Oracle = {
  exitCode: 7,
  allOf: ['ReferenceError: targetMarker', 'app/page.tsx'],
  noneOf: ['Cannot find module'],
};

function execution(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 7,
    signal: null,
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
    stdout: '',
    stderr: 'ReferenceError: targetMarker\n    at app/page.tsx:4:2\n',
    durationMs: 5,
    ...overrides,
  };
}

test('evaluateOracle reproduces only the exact exit and every required literal', () => {
  const result = evaluateOracle(execution(), oracle);
  assert.equal(result.status, 'reproduced');
  assert.deepEqual(result.matched, ['ReferenceError: targetMarker', 'app/page.tsx']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.forbidden, []);
});

test('evaluateOracle strips ANSI control sequences before literal matching and diagnostics', () => {
  const result = evaluateOracle(
    execution({ stderr: '\u001b[31mReferenceError: targetMarker\u001b[0m\n\u001b]0;title\u0007app/page.tsx' }),
    oracle,
  );
  assert.equal(result.status, 'reproduced');
  assert.ok(result.diagnostics.every((line) => !line.includes('\u001b')));
});

test('evaluateOracle marks a same-exit different failure absent', () => {
  const result = evaluateOracle(execution({ stderr: 'TypeError: unrelated\n' }), oracle);
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.missing, ['ReferenceError: targetMarker', 'app/page.tsx']);
});

test('evaluateOracle marks forbidden output absent even when target literals match', () => {
  const result = evaluateOracle(
    execution({ stderr: 'ReferenceError: targetMarker at app/page.tsx\nCannot find module x' }),
    oracle,
  );
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.forbidden, ['Cannot find module']);
});

test('evaluateOracle marks an unexpected normal exit absent', () => {
  const result = evaluateOracle(execution({ exitCode: 1 }), oracle);
  assert.equal(result.status, 'absent');
  assert.match(result.reason, /exit code/i);
});

test('evaluateOracle treats unevaluable executions as invalid before matching output', () => {
  const cases: Partial<CommandResult>[] = [
    { error: 'spawn ENOENT', exitCode: null },
    { timedOut: true, exitCode: null },
    { aborted: true, exitCode: null },
    { outputLimitExceeded: true, exitCode: null },
    { signal: 'SIGTERM', exitCode: null },
    { exitCode: null },
  ];

  for (const candidate of cases) {
    assert.equal(evaluateOracle(execution(candidate), oracle).status, 'invalid');
  }
});

test('actual child target output reproduces while another error does not', async () => {
  const options = { cwd: process.cwd(), timeoutMs: 2_000, maxOutputBytes: 8_192 };
  const target = await runCommand(
    [process.execPath, '-e', "process.stderr.write('ReferenceError: targetMarker at app/page.tsx\\n');process.exit(7)"],
    options,
  );
  const other = await runCommand(
    [process.execPath, '-e', "process.stderr.write('TypeError: other at app/page.tsx\\n');process.exit(7)"],
    options,
  );

  assert.equal(evaluateOracle(target, oracle).status, 'reproduced');
  assert.equal(evaluateOracle(other, oracle).status, 'absent');
});
