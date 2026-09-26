# fn-136-fix-gno-graph-include-similar-reporting.1 Implement Fix gno graph --include-similar reporting sqlite-vec unavailable

## Description
TBD

## Acceptance
Satisfies the spec's goal, requirements and triage notes; judge against the spec directly.

## Done summary
Similarity now reads the activated vector partition. This covers CLI `gno similar`, `gno graph --include-similar`, MCP `gno_similar`/`gno_graph` and the REST similar/graph routes. Legacy `content_vectors` is read only before any partition activates, and no model is loaded. `getGraph` now loads sqlite-vec on its own connection instead of probing a connection that never loaded it.

Root cause, confirmed on origin/main against a real embedded index: `content_vectors` held 0 rows while one activated 1024-dim partition held 5 owners. `gno similar` failed with "Document has no embeddings", graph reported "sqlite-vec not loaded" on CLI and MCP, and REST returned empty results with no warning.

- New `src/store/vector/stored-vectors.ts`: a provenance-checked stored-vector reader. Partition selection is `storedVectorPartition` in status.ts, which reuses status/retrieval tiering.
- New `VectorSearchOptions.partitionId` searches the chosen partition through the existing vector port.
- New `src/store/sqlite/graph-similarity.ts` scores graph edges from stored vectors.
- `GetGraphOptions.embedModel` is passed by the CLI, MCP and REST callers.
- One regression test per surface (6 tests), all red on base. The getGraph report test pinned the old "sqlite-vec not loaded" warning, which was the defect itself; it was updated in its own commit.
- CHANGELOG [Unreleased] Fixed; spec/mcp.md algorithm step 2 corrected.

Follow-ups (not built): `gno vec sync/rebuild` and the doctor fingerprint check still read `content_vectors` only (legacy maintenance, not similarity); `docs/ARCHITECTURE.md` still lists `content_vectors` as the vector table; spec/cli.md says `gno similar` averages chunks, but the CLI uses the first chunk (pre-existing); gno.sh `scripts/export-index-trace-graph.ts` can drop its `gno similar` workaround after the next release.

stage: impl-review - skipped(config: repo CLAUDE.md skips all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 082f684ea4dc0360303b08ea1f47d1305d034e4e, 4564fee2a0a4c31a42a5352d4a3b6c04108a2af1
- Tests: mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun test (5907 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run docs:verify (15 passed, 0 failed), bun test test/cli/commands/similar-vectors.test.ts test/mcp/links-integration.test.ts test/serve/routes/similarity-vectors.test.ts (6 new regression tests; all 6 red on base 90205bbd), live QA: .flow/tmp/qa-fn-136-fix-gno-graph-include-similar-reporting/ (real Qwen3 embed; before=origin/main 5711ee29, after=branch; CLI similar, CLI graph, MCP gno_similar+gno_graph, REST similar+graph)
- PRs: