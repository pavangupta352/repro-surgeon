# Reviewing commands before execution

Repro Surgeon's command name describes a workflow, not a permission boundary. A review tool should distinguish commands that execute project code from commands that inspect inputs or write metadata. This reference describes **Repro Surgeon 0.2.1** and links to its [versioned CLI implementation](https://github.com/pavangupta352/repro-surgeon/blob/v0.2.1/src/cli.ts).

## Optional HOL Guard support

[HOL Guard](https://github.com/hashgraph-online/hol-guard) supports optional command safety extensions. Repro Surgeon's proposed integration is tracked in [HOL Guard #2826](https://github.com/hashgraph-online/hol-guard/issues/2826).

The proposed `command.repro-surgeon` extension reviews installed `repro-surgeon` invocations of `reduce`, `resume`, `verify` and `demo` before they execute. It is opt-in and contributes command evidence to Guard's existing policy. Repro Surgeon itself does not require Guard, Python, an account or an additional approval prompt.

**Availability:** this integration is a contribution under review, not a feature promised in an existing Guard release. Check the linked upstream change and its release status before relying on this coverage. Installing Repro Surgeon does not install, enable or configure Guard.

## Command effects

| Command | What executes or is read | What the tool writes |
| --- | --- | --- |
| No arguments, `--help`, `-h` | Displays help; no child process | Nothing |
| `--version`, `-v` | Reads installed package metadata; no child process | Nothing |
| `doctor` | Reads configuration, source and package metadata; probes `npm --version` | No intentional project writes; the npm probe retains process permissions |
| `init` | Reads package metadata and stores the supplied command without running it | A new configuration file and any missing parent directories |
| `report` | Reads a saved checkpoint and snapshot; no configured project command | Writes or replaces `report.html` and `report.json`, including with `--json` |
| `reduce` | Probes the runtime, installs dependencies, executes the configured command repeatedly and verifies the export | Run state, logs, snapshots, reproduction, reports and temporary workspaces |
| `resume` | Reads saved configuration; may install dependencies, execute the saved command and verify the export | Existing run state, logs, reproduction, reports and temporary workspaces |
| `verify` | Reads exported configuration, installs dependencies and executes its command | Temporary project copies, dependencies, home and cache |
| `demo` | Runs the bundled rounding fixture through reduction and verification | A new run directory, reproduction, reports and temporary workspaces |

This table describes the expected installed program. It does not establish that an executable with the same name is trusted. Configured commands and their children can read, write, change directory and use the network with their process permissions. See the [execution boundary](../SECURITY.md#execution-boundary).

Leaving `doctor`, `init` or `report` outside a project-execution rule must not allow them past unrelated protections. `doctor` still invokes npm from the source directory with the caller's environment. `init --config` can write a selected location. `report --json` still writes both report files.

## Parse the command, not its words

- The first positional argument selects the subcommand. Options may appear before or after it. `repro-surgeon --json verify ./repro` executes just as `repro-surgeon verify ./repro --json` does.
- `--match`, `--forbid`, `--exit`, `--config`, `--out`, `--max-evaluations` and `--max-seconds` take string values. A value named `reduce` is not a subcommand. Both separate values and `--option=value` forms are supported.
- `--json` affects output formatting. It never changes an execution command into an inspection command.
- The CLI splits arguments at the first literal `--`. Only `init` accepts a nonempty tail, which it stores as the future failure command. Help/version flags in that tail are not Repro Surgeon flags.
- Recognized help/version flags exit before subcommand dispatch, after strict option parsing. Help takes precedence over version. Unknown flags or missing option values can still make parsing fail. Literal `help` and `version` are not subcommands.
- Several options are globally parsed but ignored by some commands. For example, `resume --config other.json ./run` uses the saved configuration, and `report --out elsewhere ./run` still writes reports under `./run`.
- A non-match is not proof of safety. Preserve uncertainty for malformed input, dynamic arguments, unsupported launch forms and unknown versions. A safe variant of one command must not suppress another command or redirection in the same shell expression.

Examples assume reviewed executables and invented paths. Classification should not require reading a project's configuration, checkpoint, source, environment values or exported code. Avoid retaining raw commands or private paths in static integration metadata.

## Launchers and exported verifiers

`npx` and `npm exec` can install and execute package code before Repro Surgeon handles its own options. For example, `npx repro-surgeon@0.2.1 --help` is not equivalent to an already-installed executable displaying help. Package-launcher policy remains a separate concern and must not be suppressed by an inner help flag.

The initial proposed Guard extension targets the installed `repro-surgeon` command. It does not promise recognition of renamed executables, generic `node path/to/cli.js` calls, shell aliases, npm-script indirection or standalone `node .repro/verify.mjs` invocations. The standalone verifier executes exported code and installs dependencies; it must not be treated as a read-only inspection command.

## Approval and containment are separate

A review gate can make an execution request visible before it runs. It does not inspect every future child action, bind approval to unchanged source/configuration or confine filesystem/network access. Users must still review the selected project and command. For an additional filesystem boundary, use the [tested container recipe with read-only source input](execution-container.md), including its documented read and network limits.
