# Offline report surface

The report is the review surface for one `RunReport`. It answers three questions in order: did the exported snapshot reproduce under fresh verification, how much was removed while preserving the configured failure, and what evidence should a developer inspect before sharing it?

The visual direction is **The Evidence Signal Sheet**. A continuous route connects baseline, reduction, and fresh verification. One compact branch marker and count summarize discarded trials beneath the reduction stage, while the full trial list keeps each decision inspectable and the retained-file list shows what reached the verified endpoint. This is functional process navigation; it does not use literal transit imagery.

The first viewport combines run identity with the highest-contrast verification block, then exposes the complete evidence path and a large before-to-after source result. Detailed sections follow in this order:

1. Reduction decisions with local text search, accepted/rejected/invalid filters, and expandable decision evidence.
2. Retained files with local path search, exact byte counts, and within-run size bars.
3. Runtime and adapter metadata.
4. Findings, warnings, and excluded paths that need review before sharing.

Every value in the document comes from the supplied report or a transparent calculation over its recorded metrics. The report uses honest empty and interrupted states: pending or failed verification, a paused or failed run, no accepted reduction, no trials, no retained files, and no review findings all receive explicit labels.

The HTML is a single offline file with inline CSS and JavaScript, system fonts, and no remote assets. Search, filters, native details controls, and command copy work without a server. The copy action includes a legacy local fallback and reports its result in a polite live region. Responsive layouts preserve the reading sequence, focus is conspicuous, and print output exposes evidence hidden by interactive filters. The report authors no motion effects, so it does not need a global reduced-motion reset.

All report strings are HTML-escaped before insertion. Exact user-configured oracle strings and filenames remain visible because they are essential review evidence. A shared public-data projection removes raw trial diagnostics and replaces private setup/verification errors with generic failure summaries before both HTML and JSON output, including direct API calls. Baseline labels use explicit completed/required observation counts rather than inferring evidence from the overall run status. Keep detailed errors in the private checkpoint and logs.

The implementation deliberately avoids a generalized dashboard, comparative benchmark claims, and inferred confidence scores. It does not imply that completion equals verification: run state and fresh-verification state remain separate and can disagree visibly.

Browser QA should confirm the route at desktop and narrow widths, filter counts and zero-result behavior, keyboard focus order, copy success and fallback messaging, details expansion, print output, and every failed/paused/empty state with actual engine-produced reports.
