import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { readVerification, runVerification } from '../scripts/verification/evidence.mjs';

const exec = promisify(execFile);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'repro-evidence-races-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, '.gitignore'), '.local/\n');
  await writeFile(join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'owned-evidence-race-fixture', version: '1.0.0', private: true,
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }));
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  await git('init', '-q', '--template=');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'owned fixture');
  return { base, root };
}

test('status detects an input edit made during its npm version probe', { skip: process.platform === 'win32' }, async (t) => {
  const { base, root } = await fixture(t);
  const bin = join(base, 'bin');
  await mkdir(bin);
  const npm = (await exec('which', ['npm'])).stdout.trim();
  await writeFile(join(bin, 'npm'), `#!/bin/sh
if [ "$1" = "--version" ] && [ -e "$REPRO_RACE_BASE/armed" ]; then
  printf 'export const value = 99;\\n' > "$REPRO_RACE_ROOT/src/value.mjs"
fi
exec "$REPRO_RACE_NPM" "$@"
`);
  await chmod(join(bin, 'npm'), 0o755);
  const module = new URL('../scripts/verification/evidence.mjs', import.meta.url).href;
  const script = `
    import { writeFile, readFile } from 'node:fs/promises';
    import { runVerification, readVerification } from ${JSON.stringify(module)};
    const root = ${JSON.stringify(root)};
    const initial = await runVerification(root, { checks: ['typecheck'] });
    await writeFile(${JSON.stringify(join(base, 'armed'))}, 'armed');
    const inspected = await readVerification(root, { checks: ['typecheck'] });
    console.log(JSON.stringify({ initial: initial.status, inspected: inspected.status,
      source: await readFile(${JSON.stringify(join(root, 'src/value.mjs'))}, 'utf8') }));
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, REPRO_RACE_BASE: base, REPRO_RACE_ROOT: root, REPRO_RACE_NPM: npm },
    timeout: 15_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.initial, 'fresh');
  assert.equal(result.source, 'export const value = 99;\n', 'the real version probe must have edited the included source');
  assert.equal(result.inspected, 'stale', 'status must check inputs after its subprocess and log inspection');
});

for (const kind of ['missing', 'oversized', 'symlink'] as const) {
  test(`${kind} command logs cannot establish fresh evidence`, { skip: kind === 'symlink' && process.platform === 'win32' }, async (t) => {
    const { base, root } = await fixture(t);
    const initial = await runVerification(root, { checks: ['typecheck'] });
    assert.equal(initial.status, 'fresh');
    const log = join(root, '.local', 'dev-verification', 'runs', initial.record.id, 'typecheck.stdout.log');
    if (kind === 'missing') await rm(log);
    else if (kind === 'oversized') await writeFile(log, Buffer.alloc(4 * 1024 * 1024 + 1));
    else {
      const target = join(base, 'same-output.log');
      await writeFile(target, await readFile(log));
      await rm(log);
      await symlink(target, log);
    }
    const result = await readVerification(root, { checks: ['typecheck'] });
    assert.equal(result.status, 'unverified');
  });
}
