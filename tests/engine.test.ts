import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { reduceProject, resumeProject } from '../src/engine.ts';
import { parseConfig } from '../src/config.ts';
import { inventoryProject, snapshotHash } from '../src/snapshot.ts';
import { loadCheckpoint, saveCheckpoint } from '../src/state.ts';

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'surgeon-engine-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'input');
  await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'case', version: '1.0.0', type: 'module' }));
  await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ name: 'case', lockfileVersion: 3, packages: { '': { name: 'case', version: '1.0.0' } } }));
  await writeFile(path.join(source, 'check.mjs'), `import { existsSync } from 'node:fs';\nif (existsSync('left.js') !== existsSync('right.js')) { console.error('DIFFERENT_FAILURE'); process.exit(1); }\nif (existsSync('trigger.txt')) { console.error('TARGET_RANGE_MISMATCH: expected 7, got 8'); process.exit(1); }\n`);
  await writeFile(path.join(source, 'trigger.txt'), 'keep this input');
  await writeFile(path.join(source, 'left.js'), 'irrelevant'.repeat(20));
  await writeFile(path.join(source, 'right.js'), 'irrelevant'.repeat(20));
  await writeFile(path.join(source, 'notes.md'), 'private irrelevant documentation'.repeat(15));
  const config = parseConfig({ command: ['node', 'check.mjs'], oracle: { exitCode: 1, allOf: ['TARGET_RANGE_MISMATCH: expected 7, got 8'], noneOf: ['DIFFERENT_FAILURE'] }, preserve: ['check.mjs'], reduce: { syntax: false, json: false, dependencies: false }, budget: { maxEvaluations: 80, maxSeconds: 120 } });
  return { base, source, config };
}

async function controlledNpm(t: test.TestContext, base: string, installSource = ''): Promise<void> {
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('11.5.1');\nelse { ${installSource} }\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previousPath ?? '');
  t.after(() => { process.env.PATH = previousPath; });
}

function cancellableProgram(events: string): string {
  return `const fs = require('node:fs');
const record = event => fs.appendFileSync(${JSON.stringify(events)}, event + '\\n');
process.on('SIGTERM', () => { record('cancelled'); process.exit(0); });
record('started');
setTimeout(() => { record('completed'); process.exit(0); }, 3000);`;
}

test('complete reduction removes interdependent irrelevant files while retaining original target and source integrity', async t => {
  const { base, source, config } = await fixture(t);
  const notices = ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.txt'];
  for (const name of notices) await writeFile(path.join(source, name), `Required legal notice for ${name}`);
  const originalHash = snapshotHash((await inventoryProject(source, config)).snapshot);
  const result = await reduceProject({ sourceRoot: source, runRoot: path.join(base, 'run'), config });
  assert(result.snapshot.has('trigger.txt'));
  assert(result.snapshot.has('check.mjs'));
  assert(!result.snapshot.has('left.js'));
  assert(!result.snapshot.has('right.js'));
  for (const name of notices) assert.equal(result.snapshot.get(name)?.content.toString(), `Required legal notice for ${name}`);
  assert(result.state.current.sourceBytes < result.state.initial.sourceBytes);
  assert(result.state.trials.filter(x => x.accepted).every(x => x.confirmations >= 2 && x.status === 'reproduced'));
  assert.equal(result.state.baseline.length, 3);
  assert.equal(snapshotHash((await inventoryProject(source, config)).snapshot), originalHash);
});

test('a nonmatching baseline stops before any reduction is accepted', async t => {
  const { base, source, config } = await fixture(t);
  config.oracle.allOf = ['not the target'];
  await assert.rejects(reduceProject({ sourceRoot: source, runRoot: path.join(base, 'run'), config }), /baseline/i);
  const state = JSON.parse(await readFile(path.join(base, 'run/state.json'), 'utf8')).state;
  assert.equal(state.status, 'failed');
  assert.equal(state.trials.length, 0);
});

test('interruption checkpoints the last accepted state and resume can complete with the same outcome', async t => {
  const { base, source, config } = await fixture(t);
  const controller = new AbortController();
  const root = path.join(base, 'paused');
  const partial = await reduceProject({ sourceRoot: source, runRoot: root, config, signal: controller.signal, onEvent: event => { if (event.type === 'trial') controller.abort(); } });
  assert.equal(partial.state.status, 'paused');
  const resumed = await resumeProject({ runRoot: root });
  const full = await reduceProject({ sourceRoot: source, runRoot: path.join(base, 'full'), config });
  assert.equal(snapshotHash(resumed.snapshot), snapshotHash(full.snapshot));
});

