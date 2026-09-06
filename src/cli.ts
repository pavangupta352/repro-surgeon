#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { loadConfig, parseConfig } from './config.ts';
import { runtimeInfo, validateNpmProject } from './dependencies.ts';
import { reduceProject, resumeProject } from './engine.ts';
import { exportReproduction, verifyReproduction } from './export.ts';
import { detectAdapter } from './graph.ts';
import { sanitizeReport, writeReport } from './report.ts';
import { inventoryProject, metrics } from './snapshot.ts';
import { loadCheckpoint } from './state.ts';
import type { Config, RunReport, RunState, Snapshot } from './types.ts';

const help = `Repro Surgeon · smaller source, the failure intact

Usage
  repro-surgeon demo [--out <run-directory>] [--json]
  repro-surgeon init [project] --match "distinctive diagnostic" -- <command> [args]
  repro-surgeon doctor [project] [--json]
  repro-surgeon reduce [project] --out <run-directory> [--config <file>]
  repro-surgeon resume <run-directory> [--max-evaluations <n>] [--max-seconds <n>]
  repro-surgeon verify <exported-repro> [--json]
  repro-surgeon report <run-directory> [--json]

Options
  --match <text>             Required output fragment; repeat for multiple signals
  --forbid <text>            Forbidden competing diagnostic; repeat as needed
  --exit <number>            Expected failure exit code (default 1)
  --config <file>            Configuration path (default project/repro-surgeon.json)
  --out <directory>          New run directory outside the source tree
  --max-evaluations <n>      Search evaluation budget
  --max-seconds <n>          Total search time budget
  --json                    Machine-readable result; progress stays on stderr
  --help, -h                Show this help
  --version, -v             Show the installed version

Single-package npm projects · Node 22.18+ · Linux/macOS
Demo uses the bundled rounding example and saves a timestamped run in the current directory.
Failure checks start in temporary copies with your permissions, not a security sandbox.
Commands can still access host paths. Review source and commands before running or sharing.
`;

export function createRunReport(state: RunState, snapshot: Snapshot): RunReport {
  return sanitizeReport({
    version: 1, id: state.id, name: state.config.name, createdAt: state.createdAt,
    status: state.status, stopReason: state.stopReason,
    command: state.config.command, oracle: state.config.oracle, runtime: state.runtime, adapter: state.adapter,
    initial: state.initial, current: state.current, evaluations: state.evaluations, elapsedMs: state.elapsedMs,
    baseline: { completed: state.baseline.filter(observation => observation.status === 'reproduced').length, required: state.config.runs.baseline },
    trials: state.trials,
    files: [...snapshot].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, file]) => ({ path: name, bytes: file.content.length })),
    excluded: state.excluded, warnings: state.warnings,
    verification: state.verification,
    reviewFindings: state.reviewFindings,
  });
}

function terminal(message: string): void { process.stderr.write(stripVTControlCharacters(message) + '\n'); }

async function installedVersion(): Promise<string> {
  try {
    const metadata: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    if (metadata && typeof metadata === 'object' && 'version' in metadata && typeof metadata.version === 'string' && metadata.version.trim()) return metadata.version;
  } catch { /* Report the same actionable error for missing or invalid metadata. */ }
  throw new Error('The installed package version could not be read. Reinstall repro-surgeon or restore its package.json.');
}

async function bundledDemo(): Promise<{ sourceRoot: string; config: Config }> {
  const sourceRoot = fileURLToPath(new URL('../examples/rounding/', import.meta.url));
  try {
    const config = await loadConfig(path.join(sourceRoot, 'repro-surgeon.json'));
    await Promise.all(['package.json', 'package-lock.json', 'check.mjs', 'src/totals.mjs', 'fixtures/invoice.json'].map(name => readFile(path.join(sourceRoot, name))));
    return { sourceRoot, config };
  } catch {
    throw new Error('The bundled rounding demo could not be loaded. Reinstall repro-surgeon or restore examples/rounding in a complete source checkout.');
  }
}

