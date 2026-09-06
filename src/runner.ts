import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { CommandResult, RunOptions } from './types.ts';

const ESSENTIAL_ENVIRONMENT = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
] as const;

const PROTECTED_ENVIRONMENT = new Set([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_CACHE',
]);

export function cleanEnvironment(home: string, names: string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [...ESSENTIAL_ENVIRONMENT, ...names]) {
    if (PROTECTED_ENVIRONMENT.has(name)) continue;
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.XDG_CONFIG_HOME = join(home, '.config');
  environment.XDG_CACHE_HOME = join(home, '.cache');
  environment.XDG_DATA_HOME = join(home, '.local', 'share');
  environment.NPM_CONFIG_USERCONFIG = join(home, '.npmrc');
  environment.NPM_CONFIG_CACHE = join(home, '.npm-cache');
  return environment;
}

function emptyResult(startedAt: number, flags: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    outputLimitExceeded: false,
    stdout: '',
    stderr: '',
    durationMs: Math.max(0, performance.now() - startedAt),
    ...flags,
  };
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process tree may have already exited.
  }
}

async function cleanRemainingProcessGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || process.platform === 'win32' || !groupExists(child.pid)) return;
  signalProcessTree(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (groupExists(child.pid)) signalProcessTree(child, 'SIGKILL');
}

export async function runCommand(command: string[], options: RunOptions): Promise<CommandResult> {
  const startedAt = performance.now();
  if (options.signal?.aborted === true) {
    return emptyResult(startedAt, { aborted: true, error: 'Command was aborted before launch' });
  }
  if (
    command.length === 0
    || (command[0] as string | undefined)?.trim().length === 0
    || command.some((part) => typeof part !== 'string' || part.includes('\0'))
  ) {
    return emptyResult(startedAt, { error: 'Command must contain a non-empty executable and argv strings without NUL bytes' });
  }

  return await new Promise<CommandResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let commandError: string | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let cleanup: Promise<void> | undefined;
    let termination: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;

    const executable = command[0] as string;
    const child = spawn(executable, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const requestStop = (): void => {
      signalProcessTree(child, 'SIGTERM');
      forceKillTimer ??= setTimeout(() => signalProcessTree(child, 'SIGKILL'), 100);
    };

    const retain = (destination: Buffer[], chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, options.maxOutputBytes - retainedBytes);
      if (remaining > 0) {
        const saved = data.length <= remaining ? data : data.subarray(0, remaining);
        destination.push(saved);
        retainedBytes += saved.length;
      }
      if (data.length > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        requestStop();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => retain(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => retain(stderr, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      requestStop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const beginCleanup = (): Promise<void> => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      cleanup ??= cleanRemainingProcessGroup(child);
      return cleanup;
    };

    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      if (settled) return;
      settled = true;
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      await beginCleanup();
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);

      const invalidated = timedOut || aborted || outputLimitExceeded || commandError !== undefined;
      const result: CommandResult = {
        exitCode: invalidated ? null : (termination?.exitCode ?? exitCode),
        signal: termination?.signal ?? signal,
        timedOut,
        aborted,
        outputLimitExceeded,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Math.max(0, performance.now() - startedAt),
      };
      if (commandError !== undefined) result.error = commandError;
      resolve(result);
    };

    child.once('error', (error) => {
      commandError = error.message;
      setImmediate(() => void finish(null, null));
    });
    child.once('exit', (exitCode, signal) => {
      termination = { exitCode, signal };
      // Descendants may retain the output pipes after the direct child exits.
      // Execution is over; stop its timer and clean the group before close.
      void beginCleanup().then(() => {
        if (settled) return;
        drainTimer = setTimeout(() => {
          commandError ??= 'Command output pipes did not close after process cleanup';
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 250);
      });
    });
    child.once('close', (exitCode, signal) => void finish(exitCode, signal));
  });
}
