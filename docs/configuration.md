# Configuration

`repro-surgeon.json` is strict JSON. Unknown fields and invalid values fail early. `command` and `oracle` are required; everything else has a default.

```json
{
  "version": 1,
  "name": "My reproduction",
  "command": ["npm", "run", "build"],
  "oracle": {
    "exitCode": 1,
    "allOf": ["a distinctive diagnostic"],
    "noneOf": []
  },
  "adapter": "auto",
  "budget": { "maxEvaluations": 200, "maxSeconds": 900 },
  "runs": { "baseline": 3, "candidate": 2, "final": 3 },
  "execution": {
    "timeoutMs": 60000,
    "maxOutputBytes": 1048576,
    "installTimeoutMs": 120000,
    "allowInstallScripts": false,
    "env": []
  },
  "reduce": { "files": true, "syntax": true, "json": true, "dependencies": true },
  "include": [],
  "exclude": [],
  "preserve": []
}
```

## Command and oracle

`command` is an argv array, run from a disposable copy of the project. There is no implicit shell, so redirection, pipes, globs and shell substitutions are literal arguments. Put a multi-step check in a script and name that script explicitly. Prefer portable executable names such as `node` and `npm`; absolute paths may not work for a recipient.

The oracle matches combined stdout/stderr after terminal-control normalization. `exitCode` is an integer from 0 through 255. `allOf` must contain at least one non-empty, case-sensitive literal fragment. Every required fragment must occur, and no `noneOf` fragment may occur. These are literals, not regular expressions. A normal nonmatching exit is `absent`; execution/setup failures are `invalid`.

Pin a checker with `preserve` when its assertion must remain unchanged. A target that prints its own entire diagnostic can sometimes be reduced to that print; a precise external assertion and controls make the observation more useful. A match alone does not prove a semantic root cause.

## Search and execution limits

`maxEvaluations` counts actual candidate observations, including confirmation runs, plus failed dependency preparations. Baseline and export checks do not consume this count. `maxSeconds` covers calibration and search, including their setup. Inventory and the initial npm availability probe precede this timer. Filesystem cleanup/checkpoint work may finish shortly after a deadline, but an incomplete confirmation cannot be accepted.

After calibrated search reaches a budget, independent export verification runs separately. Each final target has `timeoutMs`, each new installation has `installTimeoutMs`, and output is bounded by `maxOutputBytes` combined across both streams. Set appropriate limits for your application. Abort remains available during final verification.

All limits must be positive safe integers. Baseline and final repetition counts cannot be below 3; candidate counts cannot be below 2. Increasing repetition can expose flakes but does not prove determinism.

`allowInstallScripts` defaults to false. Set it to true only for trusted dependencies whose lifecycle setup is necessary. Source-mutating install scripts may prevent independent verification; the exact exported source must still match its manifest after installation.

`env` lists variable **names**, not values. Essential OS settings such as PATH and locale are inherited; HOME and npm config/cache locations belong to the run. The tool sets CI, disables Next.js telemetry and requests plain output. Required values must be supplied independently by a recipient and are never embedded automatically. Avoid forwarding credentials. Explicitly forwarding loader or module-path variables changes your execution environment and can undermine portability.

## Paths and adapters

`include`, `exclude`, and `preserve` accept project-relative paths, directory prefixes and glob patterns using `/` separators. Ordinary `.gitignore` rules, including nested rules, apply. `include` can override an ignore rule; explicit `exclude` wins. Neither can reintroduce hard-excluded material such as `.env` (including `.env.example`), `.npmrc`, credential keys, `node_modules`, `.git`, `.next`, `dist`, `build`, `.repro` or symbolic links.

`preserve` prevents eligible source from being deleted or rewritten; it does not include a file excluded from the initial inventory. Pinning either `package.json` or `package-lock.json` disables dependency reduction. Package metadata and license/notice files receive default protection from generic reductions.

`adapter` is `auto`, `next` or `generic`. Next.js detection records router and entrypoints, protects framework paths conservatively and guides file proposals. Protection of an entrypoint's path does not pin its contents; use `preserve` if its contents must remain unchanged. Heuristics never replace execution checks.

The snapshot limit is 128 MiB of included source. Installed dependencies are excluded from that limit and from source-byte metrics. Reported source bytes exclude `package.json` and lock metadata. Total snapshot bytes include them. Neither metric includes the generated `.repro` verifier or installed dependencies.

## CLI results

| Command | Purpose |
|---|---|
| `init [project] --match TEXT -- COMMAND ARGS` | Write configuration without overwriting an existing file |
| `doctor [project] [--config FILE] [--json]` | Inventory and runtime/dependency diagnosis; no project code execution |
| `reduce [project] --out DIRECTORY [--config FILE]` | Start a new run outside the source tree |
| `resume DIRECTORY [--max-evaluations N] [--max-seconds N]` | Continue an accepted checkpoint with total-budget overrides |
| `verify EXPORTED_DIRECTORY [--json]` | Independently check the exported source |
| `report RUN_DIRECTORY [--json]` | Rebuild offline HTML and JSON from the checkpoint |

`--json` keeps progress on stderr and emits a structured result on stdout. Exit 0 means the requested command succeeded; `reduce`/`resume`/`verify` require verified export for exit 0. Exit 1 means unverified/paused result, exit 2 means an input or operational error, and an interrupted reduction returns 130 when a result can be checkpointed. Do not treat the application's expected nonzero exit as the CLI's failure.
