# Development verification

Use this workflow when changing Repro Surgeon itself. It records what ran and checks whether the saved evidence still matches the checkout. It does not change the reduction oracle: a target command that fails as expected can still be a successful reproduction.

Requires a contributor Git checkout, Node 22.18+ and npm 10+ on Linux or macOS. Install development dependencies with `npm ci --ignore-scripts`.

```sh
npm run verify:dev
npm run verify:status
```

The first command runs **three separate processes**, in order: `npm run typecheck`, `npm test`, and `npm run build`. Each retains its own command, configured script, category, exit status, parsed result, input fingerprints and logs. A failed check does not prevent the other checks from producing their own results; interruption stops the run. The status command runs no development checks. It re-reads and verifies the saved record and logs, fingerprints the current inputs, and checks the recorded runtime versions.

Both commands exit zero only for fresh passing evidence for the **selected checks**. Other outcomes are `failed`, `stale`, `incomplete`, or `unverified`; all exit nonzero. Missing evidence is unverified. A failed command stays failed even if its output prints a passing summary. Interrupted, timed-out, truncated, empty-test and inconclusive runs cannot establish a fresh pass.

## Select a scope

```sh
# Include the packaged CLI demo and standalone verifier check.
npm run verify:dev -- --checks typecheck,test,build,package
npm run verify:status -- --checks typecheck,test,build,package

# Record only type checking while working; this does not cover tests or build.
npm run verify:dev -- --checks typecheck
npm run verify:status -- --checks typecheck

# The default status remains incomplete after that partial run.
npm run verify:status

# Machine-readable local result, including the evidence record.
npm run verify:status -- --json
```

`package` executes `npm run test:package`. Its real Node test installs the package in a temporary directory, runs the bundled reduction, removes the installed tool, and runs the exported standalone verifier. Use it for packaging, dependency, CLI, export or fixture changes. Run the separate framework or integration commands when those areas change; this workflow does not imply they ran. It does not run the costly historical comparison or framework benchmarks automatically.

Scope means the **configured npm script**, whose exact definition is saved. A script may cover only part of a project; a passing script is not proof of exhaustive test coverage. Selecting `package` alone cannot satisfy the default three-check scope. Each invocation replaces the current record; passing checks from unrelated runs are not combined.

## Inspect the evidence

Files stay under ignored `.local/dev-verification/`:

- `latest.json`: the current versioned record, written as running before checks begin.
- `runs/<id>/result.json`: each run's retained record.
- `runs/<id>/<check>.stdout.log` and `.stderr.log`: separate bounded command logs, with byte counts and SHA-256 hashes in the record.
- `run.lock`: excludes concurrent writers. After a hard process kill, first ensure the previous process has stopped before removing this file manually.

Logs may contain local paths or private diagnostics. Review them before sharing; the workflow does not upload them or collect editor history. An unreadable, changed, missing or oversized log makes the record unverified. Reads enforce a byte cap through an ordinary-file handle and reject symlinks and concurrent replacements. These local files are inspectable evidence, **not signed or tamper-proof attestations**: someone who can rewrite the entire record and logs can forge them.

The adapter uses the pinned **stalegreen 0.1.1** public detection, parsing and fingerprint APIs. It owns a terminal-specific record rather than impersonating an editor hook session. No global configuration or hook installation is needed. Existing `npm run check`, `npm test`, and other individual commands remain usable independently.

## Freshness and limits

The input policy includes repository files regardless of Git ignore status, including source, tests, fixtures, scripts, manifests, lockfiles, docs, licenses, site assets and workflow definitions. It supplements stalegreen's fingerprint with a strict content-and-mode digest. Unlike stalegreen's defaults, Markdown and text files are included. Staging or committing unchanged inputs does not make evidence stale; the full commit ID is recorded separately.

Exclusions are root `.git`, `.local`, `dist`, `coverage`, `output`, `.repro-surgeon`, `.superpowers`, `.impeccable`, root `AGENTS.md` and root `*.tgz`, plus `node_modules` and `.DS_Store` at any depth. Nested example `output` directories remain inputs. Do not place source or fixture inputs in excluded directories. Symlinks, submodules, unresolved merges, read errors, capture races and exceeded fingerprint limits make inputs unavailable. The strict scan is bounded to 10,000 entries, 64 MiB and a five-second budget; it fails honestly when the checkout exceeds that policy.

Inputs are captured before the run, before and after each check, and afterward; status recomputes them. A change during verification makes those results stale. Endpoint captures cannot detect an edit that is made and completely reverted between captures. The workflow does not sandbox checks or freeze the working directory.

Records include full Node, npm, TypeScript and stalegreen versions, platform/architecture and a hash of the caller's `NODE_OPTIONS`. Existing Node options are preserved; the wrapper appends `--test-reporter=tap` for its children only when no reporter is already configured, and removes Node's private `NODE_TEST_CONTEXT` transport. An existing non-TAP reporter can leave a successful test command unverified. The parser requires a complete terminal TAP summary with at least one passing test and no failures or cancellations. There are no fabricated success markers. Typecheck/build evidence uses the recognized command, actual zero exit and parsed diagnostics. Scripts with obscured shell status/output, background execution, pipelines, `||`, semicolon/newline sequencing or uncertain shell syntax are unverified even if npm exits zero. Plain commands and status-preserving `&&` chains are supported; this is not an audit of opaque script internals.

These versions and source fingerprints do not identify every ambient environment variable, installed dependency byte, external service or tool on `PATH`. Use a clean installation and the hosted platform matrix for release confidence. Each command has a ten-minute deadline and a combined four-MiB output limit; reaching either limit invalidates its evidence.

stalegreen is a development dependency. The published CLI and exported reproductions do not require it. The standalone verifier continues to report success when its configured target failure is reproduced correctly.
