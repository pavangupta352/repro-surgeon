# Changelog

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
