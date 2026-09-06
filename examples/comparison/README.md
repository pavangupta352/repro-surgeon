# Owned single-file comparison fixture

This is an independently authored, seeded JavaScript example for a narrow reducer comparison. It is not a public bug report, a Next.js benchmark, or evidence of typical maintainer work.

The score-sorting function mistakenly uses JavaScript's default lexicographic sort. The fixed checker requires exact outputs on two numeric inputs and an empty input. It emits exit 1 and a distinctive diagnostic only for that configured behavior; different outputs exit 0 and invalid programs or other failures exit 2. The checker executes authored candidates in a bounded Node VM; this is a test convenience, not a security sandbox.

Only `subject.cjs` is editable. Package metadata, the checker, and the experiment protocol are held fixed for both tools. Repro Surgeon's file, JSON, and dependency passes are disabled. treereduce uses its JavaScript tree transformations. The transformation sets are not identical; they share the same editable input and observable property.

`freeze.json` records the input/checker/config hashes and parameters before measurement. See [the comparison method](../../docs/comparison.md) and run `node scripts/compare-reducers.mjs --help` from the repository root for the experiment entry point. Do not edit the frozen fixture to improve either tool's result.
