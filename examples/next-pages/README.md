# Owned Next.js Pages Router fixture

This small project is independently authored for Repro Surgeon's integration checks. It is a seeded application failure, not an upstream Next.js bug or a copied reproduction repository. Its `getStaticProps` throws a distinctive error during `next build`; removing that throw gives a passing control.

The fixture pins Next.js 16.3.4 and React/React DOM 19.2.8 for repeatable validation. These are fixture versions, not deployment recommendations. All source is covered by the repository's MIT license.

From the repository root, build Repro Surgeon and run the opt-in integration script:

```sh
npm run build
node scripts/validate-pages.mjs /tmp/repro-pages-validation
```

Use a new output directory. The script downloads the public locked dependencies with installation scripts disabled, executes the fixed and different-error controls, reduces the failure, and freshly verifies the export three times. It also checks that the original fixture's bytes are unchanged. It is intentionally excluded from the default test command, which does not fetch this fixture's dependencies.
