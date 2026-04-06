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

## Current best result

As of 2026-04-06:

- `bge-m3`: vector nDCG@10 `0.95`
- `Qwen3-Embedding-0.6B-GGUF`: vector nDCG@10 `0.95`
- `jina-code-embeddings-0.5b-GGUF`: vector nDCG@10 `0.9631`

Interpretation:

- Qwen matches the incumbent on the small canonical benchmark
- Jina looks promising on the tiny canonical fixture only
- do not treat canonical alone as the decision-maker for production recommendations
- Qwen's latency on this fixture is materially higher than `bge-m3`, so the recommendation remains code-collection specific rather than global
