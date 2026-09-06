# Repro Surgeon

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript CLI on Node.js with a generated, standalone HTML report. The report opens locally in a browser and needs no server or network assets.

## Users

Application developers trying to extract a shareable reproduction from a larger failing project, and maintainers who need an independently runnable report.

## Product Purpose

Find a smaller application that preserves an explicit failure check, then export the source and evidence needed to reproduce it independently.

## Positioning

A complete application-reduction workflow: inspect inputs, establish the failure, test reductions, preserve dependency integrity, and independently verify the exported source. Delta debugging and syntax-aware reduction are established prior art.

## Operating Context

Developers run commands in an owned local npm project. They review remaining source before sharing it. Recipients should need only the documented runtime, dependencies, and reproduction command. No account or hosted service is required.

## Capabilities and Constraints

Implemented scope: deterministic command/build failures in single-package npm projects, with a Next.js adapter. Each result preserves the configured oracle; it does not establish semantic root-cause identity or global minimality. Host execution has ordinary local process permissions. No automatic source publication, telemetry, or private-code upload.

## Brand Commitments

Repro Surgeon. Maintained by Pavan. Direct, precise language; measured evidence rather than superlatives. Public materials describe the tool and its use.

## Evidence on Hand

The bundled rounding demonstration and independently written reconstructions of three public Next.js failures have executed reductions, controls and fresh export verification. The validation document records the exact measurements and limits. No competitor advantage, user endorsement or adoption result is claimed. Reports render actual run data; seeded examples and reconstructions are labeled.

## Product Principles

- The exported runnable project is the primary deliverable.
- Execute every acceptance check; never substitute a heuristic for evidence.
- Preserve the source project and make every accepted change inspectable.
- Keep state and reports local, and make remaining uncertainty explicit.
- Optimize for another developer successfully reproducing the failure.

## Accessibility & Inclusion

The HTML report must work with keyboard navigation, visible focus, semantic structure, sufficient contrast, narrow screens, reduced motion, and no external fonts or scripts. Color cannot be the sole indicator of an outcome.
