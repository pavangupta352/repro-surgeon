'use strict';

const { readFileSync, appendFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const target = 'COMPARISON_NUMERIC_SORT: observed [[10,2,3],[11,12,4],[]]';
let status = 'other';
let exitCode = 2;
let sourceHash = '';
try {
  const source = readFileSync(resolve(process.argv[2] || 'subject.cjs'), 'utf8');
  sourceHash = createHash('sha256').update(source).digest('hex');
  const context = vm.createContext({ module: { exports: {} } });
  const program = new vm.Script(source + `
;globalThis.__comparisonResult = JSON.stringify([
  module.exports.sortScores([2, 10, 3]),
  module.exports.sortScores([4, 12, 11]),
  module.exports.sortScores([]),
]);`, { filename: 'subject.cjs' });
  program.runInContext(context, { timeout: 500 });
  if (context.__comparisonResult === '[[10,2,3],[11,12,4],[]]') {
    status = 'target';
    exitCode = 1;
    process.stderr.write(target + '\n');
  } else {
    status = 'absent';
    exitCode = 0;
    process.stderr.write('COMPARISON_TARGET_ABSENT\n');
  }
} catch {
  process.stderr.write('COMPARISON_OTHER_FAILURE\n');
}

if (process.env.COMPARISON_LOG) {
  appendFileSync(process.env.COMPARISON_LOG, JSON.stringify({ sourceHash, status, exitCode }) + '\n');
}
process.exitCode = exitCode;
