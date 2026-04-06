# GNO Serve Code Embedding Benchmark

This page tracks results for the real GNO code slice under `src/serve`.

Purpose:

- test whether an embedding model is actually better on GNO's own code
- compare candidate models on a more product-shaped corpus
- support a recommendation for code collections in real user configs

Run:

```bash
bun run bench:code-embeddings --candidate bge-m3-incumbent --fixture repo-serve --write
```

Interpretation:

- a model that wins here is a strong candidate for code collections
- if it also holds on the canonical benchmark, it is a stronger promotion target
- if it wins only here, document it as a code-specialist recommendation rather than a universal default

## Current best result

As of 2026-04-06:

- `bge-m3`: vector nDCG@10 `0.1003`
- `Qwen3-Embedding-0.6B-GGUF`: vector nDCG@10 `0.6872`
- `jina-code-embeddings-0.5b-GGUF`: vector nDCG@10 `0.0` under the current native runtime, with embedding-id errors during indexing

Current recommendation:

- keep `bge-m3` as the global default for mixed/prose collections
- use `Qwen3-Embedding-0.6B-GGUF` as the current code-specialist embedding model for code-heavy collections
- do not recommend `jina-code-embeddings-0.5b-GGUF` in GNO's current native runtime until its embedding-id/runtime issues are understood and fixed
