# Public walkthrough

The [public walkthrough](https://pavangupta352.github.io/repro-surgeon/) is generated from the installed CLI's bundled rounding example. Its replay is a condensed sequence of recorded accepted changes, not a browser execution or a simulated reduction. The full report preserves rejected and invalid trials.

Build it from a repository checkout:

```sh
npm ci
npm run build:site
```

This runs `demo` in a temporary directory, requires three successful fresh export checks, and writes `site/dist/`. Serve that directory with any static HTTP server. No account, external fonts, analytics or browser source upload is involved.

The build copies an allowlisted evidence record, the sanitized HTML/JSON reports, and the verified reproduction. The downloadable archive excludes macOS metadata and includes its own verifier, license and integrity manifest. `SHA256SUMS` identifies the exact downloadable bytes. Private snapshots and raw logs are not published. Because recording timestamps vary, rebuilding produces a new archive and checksum.

GitHub Actions builds and deploys the site to GitHub Pages when a release is published, or when the Public demo workflow is run manually. The workflow uses Node 22.18 and pinned action revisions. The CI matrix also builds the site once on Linux before a release.

The page uses the same paper, ink and signal colors as the offline report. Stage controls, replay and copy actions support keyboard input; reduced-motion preferences disable smooth scrolling. Without a recording, the source download and report links remain available. With JavaScript disabled, the page explains that the walkthrough cannot play.
