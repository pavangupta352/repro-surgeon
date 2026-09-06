# Validation

These are executed checks of a specific release and environment, not promises of global minimality, semantic root-cause identity, or performance on an arbitrary application.

## Automated and packaged checks

The native suite covers configuration, actual child processes, failure discrimination, bounded output, descendant cleanup, cancellation, source inventory, ignore precedence, dependency isolation, lock integrity, structural reductions, checkpoint corruption, resume, export ownership, standalone verification, and report escaping/privacy/evidence. The release candidate passed **107 tests**, type checking and the JavaScript build on macOS ARM64 with Node **24.7.0**, npm **11.5.1**.

The same 107-test suite, build and packaged-install workflow passed in a Linux ARM64 container with Node **22.18.0**. The container used the official `node:22.18.0-bookworm-slim` image, digest `sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e`, with an init process for child reaping. GitHub CI additionally checks Ubuntu/macOS on Node 22.18 and 24; use the linked [workflow history](https://github.com/pavangupta352/repro-surgeon/actions/workflows/ci.yml) for the exact commit's outcome.

`npm run test:package` builds a tarball, installs it in a fresh prefix, invokes the installed executable, reduces the installed rounding example, checks that the original source is unchanged, and runs the generated verifier without installing Repro Surgeon in the exported project. It also checks that private build records are absent from the package.

## Seeded example and file-only comparison

The bundled rounding application is a deliberately small, authored demonstration. Its checker is pinned. Both runs use the same source, failure predicate, 200-evaluation/120-second budget, repeated checks and fresh verification. Source bytes exclude package metadata; totals include it. The figures below are one local run per setting on macOS, not a controlled performance study.

| Setting | Files | Source bytes | Candidate evaluations | Search time | Fresh export checks |
|---|---:|---:|---:|---:|---:|
| Input | 10 | 3,173 | — | — | — |
| File removal only | 5 | 1,128 | 20 | 1.93 s | 3 passed |
| Full enabled passes | 5 | 520 | 115 | 6.56 s | 3 passed |

Structural passes removed additional unused functions and invoice metadata at the cost of more executions. This isolates the contribution of those passes within Repro Surgeon. It is **not** a comparison against treereduce, another released reducer, or an independent human. No competitive performance claim is made. [Machine-readable observations](evidence/rounding.json).

## Framework cases

Three cases were selected from public Next.js reports before reducer tuning. Their source was independently written from the described trigger; the linked reproduction repositories were not copied. Each fixture has a pinned npm lock. These are **reconstructions**, not executions of the reporters' original projects.

- [Next.js #98261](https://github.com/vercel/next.js/issues/98261): a named container query in CSS, pinned to Next 16.3.4. The check requires the CSS parsing diagnostic, the named container token and unexpected end of input.
- [Next.js #97927](https://github.com/vercel/next.js/issues/97927): a hyphenated root parameter name, pinned to Next 16.3.3. The check requires both exact TS1005 diagnostics from the generated root-params declaration and failed type checking.
- [Next.js #96374](https://github.com/vercel/next.js/issues/96374): a byte-order mark before a CSS layer rule, pinned to Next 16.3.0-canary.103. The check requires the CSS parsing diagnostic and the unexpected layer token. This is a historical case; its closed upstream status does not establish a current defect.

All three first datasets reproduced in three baseline builds, reduced while retaining the configured failure, and passed three fresh-directory export checks. Each trigger-removing control built successfully with exit 0; a deliberately unrelated configuration error exited 1 and was rejected by the oracle. Original source hashes remained unchanged. Framework dependency reduction was disabled to measure source reduction at fixed versions. These pinned versions are test inputs, not deployment recommendations.

Run the reproducible framework validation separately from the native suite:

```sh
npm run build
node scripts/validate-next.mjs /tmp/repro-framework-validation
```

Choose a new output path. It installs the pinned packages, checks both controls, runs the reducer and export verifier, and writes `results.json` plus inspectable private logs. Expect minutes and several dependency installations. Source-byte changes exclude lockfiles and generated verification metadata. Successful preservation of an early build diagnostic may leave source that fails later checks for other reasons; the oracle describes exactly the observation tested.

## Dependency removal

An authored fixture installed public `picomatch@4.0.7`, then removed it through the dependency pass. The package disappeared from both the manifest and lock, the direct-dependency count fell from 1 to 0, and total snapshot bytes fell from 1,139 to 625. The accepted candidate had two matching observations; export passed three fresh checks and the standalone verifier exited 0. Fixed and different-failure controls were rejected. Original source was unchanged.

```sh
npm run build
node scripts/validate-dependency.mjs
```

## Independent review and report inspection

Independent review covered implementation contracts and code quality. Confirmed findings were fixed with regressions, including ambient dependency resolution, physical symlink ancestry, source-contained temporary paths, inherited pipes, cancellation, stale locks, private diagnostic leakage, legal notice preservation and baseline evidence. The final follow-up closed the reviewed findings; it is not a general security certification.

An actual report was inspected at 1440-pixel desktop and 390-pixel mobile widths. A long-history overflow was fixed, then both document widths matched their viewports with no overflowing elements. Search, status filters, empty results, file filtering and command copy worked. Controls met a 44-pixel minimum in those checks. An independent visual review found no material defect in the supplied viewports. Full assistive-technology conformance and every possible viewport are not claimed.

## What is not established

- A globally smallest reproduction or proof of identical semantic root cause.
- Broad benchmark superiority, time saved for an independent maintainer, adoption or popularity.
- Support for all Next.js bugs, browsers, services, monorepos, package managers or Windows.
- Complete secret detection or a security sandbox for untrusted projects.
- Identical results across every runtime, architecture, network state or external service.

Submit a small licensed case and precise failure check when a result violates the documented contract. New evidence is more useful than widening those claims.
