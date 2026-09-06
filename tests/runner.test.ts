import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanEnvironment, runCommand } from '../src/runner.ts';

const cwd = process.cwd();

function nodeCommand(source: string, ...args: string[]): string[] {
  return [process.execPath, '-e', source, ...args];
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('runCommand preserves spaces and shell metacharacters as literal argv', async () => {
  const marker = join(tmpdir(), `repro-shell-marker-${process.pid}`);
  await rm(marker, { force: true });
  const args = ['two words', '', `$(touch ${marker})`, '; echo injected', '*.ts'];
  const result = await runCommand(
    nodeCommand("process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args),
    { cwd, timeoutMs: 2_000, maxOutputBytes: 8_192 },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  await assert.rejects(access(marker));
});

test('runCommand captures chunked stdout and stderr with the actual exit code', async () => {
  const result = await runCommand(
    nodeCommand(
      "process.stdout.write('out-1');setTimeout(()=>{process.stdout.write('-out-2');process.stderr.write('err-1');setTimeout(()=>{process.stderr.write('-err-2');process.exit(7)},10)},10)",
    ),
    { cwd, timeoutMs: 2_000, maxOutputBytes: 8_192 },
  );

  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'out-1-out-2');
  assert.equal(result.stderr, 'err-1-err-2');
  assert.equal(result.timedOut, false);
});

test('runCommand returns a spawn error for a missing executable', async () => {
  const result = await runCommand(
    [`definitely-missing-repro-command-${process.pid}`],
    { cwd, timeoutMs: 2_000, maxOutputBytes: 8_192 },
  );

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? '', /ENOENT|not found/i);
});

test('runCommand bounds combined output and terminates an output flood', async () => {
  const result = await runCommand(
    nodeCommand("const block='x'.repeat(4096);setInterval(()=>{process.stdout.write(block);process.stderr.write(block)},0)"),
    { cwd, timeoutMs: 3_000, maxOutputBytes: 1_024 },
  );

  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1_024);
  assert.equal(result.exitCode, null);
});

test('runCommand times out and terminates the process', async () => {
  const result = await runCommand(
    nodeCommand('setInterval(()=>{},1000)'),
    { cwd, timeoutMs: 80, maxOutputBytes: 8_192 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.exitCode, null);
});

test('runCommand honors AbortSignal and terminates the process', async () => {
  const controller = new AbortController();
  const pending = runCommand(
    nodeCommand('setInterval(()=>{},1000)'),
    { cwd, timeoutMs: 2_000, maxOutputBytes: 8_192, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  const result = await pending;

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
});

test('runCommand does not start a command when its signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand(
    nodeCommand("process.stdout.write('started')"),
    { cwd, timeoutMs: 2_000, maxOutputBytes: 8_192, signal: controller.signal },
  );

  assert.equal(result.aborted, true);
  assert.equal(result.stdout, '');
  assert.equal(result.exitCode, null);
});

test('runCommand cleans up a grandchild after its parent exits', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-grandchild-exit-'));
  const marker = join(directory, 'survived');
  try {
    const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),450)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}).unref()`;
    const result = await runCommand(nodeCommand(parent), {
      cwd,
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
    });
    assert.equal(result.exitCode, 0);
    await delay(650);
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runCommand preserves the direct exit while killing a worker holding inherited output pipes', { skip: process.platform === 'win32', timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-inherited-pipes-'));
  const pidFile = join(directory, 'worker.pid');
  try {
    const worker = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');setInterval(()=>{},1000)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{child.disconnect();child.unref();process.stdout.write('TARGET');process.exitCode=1})`;
    const result = await runCommand(nodeCommand(parent), { cwd, timeoutMs: 500, maxOutputBytes: 8_192 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, 'TARGET');
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.ok(result.durationMs < 450, `Cleanup took ${result.durationMs} ms`);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already terminated. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test('runCommand bounds output draining when a detached worker escapes its process group', { skip: process.platform === 'win32', timeout: 3_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-escaped-pipes-'));
  const pidFile = join(directory, 'worker.pid');
  const killWorker = async (): Promise<void> => {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already terminated. */ }
  };
  const safetyCleanup = setTimeout(() => void killWorker(), 1_200);
  try {
    const worker = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');setInterval(()=>{},1000)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{child.disconnect();child.unref();process.stdout.write('TARGET');process.exitCode=1})`;
    const result = await runCommand(nodeCommand(parent), { cwd, timeoutMs: 500, maxOutputBytes: 8_192 });
    assert.ok(result.durationMs < 1_000, `Output draining took ${result.durationMs} ms`);
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'TARGET');
    assert.match(result.error ?? '', /output.*(?:pipe|close)|(?:pipe|close).*output/i);
  } finally {
    clearTimeout(safetyCleanup);
    await killWorker();
    await rm(directory, { recursive: true, force: true });
  }
});

test('execution timeout and cancellation cannot invalidate an exit already in cleanup', { skip: process.platform === 'win32', timeout: 3_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-cleanup-deadline-'));
  const pidFile = join(directory, 'worker.pid');
  const cleanupMarker = join(directory, 'cleanup-started');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const worker = `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(cleanupMarker)},'started'));fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');setInterval(()=>{},1000)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>{child.disconnect();child.unref();process.stdout.write('TARGET');process.exitCode=1})`;
    const controller = new AbortController();
    const pending = runCommand(nodeCommand(parent), { cwd, timeoutMs: 1_000, maxOutputBytes: 8_192, signal: controller.signal });
    const markerDeadline = Date.now() + 1_500;
    for (;;) {
      try { await access(cleanupMarker); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert.ok(Date.now() < markerDeadline, 'Cleanup did not begin after direct-child exit');
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    controller.abort();
    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, 'TARGET');
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
  } finally {
    t.mock.timers.reset();
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch { /* Already terminated. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cause of ['timeout', 'abort'] as const) {
  test(`runCommand retains ${cause} invalidation when the child handles termination with a normal exit`, { skip: process.platform === 'win32' }, async () => {
    const controller = new AbortController();
    const pending = runCommand(nodeCommand("process.on('SIGTERM',()=>{process.stdout.write('TARGET');process.exit(1)});setInterval(()=>{},1000)"), {
      cwd,
      timeoutMs: cause === 'timeout' ? 200 : 2_000,
      maxOutputBytes: 8_192,
      signal: controller.signal,
    });
    if (cause === 'abort') setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, 'TARGET');
    assert.equal(result.timedOut, cause === 'timeout');
    assert.equal(result.aborted, cause === 'abort');
  });
}

test('runCommand cleans up a grandchild on timeout', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-grandchild-timeout-'));
  const marker = join(directory, 'survived');
  try {
    const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),450);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const result = await runCommand(nodeCommand(parent), {
      cwd,
      timeoutMs: 80,
      maxOutputBytes: 8_192,
    });
    assert.equal(result.timedOut, true);
    await delay(650);
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runCommand cleans up a grandchild on abort', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'repro-grandchild-abort-'));
  const marker = join(directory, 'survived');
  try {
    const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),450);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const pending = runCommand(nodeCommand(parent), {
      cwd,
      timeoutMs: 2_000,
      maxOutputBytes: 8_192,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    const result = await pending;
    assert.equal(result.aborted, true);
    await delay(650);
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanEnvironment isolates home and npm config and inherits only essentials plus allowlisted names', () => {
  const original = {
    PUBLIC_FLAG: process.env.PUBLIC_FLAG,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
  };
  process.env.PUBLIC_FLAG = 'visible';
  process.env.GITHUB_TOKEN = 'implicit-secret';
  process.env.NPM_TOKEN = 'implicit-npm-secret';

  try {
    const home = join(tmpdir(), 'repro-owned-home');
    const env = cleanEnvironment(home, ['PUBLIC_FLAG']);
    assert.equal(env.HOME, home);
    assert.equal(env.USERPROFILE, home);
    assert.equal(env.PUBLIC_FLAG, 'visible');
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.NPM_CONFIG_USERCONFIG, join(home, '.npmrc'));
    assert.equal(env.NPM_CONFIG_CACHE, join(home, '.npm-cache'));
    if (process.env.PATH !== undefined) assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
