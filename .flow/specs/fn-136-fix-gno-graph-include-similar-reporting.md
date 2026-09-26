# Stub: `gno graph --include-similar` reports sqlite-vec unavailable while `gno similar` works

## Observed (2026-09-02, gno 1.38.0)

Against a fresh isolated index (`GNO_CONFIG_DIR`/`GNO_DATA_DIR` in a temp dir, four collections, 143 docs, embeddings complete, `searchAvailable: true` from `gno embed --json`):

```
gno --no-pager graph --include-similar --include-isolated --threshold 0.5 --similar-top-k 3 --json
```

returns only wiki edges and

```json
"includedSimilar": false,
"similarAvailable": false,
"warnings": ["Similarity edges unavailable: sqlite-vec not loaded"]
```

while, in the same shell and index,

```
gno similar "gno://papers/bounded-retries-in-paging-systems.pdf" --cross-collection --threshold 0.5 -n 3 --json
```

returns similarity results with scores 0.49 to 0.60. `gno vsearch` and hybrid `gno query` also use the vector index without complaint.

Impact: the graph command and, presumably, `/api/graph?includeSimilar=true` and the web UI graph's similarity edges are silently empty even though the vector index is loaded. The gno.sh landing-page figure works around it by collecting edges from `gno similar` per document (see `scripts/export-index-trace-graph.ts` in gmickel/gno.sh).

## Suspected cause (unverified)

The graph command opens its own SQLite connection or adapter path that does not load the sqlite-vec extension, or checks vec availability before the extension is registered. Reproduce, then locate where the graph code decides `similarAvailable`.

## Acceptance

- [ ] `gno graph --include-similar` on an index with embeddings emits `similar` edges and `similarAvailable: true`; the warning appears only when sqlite-vec genuinely failed to load.
- [ ] `/api/graph?includeSimilar=true` behaves the same.
- [ ] Regression test covering the graph similarity path on an embedded fixture.
- [ ] `docs/CLI.md` / `docs/API.md` unchanged unless behaviour text is wrong; CHANGELOG entry under Fixed.

## Not in scope

Language detection mislabelling short English queries as `nb` (empties the BM25 stage until `--lang en` is passed); file separately.

## Rescope after triage (2026-09-27, v2.8.0)

Two defects, both required:
1. `getGraph` checks `SELECT vec_version()` on a raw connection that never loaded sqlite-vec (`src/store/sqlite/adapter.ts` getGraph), so `gno graph --include-similar` always reports "sqlite-vec not loaded" and emits no similarity edges.
2. Regression since the vector storage moved to `vector_variants` / `vec_v1_*`: `content_vectors` is empty after `gno embed`, but similarity still reads it. `gno similar <uri>` fails with "Document has no embeddings. Run: gno embed" on a freshly embedded index. Readers of `content_vectors` to move: CLI similar (`src/cli/commands/links.ts`), graph similarity SQL (`adapter.ts`), MCP (`src/mcp/tools/links.ts`), REST (`src/serve/routes/links.ts`).

Acceptance: on an embedded index, `gno similar`, `gno graph --include-similar`, MCP `gno_similar` and graph tools, and the REST graph and similar routes return similarity results from the active vector partition, with a regression test per surface and a repro that fails on v2.8.0.
