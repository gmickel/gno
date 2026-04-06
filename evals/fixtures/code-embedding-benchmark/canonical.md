# Canonical Code Embedding Benchmark

This page tracks results for the fixed small multi-language code corpus.

Purpose:

- compare dense embedding models on a stable benchmark
- detect broad code-retrieval improvements across languages
- keep one artifact that is comparable across runs over time

Run:

```bash
bun run bench:code-embeddings --candidate bge-m3-incumbent --write
```

Interpretation:

- `vector` metrics are primary
- `hybrid` metrics are secondary support
- latency is informative, not the only decision maker

When a challenger wins here but not on `repo-serve`, treat it as a general-code signal, not an automatic product decision.
