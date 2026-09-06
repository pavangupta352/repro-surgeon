import { readFile } from 'node:fs/promises';

import type { Config, Oracle } from './types.ts';

const DEFAULTS = {
  name: 'reproduction',
  adapter: 'auto' as const,
  budget: { maxEvaluations: 200, maxSeconds: 900 },
  runs: { baseline: 3, candidate: 2, final: 3 },
  execution: {
    timeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    installTimeoutMs: 120_000,
    allowInstallScripts: false,
    env: [] as string[],
  },
  reduce: { files: true, syntax: true, json: true, dependencies: true },
} as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedFields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw new TypeError(`Unknown field ${path}.${key}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function commandArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('config.command must be a non-empty array of argv strings');
  }
  const command = value.map((item, index) => {
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new TypeError(`config.command[${index}] must be a string without NUL bytes`);
    }
    return item;
  });
  if ((command[0] as string).trim().length === 0) {
    throw new TypeError('config.command executable must be a non-empty string');
  }
  return command;
}

function stringArray(value: unknown, path: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings`);
  }
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

function optionalRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return parent[key] === undefined ? {} : record(parent[key], key);
}

function parseOracle(value: unknown): Oracle {
  const input = record(value, 'oracle');
  rejectUnknown(input, ['exitCode', 'allOf', 'noneOf'], 'oracle');
  if (input.exitCode === undefined) throw new TypeError('oracle.exitCode must be provided');
  if (input.allOf === undefined) throw new TypeError('oracle.allOf target must be provided');

  return {
    exitCode: integer(input.exitCode, 'oracle.exitCode', 0, 255),
    allOf: stringArray(input.allOf, 'oracle.allOf target', false),
    noneOf: input.noneOf === undefined ? [] : stringArray(input.noneOf, 'oracle.noneOf', true),
  };
}

export function parseConfig(value: unknown): Config {
  const input = record(value, 'config');
  rejectUnknown(
    input,
    ['version', 'name', 'command', 'oracle', 'adapter', 'budget', 'runs', 'execution', 'reduce', 'include', 'exclude', 'preserve'],
    'config',
  );

  if (input.command === undefined) throw new TypeError('config.command must be provided');
  if (input.oracle === undefined) throw new TypeError('config.oracle target must be provided');
  if (input.version !== undefined && input.version !== 1) throw new TypeError('config.version must be 1');

  const budget = optionalRecord(input, 'budget');
  rejectUnknown(budget, ['maxEvaluations', 'maxSeconds'], 'budget');
  const runs = optionalRecord(input, 'runs');
  rejectUnknown(runs, ['baseline', 'candidate', 'final'], 'runs');
  const execution = optionalRecord(input, 'execution');
  rejectUnknown(
    execution,
    ['timeoutMs', 'maxOutputBytes', 'installTimeoutMs', 'allowInstallScripts', 'env'],
    'execution',
  );
  const reduce = optionalRecord(input, 'reduce');
  rejectUnknown(reduce, ['files', 'syntax', 'json', 'dependencies'], 'reduce');

  const adapter = input.adapter ?? DEFAULTS.adapter;
  if (adapter !== 'auto' && adapter !== 'next' && adapter !== 'generic') {
    throw new TypeError('config.adapter must be auto, next, or generic');
  }

  const environment = execution.env === undefined
    ? []
    : stringArray(execution.env, 'execution.env', true);
  for (const name of environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`execution.env contains invalid environment variable name: ${name}`);
    }
  }

  return {
    version: 1,
    name: input.name === undefined ? DEFAULTS.name : text(input.name, 'config.name'),
    command: commandArray(input.command),
    oracle: parseOracle(input.oracle),
    adapter,
    budget: {
      maxEvaluations: budget.maxEvaluations === undefined
        ? DEFAULTS.budget.maxEvaluations
        : integer(budget.maxEvaluations, 'budget.maxEvaluations', 1),
      maxSeconds: budget.maxSeconds === undefined
        ? DEFAULTS.budget.maxSeconds
        : integer(budget.maxSeconds, 'budget.maxSeconds', 1),
    },
    runs: {
      baseline: runs.baseline === undefined
        ? DEFAULTS.runs.baseline
        : integer(runs.baseline, 'runs.baseline', DEFAULTS.runs.baseline),
      candidate: runs.candidate === undefined
        ? DEFAULTS.runs.candidate
        : integer(runs.candidate, 'runs.candidate', DEFAULTS.runs.candidate),
      final: runs.final === undefined
        ? DEFAULTS.runs.final
        : integer(runs.final, 'runs.final', DEFAULTS.runs.final),
    },
    execution: {
      timeoutMs: execution.timeoutMs === undefined
        ? DEFAULTS.execution.timeoutMs
        : integer(execution.timeoutMs, 'execution.timeoutMs', 1),
      maxOutputBytes: execution.maxOutputBytes === undefined
        ? DEFAULTS.execution.maxOutputBytes
        : integer(execution.maxOutputBytes, 'execution.maxOutputBytes', 1),
      installTimeoutMs: execution.installTimeoutMs === undefined
        ? DEFAULTS.execution.installTimeoutMs
        : integer(execution.installTimeoutMs, 'execution.installTimeoutMs', 1),
      allowInstallScripts: execution.allowInstallScripts === undefined
        ? DEFAULTS.execution.allowInstallScripts
        : boolean(execution.allowInstallScripts, 'execution.allowInstallScripts'),
      env: [...new Set(environment)],
    },
    reduce: {
      files: reduce.files === undefined ? DEFAULTS.reduce.files : boolean(reduce.files, 'reduce.files'),
      syntax: reduce.syntax === undefined ? DEFAULTS.reduce.syntax : boolean(reduce.syntax, 'reduce.syntax'),
      json: reduce.json === undefined ? DEFAULTS.reduce.json : boolean(reduce.json, 'reduce.json'),
      dependencies: reduce.dependencies === undefined
        ? DEFAULTS.reduce.dependencies
        : boolean(reduce.dependencies, 'reduce.dependencies'),
    },
    include: input.include === undefined ? [] : stringArray(input.include, 'config.include', true),
    exclude: input.exclude === undefined ? [] : stringArray(input.exclude, 'config.exclude', true),
    preserve: input.preserve === undefined ? [] : stringArray(input.preserve, 'config.preserve', true),
  };
}

export async function loadConfig(path: string): Promise<Config> {
  const source = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`Invalid JSON in ${path}: ${message}`);
  }
  return parseConfig(value);
}
