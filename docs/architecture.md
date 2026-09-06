# Architecture

Repro Surgeon turns a failing application into a smaller source project that another developer can install and run. Every accepted change must preserve the configured failure oracle. The final export is checked again from a fresh directory and dependency installation.

## Contract

The input is an owned, single-package npm project, an argv command, an exact expected exit code, and distinctive required output fragments. Optional forbidden fragments rule out known competing failures. A successful reduction is the smallest snapshot found within the run's budget that repeatedly matches this contract. This is evidence about the configured observation, not a proof that two failures have the same semantic root cause.

The default release targets deterministic command and Next.js build failures on Linux and macOS with Node.js 22.18 or newer and npm 10 or newer. Framework support is based on executed cases, not inference from a dependency name. Browser interactions and service-backed failures can be authored as finite commands, but automatic recording, server management, monorepos and other package managers require separate adapters and validation.

## Lifecycle

1. `init` writes a versioned JSON configuration from an explicit command and target text. It never guesses the user's failure silently.
2. `doctor` inventories a project, identifies its adapter, and reports unsupported dependencies or environmental requirements without running the configured failure command.
3. `reduce` snapshots the input into a new run directory, provisions dependencies, and calibrates three uncached baseline runs.
4. Hierarchical file reductions and syntax/data transformations are evaluated in disposable working directories. Two uncached confirmations are required before a candidate becomes the accepted state.
5. Each decision is checkpointed atomically. `resume` validates the saved state and runtime, recalibrates the accepted snapshot, and continues with the remaining or explicitly expanded budget.
6. The exporter writes the reduced source, its lockfile, reproduction instructions, an independent assertion runner, and an evidence manifest. It scans retained material for review findings.
7. The exact export is copied to a fresh directory, installed with `npm ci`, and checked three times without reduction caches. Only then can the result say it is verified.
8. Offline HTML and JSON reports expose real metrics, accepted changes, rejected/invalid trials, remaining files, failure checks, verification and review findings.

## Components

| Module | Responsibility |
|---|---|
| `config.ts` | Parse, normalize and validate versioned user configuration |
| `runner.ts` | Shell-free bounded child execution, environment construction, cancellation and process-tree cleanup |
| `oracle.ts` | Classify executions and normalize diagnostic observations |
| `snapshot.ts` | Safe inventory, immutable content, hashing, materialization and integrity checks |
| `transforms.ts` | Deterministic syntax and JSON candidates with narrow source edits |
| `graph.ts` | Static import graph and Next.js structure as search hints |
| `dependencies.ts` | npm lock integrity, installation and dependency-removal candidates |
| `engine.ts` | Baselines, hierarchical reduction, budgets, confirmations and events |
| `state.ts` | Atomic checkpoints, snapshot storage, resume compatibility and run locking |
| `export.ts` | Standalone reproduction, independent verifier and clean verification |
| `report.ts` | Safe, accessible offline HTML and machine-readable evidence |
| `cli.ts` | Commands, progress, errors and exit semantics |

These are modules in one package. A package network would add release coordination without improving the first user's workflow.

## Execution and failure identity

The oracle has three outcomes. `reproduced` means normal termination with the exact expected exit and all required fragments, with no forbidden fragments. `absent` means a normal execution did not match. `invalid` means the execution could not establish an observation: failed setup, spawn error, signal, timeout, cancellation or output overflow. Invalid outcomes can never preserve a candidate.

Required positive fragments cannot be empty. Broad phrases such as “failed” should be replaced with a diagnostic identifier, offending symbol, location or other distinctive signal. A fixed control and a deliberately different failure are the strongest checks of an oracle. The tool displays its exact predicate and diagnostic observations; it does not silently strengthen or weaken them. A missing-import diagnostic may itself be the target, so the engine cannot blanket-ban that error family.

Baseline and final checks require three runs; acceptance requires two. Repetition is not a statistical guarantee of determinism. A failed calibration stops the run. Candidate caches skip previously rejected snapshots; they never supply confirmation or final verification.

Configured commands are argv arrays and use no implicit shell. Each baseline, candidate and verification invocation starts in a temporary project copy. Dependency installations also use temporary workspaces. The tool provisions the initial working directory, temporary home and installation configuration; arbitrary commands can write outside them. For these checks and installations, the environment inherits only operating-system essentials plus explicitly named variables. Logs are bounded and private to the run; report data contains summaries, not raw source/log dumps. Terminal control sequences are removed from displayed excerpts.

Local execution is not a security sandbox. The command may change directory, use `../` or absolute paths and access the original checkout or other files with its process permissions. Paths are not rewritten or confined. Only run projects and commands you trust, or provide an external boundary such as the [documented container with read-only source](execution-container.md). npm installation scripts are disabled by default and can be enabled explicitly when required. Network access is needed for uncached packages and may also be used by the supplied command. Repro Surgeon has no telemetry or source-upload service.

## Source and dependency integrity

The original project is read into an immutable snapshot. The reducer applies source transformations to copies, not the original checkout. Git history, installed dependencies, generated output, environment files and known credential files are excluded from snapshots; these exclusions do not restrict a running command's host access. Ordinary untracked files are included; ignore rules and explicit overrides are visible in the inventory. Symlinks are rejected or excluded without following them. Export and state paths must not overlap the source. `init` writes its requested configuration file. `doctor` does not run the configured failure command. npm-version probes may use the source directory and caller environment; this is separate from the temporary cwd and environment used for failure checks.

Package manifests, lockfiles, licenses and notices are protected from generic file deletion. The package manager owns dependency reconciliation. Source candidates share only a tool-provisioned dependency installation for the same manifest/lock hash; they never link to the user's `node_modules`. Each candidate restores accepted source and clears build artifacts. Dependency changes use a new installation and cannot resolve removed dependencies from a stale tree. Retained package versions and integrity fields must not drift during lock reconciliation.

Projects with workspace, local file/link dependencies or private registry requirements are diagnosed explicitly. These checks reject unsupported dependency declarations; they cannot rule out reads from absolute host paths, credentials or other external state in arbitrary code. Review such dependencies and verify in another environment before claiming portability. Required environment variable names are reported; values are not copied into exported configuration.

## Search

The objective is lower source bytes, then fewer files; dependency bytes and counts are reported separately. The scheduler is deterministic and serial by default. It starts with hierarchical file partitions and complements so it can remove mutually dependent irrelevant groups. It then tries syntax declarations/statements/import members/JSX children and JSON members/array items. Static imports, aliases and framework conventions prioritize candidates; only execution decides acceptance.

Range-based edits preserve unrelated formatting. Directives, shebangs, framework entry files, licenses and user-pinned paths receive conservative handling. Parseable source must remain parseable after structural edits. Files that already contain syntax errors can still be removed but are not structurally rewritten. JSON fixtures are reduced without changing package metadata. Dependency trials run after broad source reductions. Every accepted change restarts applicable search passes because new opportunities may appear.

All trials have stable content hashes. A checkpoint records config, runtime, baseline, current accepted snapshot, attempts, decisions, metrics and accumulated budget. Resuming from a valid accepted snapshot may repeat proposal enumeration, but cached rejected hashes and deterministic ordering prevent repeated execution. Interrupted trials are never marked accepted. Corrupted checkpoints and incompatible runtime/configuration are refused.

## Export and report

The export preserves the source license and notices and places generated metadata under a reserved `.repro/` directory to avoid altering application scripts. The original command still fails as expected. A standalone verifier returns success only when that expected failure matches. It must work without installing Repro Surgeon.

All final source bytes, including generated verification metadata, are copied into a new validation directory before fresh installation and repeated checks. The checkpoint records the runtime and package manager. Its verification record stores the outcome, completed check count, reason, export snapshot hash and fresh-directory method; individual final command observations are not persisted. A clean directory on the same host is described exactly that way; container results are identified separately.

Review findings include likely secrets, absolute local paths, private package references and retained files. Findings are prompts for inspection, never privacy certification. The CLI never publishes a reproduction. The report is self-contained, escapes every untrusted string, uses no network resources, and labels accepted, rejected and invalid trials in text as well as color.

## Release acceptance

- Each CLI command has meaningful success and failure-path coverage.
- Oracle controls reject a different error, timeout, signal and missing executable.
- Trusted regression fixtures retain their source hashes after success, failure and cancellation. Separate execution-boundary tests show that caller-supplied code can access host paths outside its initial temporary working directory.
- File grouping, JavaScript/TypeScript/JSX, JSON, dependency integrity, checkpoint corruption, resume and export have executed regression cases.
- Packaged installation runs the complete example and independent exported verifier.
- Pinned App Router and Pages Router examples run through the real Next.js build command.
- Three independently chosen public bug cases are recorded with provenance, exact commands, controls, results and limitations. Seeded cases and reconstructions are labeled.
- CI executes the claimed runtime/OS matrix. Independent review checks correctness and the report's accessibility and rendering.
- README, license, contributing guide, security policy, issue templates, changelog and release artifacts are present and accurate. No fabricated benchmark, endorsement or adoption claim.

## Prior art

The search builds on [delta debugging](https://www.st.cs.uni-saarland.de/papers/tse2002/). [treereduce](https://github.com/langston-barrett/treereduce) already supplies syntax-aware property-preserving reduction. [Replay](https://www.replay.io/debugging) investigates recorded execution. Repro Surgeon's intended contribution is a complete local application-source workflow with explicit failure checks and independently verified exports. Comparative superiority remains an empirical question.
