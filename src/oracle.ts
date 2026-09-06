import type { CommandResult, Oracle, OracleResult } from './types.ts';

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-\w/#&.:=?%@~_]+)*|[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function diagnostics(output: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.slice(-20);
}

function invalidReason(result: CommandResult): string | undefined {
  if (result.outputLimitExceeded) return 'Output limit exceeded';
  if (result.timedOut) return 'Command timed out';
  if (result.aborted) return 'Command was aborted';
  if (result.error !== undefined) return `Command failed to run: ${result.error}`;
  if (result.signal !== null) return `Command terminated by signal ${result.signal}`;
  if (result.exitCode === null) return 'Command did not produce an exit code';
  return undefined;
}

export function evaluateOracle(result: CommandResult, oracle: Oracle): OracleResult {
  const output = stripAnsi(`${result.stdout}${result.stdout.length > 0 && result.stderr.length > 0 ? '\n' : ''}${result.stderr}`);
  const matched = oracle.allOf.filter((target) => output.includes(target));
  const missing = oracle.allOf.filter((target) => !output.includes(target));
  const forbidden = oracle.noneOf.filter((target) => output.includes(target));
  const observedDiagnostics = diagnostics(output);
  const invalid = invalidReason(result);

  if (invalid !== undefined) {
    return { status: 'invalid', reason: invalid, matched, missing, forbidden, diagnostics: observedDiagnostics };
  }
  if (result.exitCode !== oracle.exitCode) {
    return {
      status: 'absent',
      reason: `Expected exit code ${oracle.exitCode}, received ${result.exitCode}`,
      matched,
      missing,
      forbidden,
      diagnostics: observedDiagnostics,
    };
  }
  if (missing.length > 0) {
    return {
      status: 'absent',
      reason: `Missing ${missing.length} required output fragment${missing.length === 1 ? '' : 's'}`,
      matched,
      missing,
      forbidden,
      diagnostics: observedDiagnostics,
    };
  }
  if (forbidden.length > 0) {
    return {
      status: 'absent',
      reason: `Observed ${forbidden.length} forbidden output fragment${forbidden.length === 1 ? '' : 's'}`,
      matched,
      missing,
      forbidden,
      diagnostics: observedDiagnostics,
    };
  }
  return {
    status: 'reproduced',
    reason: 'Exit code and output fragments matched the oracle',
    matched,
    missing,
    forbidden,
    diagnostics: observedDiagnostics,
  };
}
