# Single-file reducer comparison

On one independently authored JavaScript fixture, Repro Surgeon produced a smaller result and treereduce finished faster. Both outputs preserved the same precisely checked behavior in three fresh directories. This is a reproducible, narrow comparison, not evidence that either tool is generally better.

## Observed result

Measured once per tool on September 6, 2026, with treereduce first. The original editable file was **938 bytes**. Both tools stopped without reaching the 120-second ceiling.

| Tool | Result bytes | Bytes removed | Oracle calls during search | Distinct source hashes checked | Observed search time | Fresh checks |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| treereduce-javascript 0.4.1 | 334 | 64.39% | 120 | 82 | 2.956 s | 3/3 |
| Repro Surgeon 0.2.0, syntax only | 248 | 73.56% | 95 | 78 | 4.080 s | 3/3 |

The common fresh checks took a further 0.701 seconds for treereduce's output and 0.530 seconds for Repro Surgeon's output. Search times exclude those checks and tool installation. They include each tool's native setup and checking overhead; they are single observations, not timing averages. The machine was an Apple M4 with 10 logical CPUs, macOS Darwin 25.5.0, Node 24.7.0, and npm 11.5.1. Other development work was not isolated from this machine, so small timing differences should not be treated as stable performance rankings.

[Machine-readable evidence](evidence/comparison.json) contains exact elapsed times, output text and SHA-256 hashes, tool/runtime versions, controls, and fresh-check observations. The [frozen protocol](../examples/comparison/freeze.json) records the fixture, driver, and built reducer module hashes before either search began. The measured Repro Surgeon build was the 0.2.0 workspace build identified by those hashes.

## Fixture and oracle

The [owned fixture](../examples/comparison/subject.cjs) contains score-reporting helpers and a sorting mistake: `Array.sort()` without a numeric comparator. It was authored for this experiment; it is not a reconstructed public bug or an independently submitted maintainer case. No third-party fixture source was copied.

The immutable [checker](../examples/comparison/check.cjs) invokes the exported sorting function on `[2, 10, 3]`, `[4, 12, 11]`, and `[]`. It emits exit code 1 and a distinctive diagnostic only when the serialized results are exactly `[[10,2,3],[11,12,4],[]]`. Other outputs exit 0; parse errors, timeouts inside the VM, and other exceptions exit 2. Candidate execution in the checker has a 500-millisecond VM limit, and each external check has a two-second process limit. This VM is a convenience for the authored fixture, not a security sandbox.

Before search, the driver checked four controls. The original reproduced the target. Adding the numeric comparator, throwing a different error, and introducing a syntax error all failed to reproduce it. Thus an arbitrary crash is not a successful reduction.

Repro Surgeon requires exit 1 plus the full distinctive diagnostic and rejects the two other checker diagnostics. treereduce is configured with `--interesting-exit-code 1`. These predicates are equivalent for this fixed checker: only the exact target branch emits exit 1. The checker is outside treereduce's editable file and explicitly preserved in Repro Surgeon's snapshot.

## Comparable scope and remaining differences

Both tools may change **only `subject.cjs`**. The checker, package metadata, lockfile, and configuration are fixed. Repro Surgeon's file, JSON, and dependency passes are disabled; only its syntax pass is enabled. treereduce uses its native JavaScript syntax-tree reductions. Both tools run serially with a 120-second outer ceiling, and both are allowed to continue until their enabled search finds no further reduction. treereduce uses `--stable --min-reduction 1`; Repro Surgeon's evaluation ceiling is 1,000,000, high enough that time is the effective budget. Neither ceiling was reached here.

The transformation sets and native repetition policies differ. Repro Surgeon made three baseline checks and requires two checks for each accepted candidate. Its 95 checker calls comprise three baseline calls and 92 candidate evaluations, with 15 accepted transformations. treereduce made 120 checker calls across its native search. These counts include repeated checks; the separate distinct-hash column exposes that difference. They exclude the shared preliminary controls and the three final checks per tool.

After search, the driver copied each result, unchanged checker, and zero-dependency npm metadata into three new OS-temporary directories. Every directory received its own `npm ci --ignore-scripts --no-audit --no-fund`, followed by the exact same checker and Repro Surgeon oracle evaluation. All six final checks reproduced the target. There were no dependency downloads for this fixture. The usual Repro Surgeon export/report stage is outside this comparison; this measures the syntax reducer under a fixed single-file task.

Repro Surgeon's result retains the normalizing and sorting functions and exports only `sortScores`. treereduce's result additionally retains empty reporting functions and their exports. Both results contain removable whitespace. Neither result is claimed to be globally minimal.

## Reproduce

Use a repository checkout containing this protocol, with supported Node/npm and Rust/Cargo installed. The [official treereduce installation documentation](https://langston-barrett.github.io/treereduce/install.html) supports installing its language-specific crate. This experiment pinned the released [treereduce-javascript 0.4.1 crate](https://crates.io/crates/treereduce-javascript/0.4.1) with locked dependencies; its origin is the [treereduce repository](https://github.com/langston-barrett/treereduce). The crate SHA-256 is recorded in the protocol. Consult the [official usage documentation](https://langston-barrett.github.io/treereduce/usage.html) for its command-line options.

```sh
npm ci
npm run build
cargo install treereduce-javascript --version 0.4.1 --locked
node scripts/compare-reducers.mjs --out /tmp/repro-comparison-new
```

The output directory must not already exist. If the binary is not on `PATH`, add `--treereduce /absolute/path/to/treereduce-javascript`. The driver verifies the frozen hashes before and after measurement; a different implementation requires a separately identified experiment rather than overwriting this evidence. Generated logs and candidate state remain in the requested output directory. Tool installation and build time are not part of the search measurement.

The fixture, oracle, order, parameters, and implementation hashes were frozen at 13:03:01.862 UTC; both searches and verification finished at 13:03:10.626 UTC. There was one measured run per tool, no fixture or parameter tuning after seeing the results, and no selected best-of-many timing.

## What this does not establish

One seeded file cannot establish typical reduction quality, performance across machines, handling of real application dependencies, success on Next.js failures, maintainer adoption, or superiority over reducers generally. This comparison does not evaluate another tool's whole-application capabilities. A broader claim needs a preregistered corpus of independent failures, repeated measurements, and the appropriate task-specific configuration for each tool.
