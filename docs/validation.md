# Validation

These are executed checks of a specific release and environment, not promises of global minimality, semantic root-cause identity, or performance on an arbitrary application.

## Automated and packaged checks

The native suite covers configuration, actual child processes, failure discrimination, bounded output, descendant cleanup, cancellation, source inventory, ignore precedence, dependency isolation, lock integrity, structural reductions, checkpoint corruption, resume, export ownership, standalone verification, and report escaping/privacy/evidence. The **0.1.0** release candidate passed **107 tests**, type checking and the JavaScript build on macOS ARM64 with Node **24.7.0**, npm **11.5.1**.

The same 107-test suite, build and packaged-install workflow passed in a Linux ARM64 container with Node **22.18.0**. The container used the official `node:22.18.0-bookworm-slim` image, digest `sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e`, with an init process for child reaping. GitHub CI additionally checks Ubuntu/macOS on Node 22.18 and 24; use the linked [workflow history](https://github.com/pavangupta352/repro-surgeon/actions/workflows/ci.yml) for the exact commit's outcome.

The **0.2.0** update passed **112 tests**, type checking and the build on the same macOS runtime. Its installed-package smoke runs the new `demo` command, checks that bundled source remains byte-identical, removes the installed tool and verifies the exported reproduction. The [public walkthrough build](public-demo.md) also runs a real demo and requires three fresh export checks. Its downloadable archive was extracted outside the checkout and independently verified; macOS metadata is stripped for portable extraction. The earlier framework records below retain their original versions and timestamps. A separate [frozen comparison with treereduce](comparison.md) records the new version's single-file experiment.

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

The final validation runs on **2026-09-06** used Repro Surgeon **0.1.0**, Node **24.7.0**, npm **11.5.1**, and **macOS ARM64**. All three reconstructed cases reproduced in three baseline builds and passed three fresh-directory export checks. Every accepted change required two matching observations. Each trigger-removing control built successfully with exit 0; a deliberately unrelated configuration error exited 1. Both controls were rejected by the target oracle. Original source hashes remained unchanged.

| Reconstruction | Files | Source bytes | Total snapshot bytes | Candidate evaluations | Search time |
|---|---:|---:|---:|---:|---:|
| #98261: named CSS container | 10 → 7 | 2,116 → 195 | 33,310 → 31,389 | 26 | 237.33 s |
| #97927: hyphenated root parameter | 11 → 6 | 2,794 → 50 | 36,521 → 33,777 | 12 | 256.61 s |
| #96374: CSS byte-order mark | 10 → 7 | 2,015 → 125 | 33,544 → 31,654 | 26 | 192.00 s |

Search time includes calibration and is rounded here to two decimal places. Reduction plus export verification took 289.801 s, 330.056 s, and 218.977 s respectively, excluding the preceding controls and their dependency setup. The scripts used an 80-evaluation/900-second search budget. Framework dependency reduction was disabled: the direct-dependency counts remained 3, 7, and 3 respectively. These pinned versions are test inputs, not deployment recommendations. [Exact measurements, predicates, controls and hashes](evidence/next-frameworks.json).

Run the reproducible framework validation separately from the native suite:

```sh
npm run build
node scripts/validate-next.mjs /tmp/repro-framework-validation
```

Choose a new output path. It installs the pinned packages with installation scripts disabled, checks both controls, runs the reducer and export verifier, and writes `results.json` plus inspectable private logs. Expect minutes and several dependency installations. Source bytes include fixture documentation and configuration, but exclude package metadata and generated verification files. Successful preservation of an early build diagnostic may leave source that fails later checks for other reasons; the oracle describes exactly the observation tested. These framework results are fresh-directory checks on the recorded host, not framework container or OS-matrix results.

### Pages Router application failure

The [Pages Router fixture](../examples/next-pages) is independently authored with a seeded `getStaticProps` exception. It is **not an upstream Next.js bug**. It pins Next.js **16.3.4** and React/React DOM **19.2.8** and uses the same recorded macOS/Node/npm runtime as the reconstructed cases. The adapter detected `router: pages` without warnings.

| Files | Source bytes | Total snapshot bytes | Candidate evaluations | Search time | Fresh export checks |
|---:|---:|---:|---:|---:|---:|
| 8 → 5 | 2,424 → 271 | 33,618 → 31,465 | 24 | 395.90 s | 3 passed |

Three baseline builds matched both the named total-mismatch diagnostic and Next's prerendering-error text for `/`. Six accepted changes each had two matching executions. Removing the throw produced a successful exit-0 build with an SSG Pages route; an unrelated configuration exception exited 1. Both controls were classified absent. The original source hash remained unchanged, and dependency count stayed at 3 because dependency reduction was disabled.

Search stopped at its 24-evaluation limit within the configured 600-second budget. Reduction plus export verification took 451.370 s, excluding controls and their dependency setup. No separate standalone Pages verifier run is claimed. [Exact measurements and controls](evidence/next-pages.json).

```sh
npm run build
node scripts/validate-pages.mjs /tmp/repro-pages-validation
```

## Dependency removal

An authored fixture installed public **`picomatch@4.0.7`**, checked its local installed package file and runtime import, then removed the unused package through the dependency pass. This ran on Repro Surgeon 0.1.0, Node 24.7.0, npm 11.5.1, macOS ARM64 on 2026-09-06.

| State | Files | Source bytes | Total snapshot bytes | Direct dependencies |
|---|---:|---:|---:|---:|
| Input | 4 | 310 | 1,139 | 1 |
| Accepted source | 4 | 310 | 625 | 0 |

Three baseline observations reproduced, and the dependency proposal was accepted after two matching executions: 2 candidate evaluations total. The manifest declaration, lock root declaration and resolved package entry were removed. The exported metadata was checked against the accepted metadata. Export passed three fresh checks, and its standalone verifier additionally exited 0. The fixed control exited 0; a deliberately different failure exited 1; both were classified absent. Original source was unchanged.

This validates dependency removal; source bytes and file count did not decrease. The measured reduction/export/standalone phase took 2.474 s, excluding fixture generation, lock generation, installation proof and controls. The package was unused by the test command; this single local run does not establish general package-manager or performance coverage. [Exact measurements and controls](evidence/dependency-removal.json).

```sh
npm run build
node scripts/validate-dependency.mjs /tmp/repro-dependency-validation
```

The framework, Pages Router and public-dependency scripts are opt-in checks that may download pinned packages. They are excluded from the native default test command. Use a new output directory for each invocation; full outputs contain private snapshots and logs, while the linked evidence files contain only selected validation data.

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
