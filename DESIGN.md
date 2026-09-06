---
name: Repro Surgeon
description: A local evidence sheet for reviewing reduced failure reproductions.
colors:
  signal-green: "#006a62"
  signal-green-soft: "#d6e6df"
  proof-paper: "#f4f0e5"
  deep-paper: "#e9e2d2"
  white-paper: "#fffdf7"
  drafting-ink: "#17211e"
  muted-ink: "#59625d"
  rule: "#a8afa7"
  strong-rule: "#59645e"
  stop-red: "#923b2f"
  stop-red-soft: "#f0dcd4"
  caution-amber: "#805c12"
  caution-amber-soft: "#eee0b7"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2.45rem, 6vw, 5.4rem)"
    fontWeight: 760
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(1.65rem, 3vw, 2.55rem)"
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  measure:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.85rem"
    fontWeight: 700
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 700
    letterSpacing: "0.06em"
rounded:
  precise: "4px"
  status: "999px"
spacing:
  compact: "8px"
  control: "12px"
  section: "44px"
components:
  verification-block:
    backgroundColor: "{colors.drafting-ink}"
    textColor: "{colors.white-paper}"
    padding: "38px 32px"
  action-button:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.white-paper}"
    rounded: "{rounded.precise}"
    padding: "8px 11px"
  evidence-card:
    backgroundColor: "{colors.white-paper}"
    textColor: "{colors.drafting-ink}"
    rounded: "{rounded.precise}"
    padding: "12px"
---

# Design System: Repro Surgeon

## Overview

**Creative North Star: “The Evidence Signal Sheet”**

Repro Surgeon should feel like a printer’s proof sheet crossed with a transit control diagram: calm paper, decisive ink, and signals whose position carries meaning. Density is welcome when it helps a developer follow evidence. The interface should read as a review artifact rather than a generic dashboard.

The first view gives fresh verification the strongest contrast. From there, a continuous route connects the established baseline, reduction decisions, and the exported result. One compact branch marker and count summarize discarded trials; the decision table preserves their individual evidence without forcing the route to grow with run length.

**Key Characteristics:**

- A cream, ink, and signal-green world designed for long technical reading.
- Evidence follows a visible baseline → reduction → fresh-verification path.
- Measurements, statuses, paths, hashes, and commands use a compact mono voice.
- Flat rules and aligned cells carry structure; decoration does not compete with evidence.

**The Evidence First Rule.** Verification state and the before-to-after result must be clear before detailed trial history.

**The Functional Route Rule.** Route geometry must explain process state. Never add literal trains, station illustrations, or decorative subway lines.

## Colors

Signal Green marks verified progress, retained file bars, focus, and the primary copy action. Drafting Ink carries primary text and the verification field. Stop Red is reserved for failed verification and rejected branches; Caution Amber marks invalid, paused, or pending states.

Proof Paper is the normal reading surface, Deep Paper separates the sheet from its surroundings, and White Paper is reserved for command fields and expanded evidence. Muted Ink and the two rule colors organize supporting information without lowering legibility.

**The Restrained Signal Rule.** Use state colors for evidence and action. Large decorative fills should stay neutral except for the dark verification field.

## Typography

Use the system sans stack for narrative text and headings so reports remain fully offline. Use the system monospace stack for measurements, status labels, file paths, commands, hashes, and metadata. Large headings are tightly set and balanced; body copy stays at a conventional reading size.

**The Measured Voice Rule.** Monospace indicates exact material a developer may compare, copy, or audit. It is not a decorative display face.

## Layout

The report is one bounded evidence sheet, up to 1180 pixels wide, with strong horizontal rules between stages. The opening and result use asymmetric two-column grids; trial and file sections use compact rows and aligned metadata. Reading measure is capped near 74 characters.

At 760 pixels, all primary grids collapse to one column and section padding tightens. At 480 pixels, copy controls stack and metadata becomes single-column. Print removes controls and shadows and restores any items hidden by interactive filters.

**The Continuous Sheet Rule.** Sections share edges and rules. Avoid a field of detached cards that breaks the evidence sequence.

## Elevation & Depth

The interface is predominantly flat. The report sheet gets one quiet ambient shadow on screen to suggest a physical proof; internal hierarchy comes from paper tone, ink fields, and rules. Printed output removes the shadow entirely.

**The One Sheet Rule.** Do not add per-card shadows. Evidence groups belong to the same review artifact.

## Shapes

Controls and evidence cells use square or gently precise corners. A 4-pixel radius is the maximum normal rounding. Full pills are reserved for small categorical status labels; circular shapes are reserved for route nodes and branch terminals.

**The Status Shape Rule.** A pill communicates a compact state. It must not become the default container for navigation or actions.

## Components

The verification block is a high-contrast ink field containing status, reason, fresh-run count, snapshot hash, environment, and timestamp. Its color changes only in the compact status stamp.

The evidence route has exactly three semantic nodes: baseline, reduction, and fresh verification. A compact, text-labeled branch count sits beneath reduction; the full trial list carries the per-trial detail.

The reduction result pairs a large source-byte percentage with explicit before-and-after measures for source, files, total snapshot, and dependencies. Zero progress must render as “No reduction accepted.”

Trial rows expose their state and summary at rest, then reveal decision evidence through native details controls. Search and state toggles filter only locally. Retained-file rows pair exact paths and sizes with within-run comparison bars.

The command control keeps the visible, shell-quoted command beside one Signal Green copy button. Copy feedback uses a polite live region and supports a local fallback.

## Do's and Don'ts

- Do lead with fresh verification, including pending and failed states.
- Do show exact configured oracle strings and retained filenames after HTML escaping.
- Do keep controls keyboard operable and focus visible; avoid authored motion in the report.
- Do keep the report self-contained with system fonts and inline CSS and JavaScript.
- Do preserve all evidence when printing, regardless of active filters.
- Don’t embed raw execution diagnostics or source contents in the HTML report.
- Don’t invent metrics, benchmarks, confidence claims, or sample data.
- Don’t use decorative route imagery, gradients, glass effects, or dashboard tile grids.
- Don’t use color as the only explanation of a status.