async function main(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const invocation = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), strict: true, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, json: { type: 'boolean' },
    match: { type: 'string', multiple: true }, forbid: { type: 'string', multiple: true }, exit: { type: 'string' },
    config: { type: 'string' }, out: { type: 'string' }, 'max-evaluations': { type: 'string' }, 'max-seconds': { type: 'string' },
  } });
  if (values.help || args.length === 0) { process.stdout.write(help); return 0; }
  if (values.version) { process.stdout.write(await installedVersion() + '\n'); return 0; }
  const [command, target, ...extra] = positionals;
  if (command === 'demo' && (target !== undefined || values.config !== undefined || values.match !== undefined || values.forbid !== undefined || values.exit !== undefined)) {
    throw new Error('demo uses the bundled project and failure configuration. Use reduce for your own project or configuration; demo accepts --out, --json, --max-evaluations and --max-seconds.');
  }
  if (extra.length) throw new Error('Too many positional arguments. See --help.');
  if (process.platform === 'win32') throw new Error('Windows execution is not validated yet. Use Linux or macOS.');
  const directory = path.resolve(target ?? process.cwd());
  const print = (value: unknown, plain: string) => { process.stdout.write(values.json ? JSON.stringify(value, null, 2) + '\n' : plain + '\n'); };
  if (command === 'init') {
    const config = parseConfig({ name: path.basename(directory), command: invocation, oracle: { exitCode: values.exit === undefined ? 1 : Number(values.exit), allOf: values.match ?? [], noneOf: values.forbid ?? [] } });
    const destination = path.resolve(values.config ?? path.join(directory, 'repro-surgeon.json'));
    await readFile(path.join(directory, 'package.json'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify({ version: config.version, name: config.name, command: config.command, oracle: config.oracle, adapter: config.adapter }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    print({ config: destination }, `Created ${destination}\nRun repro-surgeon doctor, then repro-surgeon reduce.`);
    return 0;
  }
  if (invocation.length) throw new Error('Arguments after -- are supported only by init. Store the command in your configuration.');
  if (command === 'doctor') {
    let config: Pick<Config, 'include' | 'exclude' | 'adapter'>;
    try { config = await loadConfig(path.resolve(values.config ?? path.join(directory, 'repro-surgeon.json'))); }
    catch (error) {
      if (values.config || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      config = { include: [], exclude: [], adapter: 'auto' };
    }
    const inventory = await inventoryProject(directory, config);
    validateNpmProject(inventory.snapshot);
    const summary = { adapter: detectAdapter(inventory.snapshot, config.adapter), metrics: metrics(inventory.snapshot), runtime: await runtimeInfo(directory), excluded: inventory.excluded, warnings: inventory.warnings };
    print(summary, `${summary.adapter.name} project · ${summary.metrics.files} files · ${summary.metrics.dependencies} dependencies\nInput checks passed. No project command was executed.\n${summary.excluded.length} paths excluded; inspect --json for details.`);
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (command === 'verify') {
      if (!target) throw new Error('verify requires the exported reproduction directory.');
      const verification = await verifyReproduction(directory, { signal: controller.signal });
      print(verification, `${verification.status}: ${verification.reason}`);
      return verification.status === 'verified' ? 0 : 1;
    }
    if (command === 'report') {
      if (!target) throw new Error('report requires a run directory.');
      const { state, snapshot } = await loadCheckpoint(directory);
      const report = createRunReport(state, snapshot);
      await writeReport(report, directory);
      print(report, `Report: ${path.join(directory, 'report.html')}`);
      return 0;
    }
    if (command !== 'reduce' && command !== 'resume' && command !== 'demo') throw new Error(`Unknown command: ${command ?? '(none)'}. See --help.`);
    if (command === 'resume' && !target) throw new Error('resume requires a run directory.');
    const onEvent = (event: { message: string }) => terminal(event.message);
    let result;
    let runRoot: string;
    if (command === 'reduce' || command === 'demo') {
      const { sourceRoot, config } = command === 'demo' ? await bundledDemo() : { sourceRoot: directory, config: await loadConfig(path.resolve(values.config ?? path.join(directory, 'repro-surgeon.json'))) };
      if (values['max-evaluations'] !== undefined) config.budget.maxEvaluations = Number(values['max-evaluations']);
      if (values['max-seconds'] !== undefined) config.budget.maxSeconds = Number(values['max-seconds']);
      runRoot = path.resolve(values.out ?? (command === 'demo' ? path.join(process.cwd(), `repro-surgeon-demo-${Date.now()}`) : path.join(path.dirname(directory), `${path.basename(directory)}-repro-${Date.now()}`)));
      result = await reduceProject({ sourceRoot, runRoot, config, signal: controller.signal, onEvent });
    } else {
      runRoot = directory;
      result = await resumeProject({ runRoot, signal: controller.signal, onEvent, ...(values['max-evaluations'] === undefined ? {} : { maxEvaluations: Number(values['max-evaluations']) }), ...(values['max-seconds'] === undefined ? {} : { maxSeconds: Number(values['max-seconds']) }) });
    }
    if (result.state.status === 'verifying') {
      terminal('Checking the exported source with a fresh dependency installation…');
      result.state = await exportReproduction(runRoot, result.state, result.snapshot, { signal: controller.signal });
    }
    const report = createRunReport(result.state, result.snapshot);
    await writeReport(report, runRoot);
    print(report, `${report.initial.files} → ${report.current.files} files · ${report.verification.status}\nReproduction: ${path.join(runRoot, 'repro')}\nReport: ${path.join(runRoot, 'report.html')}\nReview the remaining source before sharing.`);
    if (controller.signal.aborted) return 130;
    return report.verification.status === 'verified' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

void main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch((error: unknown) => {
  const message = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'Configuration already exists. Edit it or choose another --config path.' : error instanceof Error ? error.message : String(error);
  terminal(`Repro Surgeon: ${message}`);
  process.exitCode = 2;
});
