---
satisfies: [R6, R7, R8]
---

## Description

Build the **shared `diagnoseQueryTarget()` core** that explains where a named target document hits/misses across pipeline stages, and expose it via `gno query diagnose "<query>" --target <doc>`. Requires opt-in trace capture in the hybrid pipeline (the normal path discards the needed state). Non-CLI entry point that REST (.5) and MCP (.6) also wrap. Must work BM25-only.

**Size:** M (upper edge — scoped to diagnose-only plumbing, no hot-path refactor)
**Files:** `src/pipeline/diagnose.ts` (new) or `src/pipeline/explain.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/fusion.ts`, `src/pipeline/types.ts`, `src/cli/commands/query.ts`, `src/cli/program.ts`, `src/cli/options.ts`, `spec/cli.md`, `spec/output-schemas/query-diagnose.schema.json`, `docs/CLI.md`, `test/pipeline/*.test.ts`, `test/cli/*.test.ts`, `test/spec/schemas/validator.ts`, `test/spec/schemas/*.test.ts`

## Approach

- **Why not just `explain.ts`:** `searchHybrid` (`hybrid.ts:250`) discards raw per-source BM25/vector scores, per-stage candidate lists, absent-target info, and filter-drop reasons after RRF. Add an **opt-in trace** option to `searchHybrid` (gated — off for normal queries, **no perf regression**) that records, per stage, the candidate doc/chunk ids + **raw scores before RRF** (RRF is rank-based; magnitudes are lost after). Thread trace types through `pipeline/types.ts`; capture pre-fusion ranks in `fusion.ts`.
- **`diagnoseQueryTarget(deps, query, target, options)`** (the shared deliverable) — `deps` mirror `searchHybrid`'s dependencies (store + ports), `options` carry model/depth-policy/filters; don't hide them in a bare `filters` arg. Resolve the target first (via the core `src/core/ref-parser.ts` from task .9), fetch its document + chunk ids, run the traced pipeline, then compare the target's chunk ids against each stage's candidate set. This is what makes `not_in_candidate_set` (retrieval miss) vs `below_cutoff` (ranking miss) decidable — reuse `buildExplainResults`/`explain*` (`explain.ts:207`) for per-result sub-scores.
- **`targetStatus`** (set before stage tracing): `not_found` (ref doesn't resolve), `inactive` (resolved doc not active/indexed), `no_indexed_content` (no `mirrorHash`/chunks), `filtered_out` (excluded by an active filter pre-retrieval), `diagnosed` (full stage trace produced). Only `diagnosed` runs the per-stage comparison.
- **`filtered_out` must evaluate the FULL query filter set** the live query path applies — collection, tags, `lang`/chunk language, `exclude`, category/`contentType`, author, date — not only `matchesDocumentFilters` (`graph-retrieval.ts:58`, which covers author/contentType/category) plus `tags` via the separate tag filter. Centralize the filter evaluation so diagnose and the real query agree.
- Per-stage payload: `present`, `rank`, `score`, `survived`, `dropReason`. Typed metadata reads `contentType`, persisted `content_type_source` from task .1, categories, fingerprint match/mismatch, **`graphHints`** (the target's content-type hints from task .2, surfaced as a real field), plus chunk/line explanation.
- **BM25-only:** absent embeddings → **vector** stage `skipped` (reason) and **rerank** `skipped` when disabled/unavailable, but **fusion stays active with `sourceCount: 1`** (RRF still runs over the single BM25 source — do NOT mark fusion skipped). Never a false `present:false`.
- `gno query diagnose` registered near query wiring (`program.ts:511`, `query.ts:78`) + `options.ts` `CMD`. New `query-diagnose.schema.json` with required `schemaVersion`; deterministic payload (fixed ordering, no timestamps) + contract test. `program.ts`/`spec/cli.md` query region is disjoint from task .3's graph region.

## Acceptance

- [ ] `diagnoseQueryTarget(deps, query, target, options)` exists as a **non-CLI entry point** (deps mirror `searchHybrid`) consumed by CLI/REST/MCP; resolves target first + fetches its chunks
- [ ] `filtered_out` evaluates the full filter set (collection, tags, lang, exclude, category/contentType, author, date), centralized so diagnose == live query
- [ ] `query-diagnose.schema.json` registered in `validator.ts` `schemaFiles`
- [ ] Opt-in pipeline trace captures per-stage candidate doc/chunk ids + raw pre-RRF scores; **normal query path unchanged (no perf regression)**
- [ ] Distinguishes `not_in_candidate_set` from `below_cutoff`; reports per-stage `present/rank/score/survived/dropReason`, filters, typed metadata, chunk/line
- [ ] Reports `targetStatus` (`not_found|inactive|no_indexed_content|filtered_out|diagnosed`); only `diagnosed` runs stage comparison
- [ ] BM25-only: vector `skipped`, rerank `skipped` when off, **fusion active with `sourceCount:1`** (not skipped); never false misses
- [ ] `gno query diagnose` wraps the core; registered in `options.ts`; `query-diagnose.schema.json` (with `targetStatus` enum + per-stage `status`/`sourceCount`) added with required `schemaVersion` + contract test
- [ ] `spec/cli.md` + `docs/CLI.md` query section updated
- [ ] Deterministic regression tests: BM25-only (fusion sourceCount:1), with-embeddings, target-found-wrong-chunk, target-missing, and each non-`diagnosed` targetStatus

## Done summary

Implemented targeted query diagnostics and `gno query diagnose`.

- Added shared non-CLI `diagnoseQueryTarget()` core with target-first ref resolution, target states, filter evaluation, typed metadata, graph hints, and chunk/line reporting.
- Added opt-in hybrid pipeline trace for BM25, vector, fusion, graph, and rerank stages without changing normal query behavior.
- Added `query-diagnose.schema.json`, validator registration, CLI/spec/docs updates, pipeline tests, schema tests, and CLI smoke.
- Fixed command dispatch so normal queries beginning with `diagnose` are not hijacked unless `--target` is supplied.
- RepoPrompt implementation review returned SHIP.

## Evidence

- Commits:
- Tests: bun run lint, bun run lint:check, bun test test/pipeline/diagnose.test.ts test/spec/schemas/query-diagnose.test.ts test/cli/commands/links.test.ts (30 pass), bun test test/pipeline test/spec/schemas test/cli/commands/links.test.ts test/store/adapter.test.ts test/store/fts.test.ts (360 pass)
- PRs:
