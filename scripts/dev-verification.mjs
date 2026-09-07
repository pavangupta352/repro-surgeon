import { fileURLToPath } from 'node:url';
import { DEFAULT_CHECKS, readVerification, runVerification, selectChecks } from './verification/evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const mode = args.shift();
let checks = DEFAULT_CHECKS;
let json = false;
try {
  if (args.includes('--help') || mode === '--help') {
    console.log('Repository development verification\n\nnpm run verify:dev [-- --checks typecheck,test,build,package] [--json]\nnpm run verify:status [-- --checks typecheck,test,build,package] [--json]\n\nDefault checks: typecheck,test,build. Logs and evidence: .local/dev-verification.\nExit 0 requires fresh passing evidence for the selected checks.');
  } else {
    if (!['run', 'status'].includes(mode)) throw new Error('Choose run or status');
    while (args.length) {
      const argument = args.shift();
      if (argument === '--json') json = true;
      else if (argument === '--checks' && args.length) checks = selectChecks(args.shift().split(','));
      else throw new Error(`Unknown or incomplete option: ${argument}`);
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    let result;
    try {
      result = mode === 'run'
        ? await runVerification(root, { checks, signal: controller.signal, onProgress: id => { if (!json) console.log(`Running ${id}…`); } })
        : await readVerification(root, { checks });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.status}: ${checks.join(', ')}`);
      for (const check of result.checks) console.log(`  ${check.id}: ${check.status}${check.reason ? ` (${check.reason})` : ''}`);
      if (result.reason) console.log(result.reason);
      console.log('Evidence and private logs: .local/dev-verification/');
    }
    process.exitCode = controller.signal.aborted ? 130 : result.status === 'fresh' ? 0 : 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
