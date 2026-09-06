# Security policy

Report a suspected vulnerability privately to **pavan.gupta.352@gmail.com**. Include the affected version, impact, and a small reproduction using non-sensitive data. Do not disclose credentials or another person's private application source. Please give the maintainer an opportunity to investigate before public disclosure.

The latest published release receives security fixes. This is a small open-source project; no response-time guarantee is offered.

## Execution boundary

Repro Surgeon runs the command you supply with your operating-system permissions. It is **not a security sandbox**. Use it only with projects and commands you trust, or run the whole workflow in your own appropriately isolated environment. A child process can access files and the network according to those host permissions even though the reducer itself never runs inside the original project.

Installation scripts are disabled by default. Enabling `execution.allowInstallScripts` permits package lifecycle code to run. Dependencies are fetched from the configured supported public registry locations. Repro Surgeon does not operate a source-upload service and includes no telemetry.

Run directories contain original source snapshots, reduced source, private logs, environment variable names and evidence. Keep them private. The tool excludes common credential files and scans retained content for review findings, but those checks are not complete secret detection. Review the exported source, commands, paths, diagnostic fragments, report and package metadata before sharing. The complete run directory is not the shareable artifact.

The standalone verifier is executable source. Recipients should inspect a reproduction before running it, just as they would inspect any unfamiliar project. A matching failure check establishes the configured observation; it does not prove that source is benign or that two failures have the same root cause.
