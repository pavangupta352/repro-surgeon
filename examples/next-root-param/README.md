# Next.js #97927: independent reconstruction

An independently written test case based on the trigger described in [Next.js #97927](https://github.com/vercel/next.js/issues/97927). It does not copy the linked reproduction repository. The deliberately pinned version is Next.js 16.3.3. These versions exist to exercise historical behavior; they are not deployment recommendations.

Run `npm ci --ignore-scripts` in this folder, then `npm run build`. To reduce it, run `node dist/cli.js reduce examples/next-root-param --out /tmp/next-root-param-repro` from the Repro Surgeon root. Output must be a new directory.

See [validation notes](../../docs/validation.md) for observed results, controls, runtime, and limitations. All fixture source is covered by the repository's MIT license.
