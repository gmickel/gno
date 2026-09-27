---
satisfies: [R1, R2, R3]
---
# fn-198-large-pivot-table-workbook-makes-282.1 Implement Large pivot-table workbook makes 2.8.2 indexing run away in memory

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Fixed the 2.8.2 workbook runaway and put every file under a per-file budget covering conversion and post-conversion work. Root cause, confirmed by CPU profile on a generated pivot-shaped workbook: 2.8.2 ran the CommonMark/GFM parser for code regions over converted documents. A converted spreadsheet is one GFM table per sheet, and micromark-extension-gfm-table's edit map is quadratic in cells (93% of CPU in edit-map addImplementation and flushCell).

Review rework (codex impl-review NEEDS_WORK, findings A and B):
- A: the hand-rolled fallback scanner is deleted. A Markdown note with a table over 5,000 cells is parsed by the same mdast parser without the GFM table extension (autolink literal, footnote, strikethrough, task list kept), so code rules stay CommonMark-correct. The only difference, a code span crossing a table-cell pipe staying whole, is documented and tested. The three review reproductions (fences in frontmatter/HTML comments, code spans across paragraphs or after a backslash, fences in blockquotes) are regression tests, identical below and above the threshold; each failed on the previous head. Converted documents and records never reach the Markdown parser and produce no journal link summaries. Measurements without tables: 20k/40k/80k-row table 0.9/2.7/9.2 s; prose 1/2/4/8 M chars 0.7/1.3/2.9/7.0 s. The residual superlinearity is micromark core `resolveAllText` (events.splice inside one paragraph), which only an unbroken giant table in a Markdown note reaches.
- B: one per-file clock and memory ceiling. Office/PDF conversion runs in a worker that is terminated at the limit; metadata, code regions, journal structure, chunking and link parsing (moved ahead of the write transaction) are followed by cooperative time and process-RSS checkpoints. An overrun records TIMEOUT / MEMORY_LIMIT, leaves the file pending, and continues. This applies to native Markdown/text files and compiled binaries too. What is not enforced: a running synchronous step is not interrupted (live: an 80k-row Markdown table ran 14.4 s against a 3 s budget before being stopped after code-region detection), and the slow-file notice cannot fire while such a step blocks the event loop. Test: `test/ingestion/sync-conversion-budget.test.ts` (slow-chunker post-conversion overrun, workbook TIMEOUT, memory ceiling for workbook and native Markdown, retry).
- Live QA (default fixture): origin/main killed at 300 s with 0 docs; v2.8.1 10.3 s / 3142 MB; fixed 10.3 s / 3089 MB. Evidence: `.flow/tmp/qa-fn-198-large-pivot-table-workbook-makes-282/rework/`.
- Dependencies: the GFM sub-extensions are now exact direct dependencies, at the versions already locked through micromark-extension-gfm 3.0.0 / mdast-util-gfm 3.1.0.

Tier: session model (in-host worker)

stage: impl-review - ran (conductor-owned codex review: NEEDS_WORK, findings addressed in c53774e2)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f68f7ab82f1ee47f5c01985e39b1ec1cef831a58, 787bad2e317ca7179097060201c7a2632eb5c12c, ae2c795d47b7324325caff5f9a61179c2683f726, c53774e2087c29429dd2baee8216572d29abd3ac, 42eb83e200eef8a0d7606d00f633dc2f97964f6c
- Tests: mise exec bun@1.4.2 -- bun run lint:check (0 errors), mise exec bun@1.4.2 -- bun run docs:verify, mise exec bun@1.4.2 -- bun test: 5977 pass, 1 fail (test/eval/acceptance/fixtures.test.ts forward indexes: pre-existing 5 s timeout, reproduced identically on base 5643a02e), red-first: 3 review reproductions failed on ae2c795d; post-conversion overrun test failed on ae2c795d, live QA rework: origin/main killed 300 s 0 docs; v2.8.1 10.3 s/3142 MB; fixed 10.3 s/3089 MB (.flow/tmp/qa-fn-198-large-pivot-table-workbook-makes-282/rework/), gno.sh gno-sh-fn198 c7e86a1: check, typecheck, test (431), build; driven at 1380 and 375 px
- PRs: