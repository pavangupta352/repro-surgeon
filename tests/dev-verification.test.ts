import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const adapter = () => import(new URL('../scripts/verification/evidence.mjs', import.meta.url).href);

async function fixture(t: test.TestContext, scripts: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'surgeon-dev-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['src', 'tests/fixtures', 'docs', 'scripts']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.local/\ndist/\nnode_modules/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'owned-development-verification-fixture', version: '1.0.0', private: true, type: 'module',
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      test: 'node --test tests/*.test.mjs',
      build: 'node -e "process.exit(0)"',
      'test:package': 'node --test tests/*.test.mjs',
      ...scripts,
    },
  }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'tests/value.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('owned fixture passes', () => assert.equal(value, 1));\n");
  await writeFile(path.join(root, 'tests/fixtures/input.txt'), 'fixture input\n');
  await writeFile(path.join(root, 'docs/guide.md'), '# Development input\n');
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  await git('init', '-q', '--template=');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'owned fixture');
  return root;
}

function recordedCheck(result: any, id: string) {
  const check = result.record?.checks.find((entry: any) => entry.id === id);
  assert(check, `Expected a persisted ${id} result`);
  return check;
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(filename));
    else result.push(filename);
  }
  return result;
}

async function waitForFile(filename: string, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { await stat(filename); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('Owned fixture did not signal that its command started');
}

test('successful development checks remain fresh when their inputs are unchanged', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  const result = await runVerification(root);
  assert.equal(result.status, 'fresh', JSON.stringify(result.checks));
  assert.deepEqual(result.checks.map((check: any) => check.id), ['typecheck', 'test', 'build']);
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.equal(result.record.before.head, head, 'Evidence must retain the full checkout commit');
  for (const id of ['typecheck', 'test', 'build']) assert.equal(recordedCheck(result, id).result.exitCode, 0);
  assert.equal((await readVerification(root)).status, 'fresh');
  const stored = JSON.parse(await readFile(path.join(root, '.local/dev-verification/latest.json'), 'utf8'));
  assert(stored && typeof stored === 'object');
  const logFiles = (await filesBelow(path.join(root, '.local/dev-verification/runs'))).filter(file => file.endsWith('.log'));
  assert(logFiles.length > 0, 'Full check output should be stored in bounded logs');
  assert.equal(typeof recordedCheck(result, 'test').result.stdout, 'undefined');
  assert.equal(typeof recordedCheck(result, 'test').result.stderr, 'undefined');
});

test('an inherited TAP reporter remains runnable and preserves unrelated Node options', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'tests/value.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('caller options reach the real test process', () => assert.match(process.env.NODE_OPTIONS ?? '', /(?:^|\\s)--no-warnings(?:\\s|$)/));\n");
  const { runVerification, readVerification } = await adapter();
  const previousOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--no-warnings --test-reporter=tap';
    const result = await runVerification(root, { checks: ['test'] });
    assert.equal(recordedCheck(result, 'test').result.exitCode, 0, 'The inherited TAP reporter must not be duplicated');
    assert.equal(result.status, 'fresh', JSON.stringify(result.checks));
    assert.equal((await readVerification(root, { checks: ['test'] })).status, 'fresh');
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
});

test('an existing spec reporter is preserved as successful but unverified test output', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  const previousOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--test-reporter=spec';
    const result = await runVerification(root, { checks: ['test'] });
    assert.equal(recordedCheck(result, 'test').result.exitCode, 0, 'Preserving the caller reporter must not break the underlying test');
    assert.equal(result.status, 'unverified');
    assert.equal((await readVerification(root, { checks: ['test'] })).status, 'unverified');
    const stdout = await readFile(path.join(root, '.local/dev-verification/runs', result.record.id, 'test.stdout.log'), 'utf8');
    assert.match(stdout, /owned fixture passes/);
    assert.doesNotMatch(stdout, /(?:^|\n)# tests \d+/);
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
});

for (const input of ['src/value.mjs', 'tests/fixtures/input.txt', 'docs/guide.md']) {
  test(`editing ${input} makes prior successful development evidence stale`, async t => {
    const root = await fixture(t);
    const { runVerification, readVerification } = await adapter();
    assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
    await writeFile(path.join(root, input), 'changed after the successful check\n');
    assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'stale');
  });
}

