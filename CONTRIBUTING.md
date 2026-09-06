# Contributing

The most useful contribution is a case where the reduced export fails to preserve the configured observation, changes the original source, or cannot reproduce independently. Small licensed examples and precise failure checks help more than large log dumps.

## Run locally

Use Node.js 22.18 or newer and npm 10 or newer on Linux or macOS.

```sh
git clone https://github.com/pavangupta352/repro-surgeon.git
cd repro-surgeon
npm ci
npm run check
node dist/cli.js --help
```

Tests use Node's test runner with native TypeScript stripping. Type checking and the published JavaScript build use the pinned TypeScript compiler. Unit and subprocess tests do not need a registry dependency installation; the slower framework validation installs pinned packages separately.

## Make a change

Keep a pull request focused on an observable behavior. Add a regression that demonstrates a correctness bug before the fix, then run `npm run check`. For a new reduction, show both a preserved failure and a candidate that must be rejected. For execution changes, include cancellation, invalid setup, and process cleanup where relevant. For exported output, test the standalone verifier without this package installed.

The [architecture](docs/architecture.md) explains the acceptance contract. Never accept a candidate based only on an import graph or cached observation. Do not weaken the oracle to improve reduction numbers. Keep source and raw logs out of report HTML. Update the relevant documentation when behavior changes.

Run the rounding example through the packaged CLI before proposing release changes. UI changes need keyboard, narrow-screen, empty-state, and hostile-text checks. The generated report must keep working offline.

## Share a case

Include the tool, Node, npm and operating-system versions; the argv command; the required and forbidden diagnostic fragments; and the difference between expected and observed behavior. Review your reproduction and reports for credentials and private information before attaching them. A run directory can contain the original snapshot and raw logs; do not upload the whole directory by default.

Only contribute source you have the right to license under this repository's MIT license. Preserve existing notices. By submitting a contribution, you agree it may be distributed under that license. Be considerate of maintainers' time and follow the [code of conduct](CODE_OF_CONDUCT.md).
