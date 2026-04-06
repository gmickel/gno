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