test('the run deadline interrupts slow baseline execution and saves an unmodified paused snapshot', async t => {
  const { base, source, config } = await fixture(t);
  const events = path.join(base, 'baseline-events');
  await controlledNpm(t, base);
  config.command = [process.execPath, '-e', cancellableProgram(events)];
  config.budget.maxSeconds = 1;
  config.execution.timeoutMs = 10000;
  const original = snapshotHash((await inventoryProject(source, config)).snapshot);
  const runRoot = path.join(base, 'deadline');
  const result = await reduceProject({ sourceRoot: source, runRoot, config });
  assert.equal(await readFile(events, 'utf8'), 'started\ncancelled\n', 'the run deadline must cancel the target before its completion timer');
  const log = JSON.parse(await readFile(path.join(runRoot, 'logs', '000000-baseline.json'), 'utf8'));
  assert.equal(log.execution.aborted, true);
  assert.equal(log.execution.timedOut, false, 'the shorter run deadline, not the command timeout, must stop execution');
  assert.equal(result.state.status, 'paused');
  assert.match(result.state.stopReason, /time budget/i);
  assert.equal(result.state.baseline.length, 0);
  assert.equal(snapshotHash(result.snapshot), original);
  assert.equal(result.state.trials.length, 0);
});

test('the run deadline aborts installation before the target can launch', async t => {
  const { base, source, config } = await fixture(t);
  const events = path.join(base, 'install-events');
  const launched = path.join(base, 'target-started');
  // Test engine cancellation with a real install subprocess without making the
  // one-second budget depend on npm startup or lifecycle-script scheduling.
  await controlledNpm(t, base, cancellableProgram(events));
  config.execution.allowInstallScripts = true;
  config.execution.installTimeoutMs = 10000;
  config.command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'started'); console.error('TARGET_RANGE_MISMATCH: expected 7, got 8'); process.exit(1)`];
  config.budget.maxSeconds = 1;
  const result = await reduceProject({ sourceRoot: source, runRoot: path.join(base, 'install-deadline'), config });
  assert.equal(await readFile(events, 'utf8'), 'started\ncancelled\n', 'the run deadline must cancel installation before its completion timer');
  await assert.rejects(readFile(launched), /ENOENT/);
  assert.equal(result.state.status, 'paused');
  assert.match(result.state.stopReason, /time budget/i);
  assert.equal(result.state.originalHash, result.state.bestHash);
});

test('a candidate interrupted by the deadline is never accepted and the calibrated snapshot is exportable', async t => {
  const { base, source, config } = await fixture(t);
  await controlledNpm(t, base);
  const candidateLaunched = path.join(base, 'candidate-started');
  await writeFile(path.join(source, 'check.mjs'), `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const fail = () => { console.error('TARGET_RANGE_MISMATCH: expected 7, got 8'); process.exit(1); };
if (existsSync('notes.md')) fail();
const attempts = existsSync(${JSON.stringify(candidateLaunched)}) ? Number(readFileSync(${JSON.stringify(candidateLaunched)}, 'utf8')) : 0;
writeFileSync(${JSON.stringify(candidateLaunched)}, String(attempts + 1));
if (attempts === 0) fail();
setTimeout(fail, 3000);
`);
  config.budget.maxSeconds = 2;
  config.execution.timeoutMs = 10000;
  const runRoot = path.join(base, 'candidate-deadline');
  const result = await reduceProject({ sourceRoot: source, runRoot, config });
  assert.equal(await readFile(candidateLaunched, 'utf8'), '2');
  assert.equal(result.state.status, 'verifying');
  assert.match(result.state.stopReason, /time budget/i);
  assert.equal(result.state.originalHash, result.state.bestHash);
  assert(result.state.trials.length > 0);
  assert(result.state.trials.every(trial => !trial.accepted));
  assert.equal(result.state.trials.at(-1)!.status, 'invalid');
  assert.equal(result.state.trials.at(-1)!.confirmations, 1);
  const finalLog = (await readdir(path.join(runRoot, 'logs'))).filter(name => name.endsWith('-candidate.json')).sort().at(-1)!;
  const observation = JSON.parse(await readFile(path.join(runRoot, 'logs', finalLog), 'utf8'));
  assert.equal(observation.execution.aborted, true, 'the unfinished confirmation must actually be cancelled');
  assert.equal(observation.execution.timedOut, false, 'the run deadline must precede the command timeout');
});

test('an exhausted resume launches neither npm nor a target command', async t => {
  const { base, source, config } = await fixture(t);
  const marker = path.join(base, 'launches');
  config.command = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'target'); console.error('TARGET_RANGE_MISMATCH: expected 7, got 8'); process.exit(1)`];
  const controller = new AbortController();
  const root = path.join(base, 'resume-deadline');
  await reduceProject({ sourceRoot: source, runRoot: root, config, signal: controller.signal, onEvent: event => { if (event.type === 'trial') controller.abort(); } });
  const { state, snapshot } = await loadCheckpoint(root);
  state.elapsedMs = config.budget.maxSeconds * 1000;
  await saveCheckpoint(root, state, snapshot);
  const before = await readFile(marker, 'utf8');
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh\necho npm >> '${marker}'\nexit 99\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    for (const exhausted of ['time', 'evaluations']) {
      state.elapsedMs = exhausted === 'time' ? config.budget.maxSeconds * 1000 : 0;
      state.evaluations = exhausted === 'evaluations' ? config.budget.maxEvaluations : 0;
      await saveCheckpoint(root, state, snapshot);
      const result = await resumeProject({ runRoot: root });
      assert.match(result.state.stopReason, /budget/i);
      assert.equal(result.state.bestHash, state.bestHash);
    }
  } finally { process.env.PATH = previousPath; }
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('resume after partial initial calibration records a complete baseline', async t => {
  const { base, source, config } = await fixture(t);
  const controller = new AbortController();
  const root = path.join(base, 'partial-baseline');
  const partial = await reduceProject({ sourceRoot: source, runRoot: root, config, signal: controller.signal, onEvent: event => { if (event.type === 'baseline' && event.message.includes('2/')) controller.abort(); } });
  assert.equal(partial.state.status, 'paused');
  assert.equal(partial.state.baseline.length, 1);
  const resumed = await resumeProject({ runRoot: root });
  assert.equal(resumed.state.baseline.length, config.runs.baseline);
  assert(resumed.state.baseline.every(observation => observation.status === 'reproduced'));
});

test('the deadline cancels a dependency reconciliation subprocess without accepting metadata changes', async t => {
  const { base, source, config } = await fixture(t);
  const marker = path.join(base, 'reconcile-started');
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}
if (process.argv.includes('--version')) console.log('11.5.1');
else if (process.argv.includes('--package-lock-only')) {
  ${cancellableProgram(marker)}
}
`, { mode: 0o755 });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'case', version: '1.0.0', type: 'module', dependencies: { 'owned-test-placeholder': '1.0.0' } }));
  config.budget.maxSeconds = 1;
  config.execution.installTimeoutMs = 10000;
  config.reduce = { files: false, syntax: false, json: false, dependencies: true };
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previousPath;
  try {
    const result = await reduceProject({ sourceRoot: source, runRoot: path.join(base, 'reconcile-deadline'), config });
    assert.equal(await readFile(marker, 'utf8'), 'started\ncancelled\n', 'the run deadline must cancel reconciliation before completion');
    assert.equal(result.state.status, 'verifying');
    assert.equal(result.state.originalHash, result.state.bestHash);
    assert.equal(result.state.trials.length, 1);
    assert.equal(result.state.trials[0]!.accepted, false);
    assert.equal(result.state.trials[0]!.status, 'invalid');
  } finally { process.env.PATH = previousPath; }
});

test('resume runtime probing respects its remaining deadline before recalibration', async t => {
  const { base, source, config } = await fixture(t);
  config.command[0] = process.execPath;
  const controller = new AbortController();
  const root = path.join(base, 'resume-runtime-deadline');
  await reduceProject({ sourceRoot: source, runRoot: root, config, signal: controller.signal, onEvent: event => { if (event.type === 'trial') controller.abort(); } });
  const { state, snapshot } = await loadCheckpoint(root);
  state.elapsedMs = config.budget.maxSeconds * 1000 - 400;
  await saveCheckpoint(root, state, snapshot);
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  const events = path.join(base, 'runtime-events');
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}\n${cancellableProgram(events)}\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    let recalibrated = false;
    const result = await resumeProject({ runRoot: root, onEvent: event => { if (event.type === 'baseline') recalibrated = true; } });
    const recorded = await readFile(events, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    // A 400 ms remainder can expire before Node executes the fixture's first
    // line. Both pre-launch cancellation and a recorded SIGTERM are valid.
    assert(['', 'started\ncancelled\n'].includes(recorded), 'remaining run budget must cancel runtime probing before completion');
    assert.equal(recalibrated, false, 'an expired runtime probe must not reach baseline execution');
    assert.equal(result.state.status, 'paused');
    assert.equal(result.state.bestHash, state.bestHash);
    assert.match(result.state.stopReason, /time budget/i);
  } finally { process.env.PATH = previousPath; }
});

test('an active resume retires prior verification before interrupted recalibration', async t => {
  const { base, source, config } = await fixture(t);
  config.reduce = { files: false, syntax: false, json: false, dependencies: false };
  const root = path.join(base, 'previously-verified');
  await reduceProject({ sourceRoot: source, runRoot: root, config });
  const { state, snapshot } = await loadCheckpoint(root);
  state.status = 'complete';
  state.verification = { status: 'verified', runs: 3, reason: 'Fixture previously verified', snapshotHash: state.bestHash, environment: 'fresh-directory' };
  await saveCheckpoint(root, state, snapshot);
  const controller = new AbortController();
  const result = await resumeProject({ runRoot: root, signal: controller.signal, onEvent: event => { if (event.type === 'baseline') controller.abort(); } });
  assert.equal(result.state.status, 'paused');
  assert.equal(result.state.verification.status, 'pending');
  assert.equal(result.state.verification.runs, 0);
  assert.equal(result.state.verification.snapshotHash, '');
  assert.equal((await loadCheckpoint(root)).state.verification.status, 'pending');
});

test('reduce refuses a temporary parent inside the source before any process or temporary child starts', async t => {
  const { base, source, config } = await fixture(t);
  const nested = path.join(source, 'temporary');
  const alias = path.join(base, 'temporary-alias');
  const marker = path.join(base, 'launched');
  const bin = path.join(base, 'bin');
  await mkdir(nested);
  await symlink(nested, alias);
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'npm'); if (process.argv.includes('--version')) console.log('11.5.1');\n`, { mode: 0o755 });
  config.command = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'target'); console.error('TARGET_RANGE_MISMATCH: expected 7, got 8'); process.exit(1)`];
  config.reduce = { files: false, syntax: false, json: false, dependencies: false };
  const before = snapshotHash((await inventoryProject(source, config)).snapshot);
  const names = await readdir(source, { recursive: true });
  const previousTemp = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    for (const [index, directory] of [source, nested, alias].entries()) {
      process.env.TMPDIR = directory;
      const runRoot = path.join(base, `refused-run-${index}`);
      await assert.rejects(reduceProject({ sourceRoot: source, runRoot, config }), /TMPDIR.*outside.*source|temporary.*source.*TMPDIR/i);
      await assert.rejects(stat(runRoot), /ENOENT/);
      await assert.rejects(readFile(marker), /ENOENT/);
      assert.deepEqual(await readdir(source, { recursive: true }), names);
      assert.equal(snapshotHash((await inventoryProject(source, config)).snapshot), before);
    }
  } finally {
    process.env.PATH = previousPath;
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
  }
});

test('active resume refuses TMPDIR inside original source without launching or changing source contents', async t => {
  const { base, source, config } = await fixture(t);
  config.reduce = { files: false, syntax: false, json: false, dependencies: false };
  const root = path.join(base, 'resume-temp');
  await reduceProject({ sourceRoot: source, runRoot: root, config });
  const nested = path.join(source, 'temporary');
  const marker = path.join(base, 'launched');
  const bin = path.join(base, 'bin');
  await mkdir(nested);
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'npm'); if (process.argv.includes('--version')) console.log('11.5.1');\n`, { mode: 0o755 });
  const before = snapshotHash((await inventoryProject(source, config)).snapshot);
  const names = await readdir(source, { recursive: true });
  const previousTemp = process.env.TMPDIR;
  const previousPath = process.env.PATH;
  process.env.TMPDIR = nested;
  process.env.PATH = bin;
  try {
    await assert.rejects(resumeProject({ runRoot: root }), /TMPDIR.*outside.*source|temporary.*source.*TMPDIR/i);
    await assert.rejects(readFile(marker), /ENOENT/);
    assert.deepEqual(await readdir(source, { recursive: true }), names);
    assert.equal(snapshotHash((await inventoryProject(source, config)).snapshot), before);
  } finally {
    process.env.PATH = previousPath;
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
  }
});

test('a temporary parent above source is valid when execution uses sibling directories', async t => {
  const { base, source, config } = await fixture(t);
  config.reduce = { files: false, syntax: false, json: false, dependencies: false };
  const before = snapshotHash((await inventoryProject(source, config)).snapshot);
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = base;
  try {
    const result = await reduceProject({ sourceRoot: source, runRoot: path.join(base, 'sibling-run'), config });
    assert.equal(result.state.status, 'verifying');
    assert.equal(snapshotHash((await inventoryProject(source, config)).snapshot), before);
    assert.deepEqual((await readdir(base)).filter(name => name.startsWith('repro-surgeon-')), []);
  } finally { if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp; }
});
