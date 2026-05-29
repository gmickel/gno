# fn-64-retrieval-quality-and-terminal.6 Optimize query-time graph expansion latency

## Description
Query-time graph expansion currently dominates hybrid retrieval latency on a realistic Growth Factors vault. Repro from WSL install:

```bash
gno --json query "Systabuild engagement letter" \
  --collection growth-factors \
  -n 5 \
  --query-mode term:Systabuild \
  --explain
```

Observed timings on ~871 docs / ~4,858 links:

- `graph`: ~31.8s
- `rerank`: ~2.2s
- `vector`: ~239ms
- `bm25`: ~3ms
- total: ~34.2s

Adding `--no-graph` drops the same query to ~2.4s internal timing, so the bottleneck is full graph resolution during candidate expansion.

## Acceptance
- [ ] Reproduce the slow graph stage with the command above or an equivalent fixture.
- [ ] Query-time graph expansion avoids full `getGraph()` recomputation for every query.
- [ ] Use seed-doc scoped outgoing/backlink lookup or a cached graph projection.
- [ ] Target graph stage <500ms for the measured growth-factors collection, or skip/cap graph expansion with clear fallback metadata.
- [ ] Add regression coverage for graph expansion latency/SQL scope where practical.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
