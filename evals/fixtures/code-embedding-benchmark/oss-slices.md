# OSS Slices Code Embedding Benchmark

This page tracks results for the pinned public-OSS code slices fixture.

Purpose:

- validate that a code embedding model generalizes beyond GNO's own code
- avoid overfitting to one repository layout or naming style
- keep evaluation grounded in public repos only

Run:

```bash
bun run bench:code-embeddings --candidate bge-m3-incumbent --fixture oss-slices --write
```

Interpretation:

- a model that wins here and on `repo-serve` is a much stronger code-specialist recommendation
- a model that wins only on `repo-serve` might still be useful, but needs more caution before broad recommendation

## Current best result

As of 2026-04-06:

- `bge-m3`: vector nDCG@10 `0.6116`
- `Qwen3-Embedding-0.6B-GGUF`: vector nDCG@10 `1.0`

Interpretation:

- Qwen strongly outperforms the incumbent on the public OSS slice as well
- this confirms the `repo-serve` result is not just a GNO-specific quirk
