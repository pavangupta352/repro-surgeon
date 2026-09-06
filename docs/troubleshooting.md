# Troubleshooting

## The baseline does not reproduce

Inspect the private run logs and the inventory from `doctor --json`. Check that the command is finite, the exact exit code matches, and required fragments survive ANSI normalization. A `.gitignore` rule may hide a needed fixture; use `include` for ordinary ignored source. Hard-excluded credential/environment files cannot be included. Supply required environment variable names explicitly. Do not weaken a useful oracle merely to get a green result.

Many application builds need external services, environment configuration or generated assets. Arrange those dependencies in a reproducible, trusted command, or select a smaller standalone project before reducing. The CLI does not start databases or record browser interactions.

## npm setup fails

Use one npm package with a current `package-lock.json` version 2 or 3. npm must be able to install its public registry dependencies without local paths or credentials. Workspaces, Git dependencies, private registries, alternative package managers and `npm-shrinkwrap.json` are diagnosed as unsupported. Keep using the original application's package manager there; prepare a separate portable reproduction input when necessary.

Install scripts are disabled by default. Some native packages require them. For trusted source, explicitly set `execution.allowInstallScripts` to true and retry with a new run. Inspect setup errors before changing this setting. A package that rewrites exported source during installation will fail integrity verification.

If the tool reports ancestor `node_modules` in the temporary directory, select a normal OS temporary location outside any repository or dependency tree. Dependency isolation depends on keeping execution directories away from ancestor packages.

## A run stops before finishing

Normal search budget exhaustion proceeds to verification of the best accepted source. An interrupted or budget-limited incomplete baseline stays paused. Resume with larger **total** budgets, not an additional allowance:

```sh
repro-surgeon resume ./my-app-repro --max-evaluations 500 --max-seconds 1800
```

If a single command needs more time, change `execution.timeoutMs` in the input configuration and start a new run. Editing saved checkpoint configuration is refused. Runtime versions are part of a checkpoint: return to the recorded tool, Node, npm and platform, or start over in the new environment.

## A crash left a lock

Normal Ctrl-C releases the run lock after checkpointing. A hard kill or machine crash may leave `run.lock`. The tool deliberately refuses automatic stale-lock deletion because concurrent recovery can give two processes ownership of the same run.

Stop all processes using that run directory and verify that none still owns it. Then remove only the `run.lock` file named in the error and retry `resume`. Do not remove a lock while a run or export is active. If a checkpoint or blob checksum is corrupt, retain the directory for diagnosis and start a new run; bypassing the integrity check is unsafe.

## The export fails independent verification

The accepted observation may depend on nondeterminism, an undeclared dependency, a side effect, external state or a broad error match. Inspect the verification result and private logs. Fix those assumptions and start a new reduction. A failed independent check is not a verified reproduction.

If exported files were edited, hashes will no longer match. Keep the original export for comparison. To reduce a modified project, use it as a new input with a newly authored configuration; do not manually relabel it verified.

## The result is larger than expected

The reducer reports the best candidate found by enabled passes within its budget. Try a larger budget, review pinned paths, or isolate a project with fewer environmental dependencies. Framework paths are conservatively protected; source contents can still be simplified. An opaque binary or stylesheet can be removed as a file but is not structurally rewritten. License notices stay with the source.

File counts include package metadata. Source bytes omit package metadata; total snapshot bytes include it. Installed dependencies and generated verification metadata are separate from those reduction metrics.

## Sharing or reporting a problem

Review the reduced source, report, diagnostic strings and metadata before posting. Share the `repro/` directory and any selected evidence you have inspected. Keep the original snapshots and private logs in the parent run directory private. For tool bugs, include versions, the command, oracle and a small licensed case. Use the [security policy](../SECURITY.md) for sensitive reports.
