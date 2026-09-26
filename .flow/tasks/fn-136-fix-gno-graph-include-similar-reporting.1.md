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
- New `src/store/sqlite/graph-similarity.ts` scores graph edges from stored vectors, keyed by owning document.
- `GetGraphOptions.embedModel` is passed by the CLI, MCP and REST callers.
- Review fix (codex impl-review P2): partition hits are mapped to their exact owner documents (`similarityHitDocuments`). Before, CLI, MCP and REST mapped them by content hash, so a same-content document without its own current vector could take another's hit and score. Hash mapping remains only for legacy hits.
- One regression test per surface (6 tests), all red on base. The fixture's retitled same-content twins make the 3 similar tests red on the pre-review commit as well. The getGraph report test pinned the old "sqlite-vec not loaded" warning, which was the defect itself; it was updated in its own commit.
- CHANGELOG [Unreleased] Fixed; spec/mcp.md algorithm step 2 and the docs/ARCHITECTURE.md storage table corrected.

Follow-ups (not built): `gno vec sync/rebuild` and the doctor fingerprint check still read `content_vectors` only (legacy maintenance, not similarity); spec/cli.md says `gno similar` averages chunks, but the CLI uses the first chunk (pre-existing); gno.sh `scripts/export-index-trace-graph.ts` can drop its `gno similar` workaround after the next release.

stage: impl-review - ran (codex, conductor-dispatched): NEEDS_WORK (1 P2, owner mapping) -> fixed in 693243cb

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 082f684ea4dc0360303b08ea1f47d1305d034e4e, 4564fee2a0a4c31a42a5352d4a3b6c04108a2af1, 693243cb
- Tests: mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings, format clean), mise exec bun@1.4.2 -- bun test (5907 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run docs:verify (15 passed, 0 failed), bun test test/cli/commands/similar-vectors.test.ts test/mcp/links-integration.test.ts test/serve/routes/similarity-vectors.test.ts (6 regression tests; all 6 red on base 90205bbd; the 3 similar tests with unembedded same-content twins also red on aacd8ece, before the owner-mapping fix), live QA: .flow/tmp/qa-fn-136-fix-gno-graph-include-similar-reporting/ (real Qwen3 embed; before=origin/main 5711ee29, after=branch; CLI similar, CLI graph, MCP gno_similar+gno_graph, REST similar+graph; after-fix2-* re-check after 693243cb)
- PRs: