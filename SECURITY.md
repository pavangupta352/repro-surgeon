# Security policy

Report a suspected vulnerability privately to **pavan.gupta.352@gmail.com**. Include the affected version, impact, and a small reproduction using non-sensitive data. Do not disclose credentials or another person's private application source. Please give the maintainer an opportunity to investigate before public disclosure.

The latest published release receives security fixes. This is a small open-source project; no response-time guarantee is offered.

## Execution boundary

Repro Surgeon runs the command you supply with your operating-system permissions. It is **not a security sandbox**. Each configured failure-check invocation starts in a temporary project copy, including baseline, candidate, export and standalone verification checks. The reducer applies its source edits to copies; this is a guarantee about the reducer's own file operations, not about arbitrary code it executes.

The command can change directory, follow paths it creates, use `../` or absolute paths, spawn children, and access files or the network according to its process permissions. It can therefore read or modify the original checkout or other host files. Paths are not rewritten or confined. Snapshot exclusions, a temporary home, disabled install scripts and process cleanup are not filesystem access controls. Trust the configured command and its dependencies, or provide a separate execution boundary.

The [container recipe](docs/execution-container.md) mounts source read-only and exposes a separate writable output directory. It documents mount and network limits. The mounted source remains readable, including files excluded from the reducer's snapshot. A successful check in a fresh directory on the same host does not prove that a command is independent of absolute host paths or external state.

`init` explicitly creates the requested configuration file, normally inside the project. `doctor` does not run the configured failure command; it inspects the project and probes the installed npm version. npm-version probes can run with the project as their working directory and inherit the caller's environment.

Installation scripts are disabled by default. Enabling `execution.allowInstallScripts` permits package lifecycle code to run. Dependencies are fetched from the configured supported public registry locations. Repro Surgeon does not operate a source-upload service and includes no telemetry.

Run directories contain original source snapshots, reduced source, private logs, environment variable names and evidence. Keep them private. The tool excludes common credential files and scans retained content for review findings, but those checks are not complete secret detection. Review the exported source, commands, paths, diagnostic fragments, report and package metadata before sharing. The complete run directory is not the shareable artifact.

The standalone verifier is executable source. Recipients should inspect a reproduction before running it, just as they would inspect any unfamiliar project. A matching failure check establishes the configured observation; it does not prove that source is benign or that two failures have the same root cause.
