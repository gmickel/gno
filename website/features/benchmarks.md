---
layout: feature
title: Benchmarks
headline: Measure Retrieval Before You Change Defaults
description: Benchmark retrieval models and code embedding candidates against fixed corpora, real GNO code, and pinned public OSS slices. Use bounded autonomous search to find better models without turning research into chaos.
keywords: retrieval benchmark, code embedding benchmark, local model evaluation, autoresearch, gno benchmarks
icon: brain
slug: benchmarks
permalink: /features/benchmarks/
benefits:
  - Regression-first retrieval quality checks
  - Hybrid benchmark snapshots and deltas
  - Code embedding benchmark across canonical, repo, and OSS slices
  - Multilingual markdown benchmark for general collection defaults
  - Bounded autonomous search loops
  - Per-collection model recommendations backed by benchmark results
commands:
  - "bun run eval:hybrid"
  - "bun run bench:code-embeddings --candidate bge-m3-incumbent --write"
  - "bun run bench:general-embeddings --candidate qwen3-embedding-0.6b --write"
  - "bun run research:embeddings:autonomous:list-search-candidates"
  - "bun run research:embeddings:autonomous:search --dry-run"
---

## Why This Matters

Changing a retrieval model because it feels better is a good way to regress the product slowly and not notice until users do.

GNO treats retrieval changes as something to measure:

1. establish the incumbent baseline
2. run challengers on fixed benchmark corpora
3. compare on real GNO code
4. compare on pinned public OSS slices
5. only then document or promote a winner

## Two Benchmark Lanes

### Hybrid Retrieval

For the full retrieval stack:

```bash
bun run eval:hybrid
bun run eval:hybrid:baseline
bun run eval:hybrid:delta
```

These runs answer:

- does retrieval quality improve?
- where does latency move?
- did we accidentally regress the full hybrid path?

### Code Embeddings

For code-focused embedding models:

```bash
# Incumbent baseline
bun run bench:code-embeddings --candidate bge-m3-incumbent --write

# Benchmark a real challenger
bun run research:embeddings:autonomous:run-candidate qwen3-embedding-0.6b
```

Current fixtures:

- `canonical` — fixed multi-language code corpus
- `repo-serve` — real GNO `src/serve` slice
- `oss-slices` — pinned public OSS repo slices

### General Multilingual Markdown

For default-model questions on normal docs collections:

```bash
bun run bench:general-embeddings --candidate bge-m3-incumbent --write
bun run bench:general-embeddings --candidate qwen3-embedding-0.6b --write
```

Current fixture:

- `general-embedding-benchmark` — vendored multilingual FastAPI docs snapshots

## Current Results

Current code-embedding numbers, as documented in the benchmark artifacts:

| Fixture      | `bge-m3` vector nDCG@10 | `Qwen3-Embedding-0.6B-GGUF` vector nDCG@10 | Notes                      |
| ------------ | ----------------------- | ------------------------------------------ | -------------------------- |
| `repo-serve` | `0.1003`                | `0.6872`                                   | Real GNO `src/serve` slice |
| `oss-slices` | `0.6116`                | `1.0`                                      | Pinned public OSS slices   |

Interpretation:

- Qwen ties the incumbent on the tiny canonical corpus, then wins hard on both the real GNO code slice and the public OSS slice
- this is why the current recommendation is collection-scoped, not a blanket default change
- `jina-code-embeddings-0.5b-GGUF` is not listed as a current winner because it hit native-runtime embedding-id failures and collapsed on `repo-serve`

Full benchmark artifacts live in the repository under:

- `evals/fixtures/code-embedding-benchmark/`
- `research/embeddings/`

## Current Code Winner

Current best result:

- `Qwen3-Embedding-0.6B-GGUF`

Practical recommendation:

- keep `bge-m3` as the global default for mixed notes/docs collections
- use `Qwen3-Embedding-0.6B-GGUF` as a per-collection `models.embed` override for code-heavy collections

Example:

```yaml
collections:
  - name: gno-code
    path: /Users/you/work/gno/src
    pattern: "**/*.{ts,tsx,js,jsx,go,rs,py,swift,c}"
    models:
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

That gives you a code-specialist embedder without forcing every prose-heavy collection onto the slower model.

## Current General Multilingual Candidate

Current public-docs benchmark numbers:

| Fixture                   | `bge-m3` vector nDCG@10 | `bge-m3` hybrid nDCG@10 | `Qwen3-Embedding-0.6B-GGUF` vector nDCG@10 | `Qwen3-Embedding-0.6B-GGUF` hybrid nDCG@10 |
| ------------------------- | ----------------------- | ----------------------- | ------------------------------------------ | ------------------------------------------ |
| multilingual FastAPI docs | `0.350`                 | `0.642`                 | `0.859`                                    | `0.947`                                    |

Interpretation:

- Qwen is now the strongest general multilingual embedding candidate we have
  measured, not just the strongest code-specialist candidate
- but GNO still keeps `bge-m3` as the shipped default until the global
  re-embed/default-switch story is intentionally productized

## Autonomous Search, Bounded

GNO's model search loops are intentionally constrained:

- fixed candidate list
- fixed corpora
- fixed scoring policy
- human decision before changing defaults

```bash
bun run research:embeddings:autonomous:list-search-candidates
bun run research:embeddings:autonomous:leaderboard
bun run research:embeddings:autonomous:search --dry-run
```

This is not an uncontrolled “let the agent mutate the whole repo” setup.
It is a bounded model-comparison loop designed to be trustworthy enough for product decisions.

## Learn More

- [Hybrid Search](/features/hybrid-search/)
- [Fine-Tuned Models](/features/fine-tuned-models/)
- [Configuration](/docs/CONFIGURATION/)
- [How Search Works](/docs/HOW-SEARCH-WORKS/)
