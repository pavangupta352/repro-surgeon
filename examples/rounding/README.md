# Rounding regression

A small, deliberately failing application for learning the workflow. No external dependencies. The calculation rounds each fractional line price before summing, producing 33 cents. The assertion expects rounding once at the end, producing 32 cents.

From the Repro Surgeon repository:

```sh
npm ci
npm run build
node dist/cli.js reduce examples/rounding --out /tmp/rounding-repro
node /tmp/rounding-repro/repro/.repro/verify.mjs
```

Choose a new output path for each run. Open `/tmp/rounding-repro/report.html` to inspect the changes. The checker is pinned so the reducer cannot rewrite the assertion. The remaining files and JSON fields are eligible for reduction.

This is demonstration data, not an upstream framework bug or a competitive benchmark. All source is covered by the repository's MIT license.
