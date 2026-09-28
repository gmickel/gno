---
satisfies: [R1, R2, R3, R4]
---
# fn-199-follow-ups-after-283-huge-markdown.1 Implement follow-ups after 2.8.3

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
All four follow-ups are done. R1 and R2 are fixed in product code. R3 now has a test that diagnoses itself, and the spec records what was ruled out. R4 is committed in a gno.sh worktree and not pushed.

- **R1.** The superlinear step was code-region detection, not chunking or links. Without table rules a large table is one paragraph, and micromark rescanned it on every unmatched `]` (`labelEnd`, `gfmPotentialFootnoteCall`) and every unclosed `<!--` (`htmlText`).
  - Link extraction had two quadratic paths: an unclosed `[[` rescanned by the wiki regex, and `rangeIntersectsExcluded` scanning every range for each link.
  - Fix: the table-less parse now also leaves out those three constructs. The HTML-comment scan, the wiki-link match and the range lookup are single-pass rewrites, each proven equal to its old definition by a randomized equivalence test.
  - Result: a 23 x 40,000 pivot-shaped note went from `TIMEOUT` at 60 s on the base commit to 3.3 s through `gno update`.
  - Regression pins: `test/ingestion/strip.test.ts` "stay linear with ..." fails on the base commit and passes here. The new budget-difference cases (a backtick in a link destination or an inline HTML tag) cover the declared change.
- **R2.** A collection whose only activation problem is `no_documents` is informational. `activation.healthy` stays true, and the remediation is `gno update`.
  - Doctor gives it a new `info` check status (icon `i`) and does not exit 2 for it.
  - `gno status` shows `no documents yet` (`NO DOCUMENTS YET` when every collection is empty).
  - `/api/status` keeps the health check `ok` with a summary that names the empty collection, and onboarding and the Web UI card say the same.
  - An empty collection no longer projects pending connector proofs.
  - MCP `gno_status` never presented activation, so it was already consistent.
  - Schemas updated: `doctor.schema.json` (check status `info`, descriptions of `usable` and `healthy`) and `status.schema.json` (descriptions).
  - Tests: `test/cli/doctor.test.ts` (a real failure through an FTS desync still exits 2; the empty-collection case; mixed details), `test/cli/status.test.ts`, `test/core/activation-status.test.ts`, `test/serve/api-status.test.ts`.
- **R3.** `update` was the process that hung. The same hang appears in 5 Windows runs since 2026-09-24, and the fn-198 worker and the fn-189 flush are ruled out; the spec has the full findings.
  - No product cause is proven, so there is no product fix. Timeouts are unchanged.
  - `test/cli/concurrency.test.ts` now captures every child's output. A watchdog fires 3 s before bun's timeout, names and kills the child that has not exited, and fails with each child's timings and output tails. This was checked against a simulated hang.
- **R4 (gno.sh).** Worktree `/home/gordon/work/gno-sh-fn199`, branch `fn-199-trace-graph`, commit `6922b6d`, not pushed.
  - One `gno graph --include-isolated --include-similar --threshold 0.5 --similar-top-k 2` call replaces the per-node `gno similar` loop, and the stale comment is gone. The figure data keeps its shape.
  - Edge counts on the same throwaway index: 207 before and 207 after, with the same pairs, the same scores and 23 cross-collection edges. Graph similarity without `--collection` spans all collections, so its scope equals `--cross-collection`.
  - The same commit carries gno.sh docs for R1 and R2 (`src/lib/gno-docs.tsx`: the install verify, troubleshooting `#activation` and `#large-spreadsheet` pages).
  - gno.sh `check`, `typecheck` and `build` pass.
- **Docs in this repo:** CHANGELOG [Unreleased], `docs/CLI.md`, `docs/API.md`, `docs/TROUBLESHOOTING.md`, `docs/ARCHITECTURE.md` and `spec/cli.md`. The SPA snapshot was rebuilt for the `BootstrapStatus.tsx` change.
- **Follow-ups, not built:**
  - Graph similarity computes edges for at most 200 nodes and records a `meta.warnings` entry. The trace-graph export would silently thin its edges if the fixture vault grew past 200 notes, so the script could surface that warning.
  - Past 200k cells, micromark's own paragraph parse still grows by about 2.5x per doubling, and a plain table does the same.

stage: impl-review - skipped(config: REVIEW_MODE=none)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 0d2d55fa347925d927f50a1c3fea7396a376d0f9
- Tests: bun test, bun run lint:check, bun run docs:verify, bun test test/ingestion/strip.test.ts test/core/links.test.ts test/cli/doctor.test.ts test/cli/status.test.ts test/core/activation-status.test.ts test/serve/api-status.test.ts test/cli/concurrency.test.ts, gno.sh (/home/gordon/work/gno-sh-fn199 @ 6922b6d): bun run check && bun run typecheck && bun run build
- PRs: