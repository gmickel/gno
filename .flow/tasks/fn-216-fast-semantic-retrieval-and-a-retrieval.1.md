---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-216-fast-semantic-retrieval-and-a-retrieval.1 Implement Fast semantic retrieval and a retrieval ladder that uses it

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Vector search on an activated partition no longer cross-checks the vec0 mirror per query (probe + join) and proves input hashes lazily, in rank order, for the candidates it returns; grouping happens before the distance so embedding blobs stay out of the group sorter. Results are identical to the previous filter-then-rank implementation (parity test over a seeded corpus: unscoped, collection, metadata, exclusion, language; k = 1/5/20/500; stale retitled owners). The vec0 mirror stays consistent through same-transaction writes, activation checks and `gno vec sync`; search no longer reads it.

Measured on Gordon's default index (17.6k chunks, RTX 4090): one vector search 17-20 s -> ~75 ms unscoped, ~8 ms collection-scoped; `gno vsearch` 20.2 s -> 2.0 s, `gno query --fast` 19.9 s -> 1.9 s, `gno query` 78 s -> ~6 s one-off; warm (`gno serve`) `query --fast` ~0.17 s, balanced `query` 2.2-2.9 s (expansion ~0.8 s, vector ~0.34 s for 4 variants, rerank ~1.0 s).

Ladder: agents block v4 (query --fast for any other question, balanced query as the retry before diagnose/grep), skill Search Modes table with measured numbers and hardware, MCP gno_query/gno_search descriptions, docs (CLI, MCP, ARCHITECTURE, AGENT-INSTRUCTIONS, README), opt-in `bun run bench:vector-search`. Autoresearch skill eval 47/47.

Review fixes (Sol round 1, NEEDS_WORK -> SHIP): input-hash proofs cached per connection and invalidated by any committed write (data_version + total_changes); owners keep the previous aggregate order (oracle compares unsorted, fixture rebinds a shared owner); fast-first ladder reaches core-profile gno_query/gno_search, gno_vsearch, mcp-reference and the MCP retry strategy.

stage: impl-review - ran (model: gpt-6.1-sol, high) NEEDS_WORK -> SHIP after one fix pass
Not run: `bun run eval:memory` hangs on main as well (file-processor worker cannot start under evalite: "path.replaceAll" / "options.task?.file.pool"); pre-existing.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 4ef0a3181cc9057b3e3a0d73ef8eaceb548ea9e6, 26e83cb38ed6e89fca1175f5732dffa6c3954847
- Tests: bun test (6179 pass, 0 fail), bun run lint:check, bun scripts/docs-verify.ts, bun run eval:hybrid (86%), bun run eval:sessions (100%), autoresearch gno-skill eval 47/47
- PRs: