---
satisfies: [R1, R2, R3]
---
# fn-198-large-pivot-table-workbook-makes-282.1 Implement Large pivot-table workbook makes 2.8.2 indexing run away in memory

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Fixed the 2.8.2 workbook runaway and added a per-file conversion budget. Root cause, confirmed by CPU profile on a generated pivot-shaped workbook: 2.8.2 ran the CommonMark/GFM parser for code regions over converted documents. A converted spreadsheet is one GFM table per sheet, and micromark-extension-gfm-table's edit map is quadratic in cells (93% of CPU in edit-map addImplementation and flushCell). Time grew 4x per doubling of rows; a 20,000-row table took 109 s.

- R1: converted and record output never reach the Markdown parser. Markdown notes over 1 M chars, or with a blank-line block holding more than 5,000 table pipes, use the linear 2.8.1 fence and code-span scanner (documented fallback: no indented-code detection there). Generated workbook, default shape (`scripts/generate-large-workbook.ts`): base killed at 300 s with 0 docs written; fixed 8.9 s / 3245 MB peak vs v2.8.1 9.1 s / 3168 MB. Scale 0.5/1/1.5: 5.4/8.9/13.2 s vs 4.9/9.1/13.1 s on 2.8.1.
- R2: PDF/Office conversion runs in a reused, unref'd Bun worker, terminated past `conversion.timeoutMs` (default 60 s) or when process RSS passes `conversion.maxMemoryMb` (default half of RAM, min 2048). The file is recorded TIMEOUT / MEMORY_LIMIT, the rest of the collection indexes, and the next sync retries it. Tests: `test/ingestion/sync-conversion-budget.test.ts`, `test/config/conversion-budget.test.ts`.
- R3: a file still converting after 10 s (or half its budget) is named on stderr by update/index. Budget stops are always listed in update output, in `gno status` ("Stopped at conversion budget"), and in the audit freshness finding, which now carries the code.
- Trade-off: the worker adds roughly 0-15% peak RSS on very large conversions (w600 workbook: 5.9 GB vs 5.2 GB on 2.8.1). The pre-existing converter is itself O(columns x rows^2) in turndown's GFM plugin (jsdom `HTMLCollection.namedItem`); left as a follow-up.

Tier: session model (in-host worker)

stage: impl-review - skipped(policy: repo rules and dispatch - no model review)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f68f7ab82f1ee47f5c01985e39b1ec1cef831a58, 787bad2e317ca7179097060201c7a2632eb5c12c
- Tests: mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun test (5978 pass, 0 fail), mise exec bun@1.4.2 -- bun run docs:verify, baseline: none recorded pre-edit (spec defines no Quick commands); red-first: new strip regression test timed out at 109 s on base commit, live QA: .flow/tmp/qa-fn-198-large-pivot-table-workbook-makes-282/ (base killed at 300 s with 0 docs; fixed 8.9 s / 3245 MB vs v2.8.1 9.1 s / 3168 MB), gno.sh (worktree gno-sh-fn198, 210bff4): bun run check, typecheck, test, build; pages driven at 1380 and 375 px
- PRs: