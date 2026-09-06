# Repro Surgeon

**Shrink the project. Keep the failure. Hand over something runnable.**

[![CI](https://github.com/pavangupta352/repro-surgeon/actions/workflows/ci.yml/badge.svg)](https://github.com/pavangupta352/repro-surgeon/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/repro-surgeon?color=006a62)](https://www.npmjs.com/package/repro-surgeon)
[![License: MIT](https://img.shields.io/badge/license-MIT-006a62)](LICENSE)

“Can you provide a minimal reproduction?” is often the hardest part of a bug report.

Repro Surgeon takes a failing npm application, removes source that isn't needed for your failure check, and exports a smaller project with its own verifier. It tests every accepted change and checks the export again with a fresh dependency installation. Your original project stays in place.

No account. No telemetry. Source and reports stay local.

[![An actual rounding example reduced from 10 files to 5, with three independent verification runs](https://raw.githubusercontent.com/pavangupta352/repro-surgeon/main/docs/assets/report.png)](https://pavangupta352.github.io/repro-surgeon/)

*Actual bundled demonstration: 3,173 → 520 source bytes, 10 → 5 files, 115 evaluations. The assertion remains pinned. This is a small seeded example, not a framework benchmark. [Replay the run and download its verified result](https://pavangupta352.github.io/repro-surgeon/) · [Method and evidence](docs/validation.md).*

## Try it

Requires **Node.js 22.18+ and npm 10+**, on Linux or macOS.

```sh
npx repro-surgeon@0.2.0 demo --out ./rounding-repro
node ./rounding-repro/repro/.repro/verify.mjs
```

No clone or configuration needed. The first command reduces the bundled example, generates an offline report and verifies the export three times. The second runs the exported verifier independently.

Choose a new output directory for each run. Open `./rounding-repro/report.html` to inspect the result. The verifier exits successfully when the application's **expected failure** occurs; the original application command still exits with its configured failure code. You can also [explore the recorded walkthrough in your browser](https://pavangupta352.github.io/repro-surgeon/) before installing anything.

Install the packaged release for your own projects:

```sh
npm install --global repro-surgeon@0.2.0
```

The same package is available from the [versioned GitHub release](https://github.com/pavangupta352/repro-surgeon/releases/tag/v0.2.0), with a checksum. You can also run `npx repro-surgeon@0.2.0 --help`.

## Reduce your application

Start from a project whose failure reproduces with a finite command and a committed npm lockfile.

```sh
repro-surgeon init ./my-app \
  --match "the distinctive diagnostic from your failure" \
  -- npm run build

repro-surgeon doctor ./my-app --json
repro-surgeon reduce ./my-app --out ./my-app-repro
```

Replace the example diagnostic with text from your actual error. Use several `--match` fragments to identify it precisely, and `--forbid` to reject a known competing error. Pin your test harness or other essential source with `preserve` in `repro-surgeon.json`.

```json
{
  "version": 1,
  "command": ["npm", "run", "build"],
  "oracle": {
    "exitCode": 1,
    "allOf": ["Parsing CSS source code failed", "Unexpected end of input"],
    "noneOf": ["Module not found"]
  },
  "preserve": ["scripts/check.mjs"],
  "budget": { "maxEvaluations": 200, "maxSeconds": 900 }
}
```

The failure check is the contract. A broad phrase such as `failed` can match the wrong problem. Try a fixed control and a deliberately different failure before starting an expensive run. Repeated matching output does not establish identical semantic root cause.

## What you get

```text
my-app-repro/
├── repro/                  # Reduced application to inspect and share
│   ├── package.json
│   ├── package-lock.json
│   ├── … retained source
│   └── .repro/
│       ├── README.md       # Runtime, command and verification instructions
│       ├── config.json
│       ├── LICENSE         # License for the generated verifier code
│       ├── manifest.json   # Source and metadata integrity records
│       └── verify.mjs      # Runs without Repro Surgeon installed
├── report.html             # Offline, searchable evidence
├── report.json             # Machine-readable report
└── … private run state     # Original snapshots and raw logs; keep private
```

The report shows accepted, rejected and invalid trials, before/after metrics, remaining files, the exact failure check and the fresh verification outcome. Search and filters work offline.

**Review the `repro/` folder before sharing it.** Exclusions and review findings help locate sensitive material; they do not certify that a reproduction is safe to publish. The full run directory contains original source and logs.

## How the reduction works

1. **Establish the failure.** Three uncached baseline observations must match.
2. **Try smaller source.** Remove file groups and complements, syntax elements, JSON fields and direct npm dependencies. Keep retained dependency versions and integrity records fixed.
3. **Confirm every accepted candidate.** Require two matching executions. Timeouts, signals, installation failures, output overflow and spawn failures are invalid, never evidence of preservation.
4. **Export and verify independently.** Copy the result into a separate temporary directory, install dependencies afresh and check three times. The standalone verifier checks the exported file manifest as well.

The search seeks fewer source bytes, then fewer files, fewer declared dependencies and fewer total bytes. It finds the smallest candidate reached by the enabled passes within your budget; it does not promise a globally minimal program.

## Stop, resume and inspect

Press Ctrl-C to checkpoint the accepted snapshot and stop child processes.

```sh
repro-surgeon resume ./my-app-repro --max-evaluations 500 --max-seconds 1800
repro-surgeon verify ./my-app-repro/repro
repro-surgeon report ./my-app-repro
```

Resume budgets are **new total limits**, including earlier search time and evaluations. After a normal search budget stop, the current best result still gets a separately bounded export verification. A baseline interrupted before calibration completes remains paused. Resume requires the same tool, Node, npm, platform and architecture. See [troubleshooting](docs/troubleshooting.md) for crash locks and incompatible environments.

## Supported scope

| Works with | Boundary |
|---|---|
| Single-package npm applications | `package-lock.json` version 2 or 3; public portable registry dependencies |
| Deterministic command and build failures | Explicit argv, exit code, required and forbidden literal text |
| Next.js application structure | App/Pages Router detection and conservative entrypoint protection |
| JavaScript, TypeScript, JSX, TSX and JSON | Syntax-aware source edits and JSON/JSONC field removal |
| Linux and macOS | Runtime/OS matrix in CI; Windows is not yet supported |

npm workspaces, pnpm/Yarn lockfiles, shrinkwrap, local/Git/private dependencies, browser recording, and managed service startup are outside this release. Existing syntax errors can be preserved by file reduction; malformed files are skipped by structural passes. [Full configuration](docs/configuration.md) · [Architecture](docs/architecture.md) · [Validation](docs/validation.md).

## Local execution, plainly

Commands execute with your host permissions. This is **not a security sandbox**. Run trusted source, or put the entire workflow inside your own isolated environment. Install scripts are disabled unless you enable them. Network access is required for uncached dependencies; your command may also use the network. Common credentials, environment files, generated output and symlinks are excluded. Only explicitly requested environment variables are inherited beyond operating-system essentials. [Security policy](SECURITY.md).

## Run the checks

To develop from source:

```sh
git clone https://github.com/pavangupta352/repro-surgeon.git
cd repro-surgeon
npm ci
npm run check
npm run test:package
node dist/cli.js demo --out /tmp/rounding-repro
```

The native suite does not fetch framework fixture dependencies. Run these optional integrations separately; they download public pinned packages and the Next.js checks take several minutes:

```sh
node scripts/validate-dependency.mjs /tmp/repro-dependency-validation
node scripts/validate-pages.mjs /tmp/repro-pages-validation
node scripts/validate-next.mjs /tmp/repro-framework-validation
```

Choose new output directories. The scripts check fixed and different-error controls, preserve the original source, and verify the reduced exports. [Measured results and limitations](docs/validation.md).

## Related work and contributions

This builds on [delta debugging](https://www.st.cs.uni-saarland.de/papers/tse2002/) and shares the goal of property-preserving reduction with [treereduce](https://github.com/langston-barrett/treereduce). [Replay](https://www.replay.io/debugging) addresses recorded execution. Repro Surgeon focuses on the path from an application source tree to an independently installable, verified reproduction. No comparative superiority is claimed.

A frozen single-file comparison against treereduce is [published with inputs, controls and query counts](docs/comparison.md). From the same 938-byte authored example, treereduce produced 334 bytes in 2.956 seconds and Repro Surgeon produced 248 bytes in 4.080 seconds. Both passed three fresh checks. That mixed result describes this fixture only; it is not a full-application benchmark.

Have a failure this cannot reduce reliably? A small licensed case with a precise failure check is especially useful. Read [CONTRIBUTING.md](CONTRIBUTING.md), open an [issue](https://github.com/pavangupta352/repro-surgeon/issues), or improve a reducer with a regression test.

Maintained by [Pavan](https://github.com/pavangupta352). [MIT licensed](LICENSE).