test('a real nonzero development command stays failed even when it prints a passing summary', async t => {
  const root = await fixture(t, { test: 'node -e "console.log(\'# pass 1\\n# fail 0\'); process.exit(7)"' });
  const { runVerification, readVerification } = await adapter();
  const result = await runVerification(root, { checks: ['test'] });
  assert.equal(result.status, 'failed');
  assert.equal(recordedCheck(result, 'test').result.exitCode, 7);
  assert.equal((await readVerification(root, { checks: ['test'] })).status, 'failed');
});

test('a passing regression can intentionally assert a target process exits seven', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'tests/value.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process'; test('expected target failure', () => { const target = spawnSync(process.execPath, ['-e', 'process.exit(7)']); assert.equal(target.status, 7); });\n");
  const { runVerification } = await adapter();
  const result = await runVerification(root, { checks: ['test'] });
  assert.equal(result.status, 'fresh');
  assert.equal(recordedCheck(result, 'test').result.exitCode, 0);
});

test('a failed compiler command cannot become fresh from exit-zero assumptions', async t => {
  const root = await fixture(t, { typecheck: 'node -e "console.error(\'compiler rejected fixture\'); process.exit(2)"' });
  const { runVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'] });
  assert.equal(result.status, 'failed');
  assert.equal(recordedCheck(result, 'typecheck').result.exitCode, 2);
});

test('a configured script that hides output and swallows failure remains unverified', async t => {
  const root = await fixture(t, { typecheck: 'node -e "process.exit(2)" >/dev/null 2>&1 || true' });
  const { runVerification, readVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'] });
  assert.equal(recordedCheck(result, 'typecheck').result.exitCode, 0, 'npm itself reports success after the shell swallows failure');
  assert.equal(result.status, 'unverified');
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('a successful trailing shell command cannot hide a failed verification command', async t => {
  const root = await fixture(t, { typecheck: 'node -e "process.exit(2)"; true' });
  const { runVerification, readVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'] });
  assert.equal(recordedCheck(result, 'typecheck').result.exitCode, 0, 'npm reports the trailing shell command status');
  assert.equal(result.status, 'unverified');
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('exit-zero test output without a recognized summary remains unverified', async t => {
  const root = await fixture(t, { test: 'node -e "console.log(\'completed without a test summary\')"' });
  const { runVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['test'] })).status, 'unverified');
});

test('a zero-test passing summary cannot establish development test coverage', async t => {
  const root = await fixture(t, { test: 'node -e "console.log(\'# tests 0\\n# pass 0\\n# fail 0\')"' });
  const { runVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['test'] })).status, 'unverified');
});

test('missing evidence is unverified without running verification commands', async t => {
  const root = await fixture(t, { typecheck: 'node -e "require(\'node:fs\').writeFileSync(\'unexpected-command\', \'ran\')"' });
  const { readVerification } = await adapter();
  assert.equal((await readVerification(root)).status, 'unverified');
  await assert.rejects(stat(path.join(root, 'unexpected-command')), { code: 'ENOENT' });
});

test('a successful subset is incomplete when the default verification set is requested', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  assert.equal((await readVerification(root)).status, 'incomplete');
});

test('aborting an actually started verification command preserves cancellation as unverified', async t => {
  const root = await fixture(t, { typecheck: 'node scripts/slow.mjs' });
  await writeFile(path.join(root, 'scripts/slow.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.local', { recursive: true }); writeFileSync('.local/started', 'started'); setTimeout(() => {}, 8000);\n");
  const { runVerification } = await adapter();
  const controller = new AbortController();
  const pending = runVerification(root, { checks: ['typecheck'], signal: controller.signal });
  let result;
  try {
    await waitForFile(path.join(root, '.local/started'));
    controller.abort();
    result = await pending;
  } finally {
    controller.abort();
    await pending;
  }
  assert.equal(result.status, 'unverified');
  assert.equal(recordedCheck(result, 'typecheck').result.aborted, true);
});

test('verification deadlines are retained as unverified rather than a passing exit', async t => {
  const root = await fixture(t, { typecheck: 'node -e "setTimeout(() => {}, 8000)"' });
  const { runVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'], timeoutMs: 500 });
  assert.equal(result.status, 'unverified');
  assert.equal(recordedCheck(result, 'typecheck').result.timedOut, true);
});

test('bounded output cannot be truncated into fresh evidence', async t => {
  const root = await fixture(t, { typecheck: 'node -e "process.stdout.write(\'€\'.repeat(16384)); setTimeout(() => {}, 8000)"' });
  const { runVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'], maxOutputBytes: 1024 });
  assert.equal(result.status, 'unverified');
  assert.equal(recordedCheck(result, 'typecheck').result.outputLimitExceeded, true);
  const logs = (await filesBelow(path.join(root, '.local/dev-verification/runs'))).filter(file => file.endsWith('.log'));
  const sizes = await Promise.all(logs.map(async log => (await stat(log)).size));
  assert(sizes.reduce((total, size) => total + size, 0) <= 1024, 'Output limit must bound combined persisted logs');
});

test('corrupted evidence metadata is unverified instead of crashing or preserving green', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  await writeFile(path.join(root, '.local/dev-verification/latest.json'), '{"truncated":');
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('truncated stored test output invalidates an otherwise successful record', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['test'] })).status, 'fresh');
  const logs = (await filesBelow(path.join(root, '.local/dev-verification/runs'))).filter(file => file.endsWith('.log'));
  let truncated = false;
  for (const log of logs) {
    const content = await readFile(log);
    if (content.length) { await writeFile(log, content.subarray(0, Math.floor(content.length / 2))); truncated = true; }
  }
  assert(truncated, 'The successful test should have produced a stored log');
  assert.equal((await readVerification(root, { checks: ['test'] })).status, 'unverified');
});

test('a missing recorded exit code cannot establish a successful check', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  const filename = path.join(root, '.local/dev-verification/latest.json');
  const record = JSON.parse(await readFile(filename, 'utf8'));
  delete record.checks[0].result.exitCode;
  await writeFile(filename, JSON.stringify(record));
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('unavailable input capture cannot reuse an older passing fingerprint', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  await symlink('value.mjs', path.join(root, 'src/unsupported-link.mjs'));
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('a command that changes its own source inputs cannot produce fresh evidence', async t => {
  const root = await fixture(t, { typecheck: 'node scripts/mutate.mjs' });
  await writeFile(path.join(root, 'scripts/mutate.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('src/value.mjs', 'export const value = 2;\\n');\n");
  const { runVerification, readVerification } = await adapter();
  const result = await runVerification(root, { checks: ['typecheck'] });
  assert.equal(recordedCheck(result, 'typecheck').result.exitCode, 0);
  assert.equal(result.status, 'stale');
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'stale');
});

test('a missing command log invalidates successful metadata', async t => {
  const root = await fixture(t);
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'fresh');
  const logs = (await filesBelow(path.join(root, '.local/dev-verification/runs'))).filter(file => file.endsWith('.log'));
  assert(logs.length > 0);
  await rm(logs[0]);
  assert.equal((await readVerification(root, { checks: ['typecheck'] })).status, 'unverified');
});

test('a cached passing analysis cannot override a real failed process result', async t => {
  const root = await fixture(t, { typecheck: 'node -e "process.exit(2)"' });
  const { runVerification, readVerification } = await adapter();
  assert.equal((await runVerification(root, { checks: ['typecheck'] })).status, 'failed');
  const filename = path.join(root, '.local/dev-verification/latest.json');
  const record = JSON.parse(await readFile(filename, 'utf8'));
  record.checks[0].analysis = { status: 'passed', parsed: { verdict: 'pass', signal: 'exit-0' } };
  await writeFile(filename, JSON.stringify(record));
  const result = await readVerification(root, { checks: ['typecheck'] });
  assert.equal(result.status, 'failed');
  assert.equal(recordedCheck(result, 'typecheck').result.exitCode, 2);
});
