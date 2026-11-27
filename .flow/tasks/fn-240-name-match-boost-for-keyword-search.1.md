---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-240-name-match-boost-for-keyword-search.1 Implement name-match boost for keyword search

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented opt-in title/filename name-match boost in `SqliteAdapter.searchFts` for issue #372:
- Added `nameBoost?: boolean` on `FtsSearchOptions` and internal `nameBoost?: boolean` on `SearchOptions`; enabled in `src/pipeline/search.ts` (`searchBm25`, defaulting to `true`) and `src/pipeline/hybrid.ts` (`searchFtsChunks`). Kept `src/core/memory-recall.ts` (`nameBoost: false`), `src/core/memory-remember.ts`, and `src/core/activation-probe-plan.ts` unboosted.
- Added single-scan `MATERIALIZED` CTE (`all_matches`) unioning top `limit` normal BM25 rows with up to `50` eligible `name_score < 0` rows; kept unboosted SQL byte-for-byte unchanged.
- Returned distinct positive query terms from `buildFts5Query`, computed title/filename coverage and multiplier (`3x` full match, `1 + (q*n)^2` when `q == 1 || n == 1`, `1` otherwise), applied `minRelativeScore` on raw BM25 before boosting (fixing P2 finding from review), then sorted and cut to `limit`.
- Added 23 unit, store/pipeline integration, and tokenizer-safety tests in `test/store/fts-name-boost.test.ts`.
- Updated `docs/adr/002-bm25-query-semantics-and-weighting.md`, `docs/CLI.md`, `spec/cli.md`, `CHANGELOG.md`, and opened matching `gmickel/gno.sh#104`.
- Verified `bun run lint:check && bun run test:tmp-check` (6,667 pass, 0 fail, empty TMPDIR), unchanged evals (`vsearch` 88%, `query` 90%, `hybrid` 86%, `eval:memory` 100%, `eval:sessions` 100%), snapshot harness parity (64.3% -> 97.8% name hit@1, body unchanged 20.0/36.3/58.3, p95 26.7ms -> 27.5ms), and isolated live CLI QA.

stage: impl-review - ran (verdict: SHIP; 1 P2 finding fixed in c1c92a0f) (model: gpt-6.2-sol)
stage: completion-review - skipped(policy: single-task, per-task SHIP covers spec surface)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: be10ad5cda78a3f3d91c638b89867bf1fa0a3029, b74fc9b1765db0aa70ba441d8486d7474531b055, c1c92a0f163dcd2832089fb54c2acd8133567f3d
- Tests: bun run lint:check && bun run test:tmp-check
- PRs: