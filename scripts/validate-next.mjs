import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, inventoryProject, snapshotHash, reduceProject, exportReproduction, evaluateOracle } from '../dist/index.js';
import { WorkspaceManager } from '../dist/dependencies.js';
import { runCommand } from '../dist/runner.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.argv[2] ?? await mkdtemp(path.join(tmpdir(), 'repro-next-validation-')));
await mkdir(output, { recursive: true });
const summaries = [];
for (const name of ['next-container', 'next-root-param', 'next-css-bom']) {
  const sourceRoot = path.join(root, 'examples', name);
  const config = await loadConfig(path.join(sourceRoot, 'repro-surgeon.json'));
  const { snapshot } = await inventoryProject(sourceRoot, config);
  const sourceHash = snapshotHash(snapshot);
  const controls = new Map(snapshot);
  if (name === 'next-root-param') {
    for (const [name, file] of snapshot) {
      if (!name.includes('[lang-country]')) continue;
      controls.delete(name);
      controls.set(name.replace('[lang-country]', '[langCountry]'), file);
    }
  } else {
    const css = controls.get('app/case.css');
    const content = css.content.toString('utf8');
    controls.set('app/case.css', { ...css, content: Buffer.from(name === 'next-css-bom' ? content.replace(/^\uFEFF/, '') : content.replace('@container scroll-content', '@container (min-width: 1px)')) });
  }
  const controlRoot = path.join(output, name + '-controls');
  await mkdir(controlRoot);
  const manager = new WorkspaceManager(controlRoot, config);
  const observations = [];
  try {
    for (const kind of ['trigger-removed', 'different-failure']) {
      const selected = new Map(controls);
      if (kind === 'different-failure') {
        selected.set('next.config.mjs', { mode: 0o644, content: Buffer.from('throw new Error("UNRELATED_CONTROL_FAILURE");\n') });
      }
      const cwd = await manager.prepare(selected);
      const command = await runCommand(config.command, { cwd, env: await manager.environment(), timeoutMs: config.execution.timeoutMs, maxOutputBytes: config.execution.maxOutputBytes });
      const oracle = evaluateOracle(command, config.oracle);
      await writeFile(path.join(controlRoot, kind + '.json'), JSON.stringify({ command, oracle }, null, 2));
      assert.equal(oracle.status, 'absent', `${name}/${kind}: ${oracle.reason}`);
      assert.equal(command.exitCode, kind === 'trigger-removed' ? 0 : 1, `${name}/${kind}: ${command.stdout}\n${command.stderr}`);
      observations.push({ kind, exitCode: command.exitCode, status: oracle.status });
      process.stderr.write(`${name}: ${kind} control rejected as expected\n`);
    }
  } finally { await manager.dispose(); }
  const runRoot = path.join(output, name);
  const started = Date.now();
  const reduction = await reduceProject({ sourceRoot, runRoot, config, onEvent: event => process.stderr.write(`${name}: ${event.message}\n`) });
  assert.equal(reduction.state.status, 'verifying');
  const state = await exportReproduction(runRoot, reduction.state, reduction.snapshot);
  assert.equal(state.verification.status, 'verified', state.verification.reason);
  assert.equal(snapshotHash((await inventoryProject(sourceRoot, config)).snapshot), sourceHash, 'Original source changed');
  const summary = { name, sourceHash, runtime: state.runtime, initial: state.initial, current: state.current, baseline: state.baseline.map(observation => observation.status), evaluations: state.evaluations, searchMs: state.elapsedMs, totalMs: Date.now() - started, verification: state.verification, controls: observations };
  summaries.push(summary);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(summaries, null, 2) + '\n');
  // Logs and accepted source remain inspectable; remove the large private dependency caches.
  await rm(path.join(runRoot, 'installations'), { recursive: true, force: true });
  await rm(path.join(controlRoot, 'installations'), { recursive: true, force: true });
  process.stderr.write(`${name}: ${state.initial.files} -> ${state.current.files} files; fresh export verified\n`);
}
console.log(JSON.stringify({ output, cases: summaries }, null, 2));
