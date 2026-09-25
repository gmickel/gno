---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-184-runtime-independent-vector-identity.1 Implement Runtime-independent vector identity

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Vector partitions are now keyed on model weights, formatter, dimensions, context size and truncation policy only; runtime details (Bun, node-llama-cpp, GPU/CPU backend, threads) are provenance. A runtime reuses a partition after re-embedding up to 8 stored chunks reaches cosine >= 0.99 each (measured: Bun 1.4.2 vs 1.3.14 and thread counts bit-identical; Vulkan GPU vs CPU min 0.999374; distinct chunks max 0.951; CUDA unmeasurable, VRAM occupied by another process), cached per (partition, runtime) in `vector_runtime_verdicts`. Incompatible runtimes and vector-defining identity changes need `gno embed --new-partition` or an interactive yes (`--yes` never confirms); their queries fall back to lexical with a `vector_runtime_incompatible` warning. Migration 031 marks old partitions legacy; the first verified runtime re-keys the most complete compatible one atomically (ties reported, all kept). Status/doctor/API/MCP list `vectorPartitions` (state, owners, provenance, compatible/incompatible runtimes); `gno vec drop` removes shadow or legacy partitions. Tests: test/store/vector/runtime-compat.test.ts covers R1 resume and verdict-write failure, R2 lexical notice and unverified, R3 refusal/fork/identity change, R4 status with shadow and drop restoring status, R5 crash/idempotency/coverage ranking/ambiguity, plus stale-vector reference. gno.sh docs on branch fn-184-vector-identity (worktree ~/work/gno-sh-fn184, commits 4ace2f9 and c59a9cb, not pushed). Follow-up: re-run the autoresearch skill eval for the CLI change.

Tier: session (intelligent)
stage: impl-review - ran (codex gpt-6-astra:medium; round 1 fan-out NEEDS_WORK with 5 findings, round 2 SHIP)
## Evidence
- Commits: 7319be6194c368f7ff2dc99f26413465e6f62a1c, d0bbf9e75ec3ed67e9b463e6769764d7f8b95283, a88362073b15cef8d4dde2c9f78bf8b4893758bd, 64b96bd67863995cd72b41ff12d4c62a9bb60bda, 3c8114c71a593770b2304c09e269bdb6e4b84d5c
- Tests: baseline: green (mise exec bun@1.4.2 -- bun test: 5742 pass pre-edit), mise exec bun@1.4.2 -- bun test (5754 pass, 0 fail), mise exec bun@1.4.2 -- bun test test/store/vector/runtime-compat.test.ts (11 pass), mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, gno.sh: bun run check && bun run typecheck && bun run build (green); vitest 429 pass, 1 unrelated flaky reader-scaffold test passes in isolation, eval:hybrid not run: retrieval ranking unchanged (partition resolution only)
- PRs: