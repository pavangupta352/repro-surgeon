import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig, parseConfig } from '../src/config.ts';

const minimum = {
  command: ['npm', 'run', 'build'],
  oracle: { exitCode: 1, allOf: ['ReferenceError: targetMarker'] },
};

test('parseConfig applies every documented nested default', () => {
  assert.deepEqual(parseConfig(minimum), {
    version: 1,
    name: 'reproduction',
    command: ['npm', 'run', 'build'],
    oracle: { exitCode: 1, allOf: ['ReferenceError: targetMarker'], noneOf: [] },
    adapter: 'auto',
    budget: { maxEvaluations: 200, maxSeconds: 900 },
    runs: { baseline: 3, candidate: 2, final: 3 },
    execution: {
      timeoutMs: 60_000,
      maxOutputBytes: 1_048_576,
      installTimeoutMs: 120_000,
      allowInstallScripts: false,
      env: [],
    },
    reduce: { files: true, syntax: true, json: true, dependencies: true },
    include: [],
    exclude: [],
    preserve: [],
  });
});

test('parseConfig accepts explicit supported values without sharing input arrays', () => {
  const input = {
    version: 1,
    name: 'next build crash',
    command: ['node', 'failure.js'],
    oracle: { exitCode: 7, allOf: ['target'], noneOf: ['different'] },
    adapter: 'next',
    budget: { maxEvaluations: 9, maxSeconds: 10 },
    runs: { baseline: 4, candidate: 3, final: 5 },
    execution: {
      timeoutMs: 1_500,
      maxOutputBytes: 2_048,
      installTimeoutMs: 9_000,
      allowInstallScripts: true,
      env: ['PATH', 'PUBLIC_FLAG'],
    },
    reduce: { files: false, syntax: true, json: false, dependencies: true },
    include: ['fixtures/**'],
    exclude: ['large/**'],
    preserve: ['LICENSE'],
  } as const;

  const config = parseConfig(input);
  assert.deepEqual(config, input);
  assert.notStrictEqual(config.command, input.command);
  assert.notStrictEqual(config.oracle.allOf, input.oracle.allOf);
});

test('parseConfig preserves an intentionally empty non-executable argv item', () => {
  const config = parseConfig({ ...minimum, command: ['node', 'script.js', ''] });
  assert.deepEqual(config.command, ['node', 'script.js', '']);
});

test('parseConfig rejects unknown fields at every object level', () => {
  const cases: unknown[] = [
    { ...minimum, surprise: true },
    { ...minimum, oracle: { ...minimum.oracle, surprise: true } },
    { ...minimum, budget: { surprise: true } },
    { ...minimum, runs: { surprise: true } },
    { ...minimum, execution: { surprise: true } },
    { ...minimum, reduce: { surprise: true } },
  ];

  for (const input of cases) {
    assert.throws(() => parseConfig(input), /unknown field/i);
  }
});

test('parseConfig rejects unsafe numeric values and run counts below confirmation minimums', () => {
  const cases: unknown[] = [
    { ...minimum, oracle: { ...minimum.oracle, exitCode: -1 } },
    { ...minimum, oracle: { ...minimum.oracle, exitCode: 256 } },
    { ...minimum, budget: { maxEvaluations: 0 } },
    { ...minimum, budget: { maxSeconds: Number.NaN } },
    { ...minimum, runs: { baseline: 2 } },
    { ...minimum, runs: { candidate: 1 } },
    { ...minimum, runs: { final: 2 } },
    { ...minimum, execution: { timeoutMs: 0 } },
    { ...minimum, execution: { maxOutputBytes: 1.5 } },
    { ...minimum, execution: { installTimeoutMs: Number.MAX_SAFE_INTEGER + 1 } },
  ];

  for (const input of cases) {
    assert.throws(() => parseConfig(input), /must be/i);
  }
});

test('parseConfig rejects missing, empty, and NUL-containing commands and targets', () => {
  const cases: unknown[] = [
    { oracle: minimum.oracle },
    { ...minimum, command: [] },
    { ...minimum, command: [''] },
    { ...minimum, command: ['   '] },
    { ...minimum, command: ['node', 'bad\0argument'] },
    { ...minimum, oracle: { exitCode: 1, allOf: [] } },
    { ...minimum, oracle: { exitCode: 1, allOf: [''] } },
    { ...minimum, oracle: { exitCode: 1, allOf: ['   '] } },
    { ...minimum, oracle: { exitCode: 1, allOf: ['bad\0target'] } },
    { ...minimum, oracle: { exitCode: 1, allOf: ['target'], noneOf: [''] } },
  ];

  for (const input of cases) {
    assert.throws(() => parseConfig(input), /command|target|allOf|noneOf/i);
  }
});

test('parseConfig rejects malformed environment names and non-boolean reducer options', () => {
  assert.throws(
    () => parseConfig({ ...minimum, execution: { env: ['OK', 'BAD=VALUE'] } }),
    /environment variable/i,
  );
  assert.throws(
    () => parseConfig({ ...minimum, reduce: { files: 'yes' } }),
    /boolean/i,
  );
});

test('loadConfig reads JSON and applies validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-config-'));
  try {
    const validPath = join(directory, 'valid.json');
    await writeFile(validPath, JSON.stringify(minimum));
    assert.equal((await loadConfig(validPath)).name, 'reproduction');

    const invalidPath = join(directory, 'invalid.json');
    await writeFile(invalidPath, '{ definitely not JSON');
    await assert.rejects(loadConfig(invalidPath), /invalid JSON/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
