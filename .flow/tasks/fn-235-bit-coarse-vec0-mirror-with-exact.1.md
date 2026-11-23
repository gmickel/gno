---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-235-bit-coarse-vec0-mirror-with-exact.1 Implement Bit coarse vec0 mirror with exact rescore and cost-based routing

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented fn-235 bit coarse `vec0` mirror with exact float32 rescore, build-time recall self-check, cost-based routing (default OFF per R1), collection-scoped `similar`, and inspection surfaces:

- **R1 (Default-off gate & measured recall):** Two-stage routing ships switched OFF by default (`coarseVectorSearch` unset/false) because local real stored vectors are 46,825 (< 500k required to enable by default). Measured on an isolated copy of 46,825 x 1024d real vectors: build-time recall self-check (16q, `coarseK=200`) = 100.00% (572 ms); 50-query symmetric R@10 (`coarseK=250`) = 100.00% (min 100.0%), R@20 (`coarseK=500`) = 100.00% (min 100.0%), R@40 (`coarseK=500`) = 99.90% (min 97.5%).
- **R2 (Additive v2 bit mirror & full lifecycle):** Added migration v39 (`039-vector-mirror-v2.ts`) creating `vector_partition_rows`, `idx_vector_partition_rows_part_var`, `vector_mirror_v2_state`, and 5 delete-only triggers on `vector_variants`/`vector_owners` touching plain tables only (never `vec0`, never `documents`). Built `vec_v2_<partitionId>` (`collection TEXT PARTITION KEY`, `coarse bit[dims]`) purely in SQL via `vec_quantize_binary(v.embedding)` (handling SQLite Halloween-protection temp B-tree subtype stripping by fetching missing rowids before streaming `INSERT ... SELECT`) while leaving `vec_v1_*` untouched. Wired v2 across constructor, `write`/`writeCurrent`, `release`, `collectGarbage`, `activate`, `v2MirrorState` + `src/embed/variant-backlog.ts`, `syncIndex`, `syncPartitionIndexWithDetails`, `rebuildPartitionIndexWithDetails`, `rekeyLegacy`, `dropVectorPartition`, and `pruneLegacyVectors`.
- **R3 & R4 (Cost-based router & two-stage exact rescore):** Added centralized `src/store/vector/coarse-router.ts` (Rules 1-5: non-collection filter check ignoring mode flags, default-off/exact-override/mirror/self-check/null-cosine/dims%8 guards, 100 ms exact budget `N*(1.05+0.82*Q)`, `k <= 40`, multi-collection cap 2000, `coarseK = clamp(25*k, 200, 500)`). Implemented Stage 1 + Stage 2 in `src/store/vector/variant-search.ts` using `CROSS JOIN` from `json_each` so SQLite seeks only candidate variants/owners (enforcing collection access control on shared variants, exact float32 scores/minScore, owner proof, and exact fallback on underfill).
- **R5 (Build-time recall self-check):** Implemented `runV2RecallSelfCheck` (16 evenly sampled stored vectors, one streaming pass over `vector_variants`, two-stage at `coarseK=200`, floor >= 0.95) invoked on `gno vec sync`, `gno vec rebuild`, and end of `gno embed` for above-budget unchecked clean partitions; never loads an embedding model.
- **R6 (Collection-scoped `similar`):** Scoped same-collection `similar` vector searches via `eligibility: { collection: doc.collection }` across CLI (`src/cli/commands/links.ts`), REST (`src/serve/routes/links.ts`), and MCP (`src/mcp/tools/links.ts`), while preserving unscoped `--cross-collection`.
- **R7 (Inspection, control, schemas, docs):** Added `coarseVectorSearch` config key (`src/config/types.ts`, `docs/CONFIGURATION.md`), `vectorRoute` in `--explain` and retrieval trace payloads (`src/pipeline/explain.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/vsearch.ts`, `src/core/retrieval-trace*.ts`), `coarseMirror` on `vectorPartitions` + `coarse-mirror` check in `gno doctor`, updated `spec/cli.md`, `spec/mcp.md`, `spec/db/schema.sql`, and JSON schemas (`status`, `doctor`, `search-results`, `retrieval-trace-payloads`).
- **R8 (Gates & synthetic latency verification):** `bun run lint:check`, `bun run test:tmp-check`, `eval:memory` (100%), `eval:sessions` (100%), `eval:hybrid` (86%) all pass. End-to-end synthetic latency (median of 3 runs through `searchVectorVariants`/`searchVectorVariantsBatch`): 1.34M x 1024d `k=10` = **285.6 ms warm** (<= 350 ms) / **368.4 ms fresh-open** (<= 500 ms), `k=40` = **634.4 ms warm** (<= 800 ms); 450k x 1024d 4-query batch (`k=10`) = **401.4 ms warm** (<= 900 ms).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 47e25cef3f18e462483606c200f0da8754e1ecc6
- Tests: bun run lint:check, bun run test:tmp-check, bun test test/store/vector/fn-235-coarse-bit-mirror.test.ts, bun run eval:memory, bun run eval:sessions, bun run eval:hybrid
- PRs: