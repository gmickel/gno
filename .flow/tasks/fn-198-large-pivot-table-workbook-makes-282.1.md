---
satisfies: [R1, R2, R3]
---
# fn-198-large-pivot-table-workbook-makes-282.1 Implement Large pivot-table workbook makes 2.8.2 indexing run away in memory

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
The large pivot-table workbook now indexes in seconds, and every file is processed under a per-file budget that stops it mid-step. Two causes, both measured:

1. The markitdown-ts xlsx chain (SheetJS `sheet_to_html` -> jsdom -> turndown + Joplin GFM) is O(columns x rows^2) in the GFM plugin's column-alignment scan and costs about 20 KB per cell. This was pre-existing; the real file (one 23 x 40,439 sheet) blew past memory on 2.8.1 too.
2. 2.8.2's code-span detection ran the GFM table parser, which is quadratic in cells, over converted documents.

What changed:
- **R1 conversion.** New `adapter/xlsx` renders each sheet's Markdown table directly from SheetJS cell data. It reproduces `sheet_to_html` cell text, turndown whitespace and escaping, the GFM cell, empty-header, colspan and single-cell rules, and markitdown's normalization. Markup cells (rich text, links) still go through turndown, cached. Output is byte-identical to markitdown-ts on the fixtures, an edge-case workbook and generated pivot-report workbooks, and tests pin this.
  - Documented change: an unreadable .xlsx is now CORRUPT instead of a retryable ADAPTER_FAILURE.
- **R1 code regions.** Converted documents and records never reach the Markdown parser. A Markdown note with a table over 5,000 cells parses without GFM tables; the only difference is that a code span crossing a table-cell pipe stays whole. The fallback scanner is gone.
- **R2.** Conversion, metadata, tags, memory scopes, code regions, journal structure (previous and next), chunking and link parsing run as one step in a reused, unref'd, terminable file worker, for every file.
  - The main thread stops it mid-step at `conversion.timeoutMs` / `conversion.maxMemoryMb`. The file is recorded as TIMEOUT / MEMORY_LIMIT naming the running step, stays pending, the worker is replaced, and the next file continues.
  - Database reads and writes stay on the main thread.
  - Compiled executables and injected test doubles prepare in-process with checks between steps (documented).
- **R3.** The slow-file notice fires while a step runs. Budget stops are listed in update output, `gno status` and the audit.

Live QA (evidence in `.flow/tmp/qa-fn-198-large-pivot-table-workbook-makes-282/round3/`):
- Real-shape workbook (23 x 40,439, ~770k shared-string refs, pivot records 16.4/14.7 MB): fixed 5.9 s / 1674 MB. v2.8.1 and origin/main were killed at the 6 GB cap (12.6 s / 15.1 s, 0 docs).
- Earlier default workbook: fixed 2.1 s / 1024 MB; v2.8.1 8.8 s / 3120 MB; origin/main killed at 300 s.
- 40k- and 80k-row Markdown tables under a 1 s budget: TIMEOUT at 1000 ms during code-region detection, 1.8 s total, and the notice fired.
- 1,000 small notes: 2257 ms vs 2148 ms before round 3 (+5.1%, 5 interleaved runs).

Tier: session model (in-host worker)

stage: impl-review - ran (conductor-owned codex reviews: NEEDS_WORK rounds 1-2; findings addressed in c53774e2, 2a65ba89, f64cfbfa)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f68f7ab82f1ee47f5c01985e39b1ec1cef831a58, 787bad2e317ca7179097060201c7a2632eb5c12c, ae2c795d47b7324325caff5f9a61179c2683f726, c53774e2087c29429dd2baee8216572d29abd3ac, 42eb83e200eef8a0d7606d00f633dc2f97964f6c, 1a3eeeb1282ea151dd08366ec6993c7e2cc2123b, 2a65ba89aa6b2372473753804a12898bab14eba6, f64cfbfa9d6c9148f97af2991711963b0939e5e1
- Tests: mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun run docs:verify, mise exec bun@1.4.2 -- bun test: 5983 pass, 0 fail, red-first on 2a65ba89/1a3eeeb1: xlsx linearity via registry 15.7 s / 5.5 GB; mid-step Markdown stop 14.9 s; worker recycle; in-process checkpoints, xlsx equivalence vs markitdown-ts: byte-identical on sample.xlsx, edge-case workbook, real-shape scale 0.005/0.01/0.03, live QA round3: real-shape fixed 5.9 s/1674 MB, v2.8.1 and origin/main killed at 6 GB; Markdown 40k/80k rows stopped at 1000 ms; 1000 notes +5.1%, gno.sh gno-sh-fn198 c9e9e9f: check, typecheck, test (431), build; driven at 1380 and 375 px
- PRs: