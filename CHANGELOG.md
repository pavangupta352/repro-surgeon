# Changelog

## 0.2.1

- Clarify that reduction edits target copies and configured checks start in temporary directories; arbitrary commands retain filesystem and network access, including access to the original checkout. No built-in sandbox has been added.
- Include the execution boundary in CLI help, configuration guidance and each newly exported verifier's README. Distinguish npm-version probes and `init` from failure checks.
- Document running the workflow in Docker with a read-only source mount and separate writable output, including the remaining read, network and output risks.
- Add execution-boundary regression coverage for temporary command working directories and caller-owned paths outside them.

## 0.2.0

- Run the bundled rounding demonstration directly from the installed package with `repro-surgeon demo`. It reduces the source, exports a reproduction and verifies it independently.
- Explore a public walkthrough built from actual reduction evidence, with a downloadable reproduction, checksum and offline report.
- Compare the syntax pass with treereduce on one frozen, independently authored fixture. Both preserve the failure; the documented size and timing results are deliberately scoped to that case.
- Read the tool version from package metadata so checkpoint and report identities stay correct across releases.
- Test the installed demo, immutable bundled source, standalone verifier and public demo build in CI.

## 0.1.0

Initial public release of the complete local application-reduction workflow.

- Explicit argv commands and failure checks using exact exit codes, required output, and forbidden output.
- Repeated baseline, candidate and independent export checks; invalid executions never accepted.
- Hierarchical file removal, JavaScript/TypeScript/JSX syntax reductions, JSON reductions, and direct npm dependency removal with lock integrity checks.
- Immutable source snapshots, content-addressed checkpoints, cancellation and resumable search budgets.
- Single-package npm projects with a Next.js adapter.
- Standalone exported verifier and offline HTML/JSON evidence reports.
- Runnable examples, regression tests, and documented execution/privacy limits.

See [validation](docs/validation.md) for the exact release evidence and tested scope.
