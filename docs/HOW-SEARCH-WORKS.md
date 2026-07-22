---
title: How Search Works
description: "Deep dive into GNO's search pipeline: BM25, vector search, query expansion, HyDE, reciprocal rank fusion, and reranking."
keywords: how hybrid search works, bm25 vector fusion, hyde retrieval, reranking pipeline, gno search
---

# How Search Works

GNO uses a sophisticated multi-stage search pipeline that combines traditional keyword search with modern neural techniques. This document explains how your queries are processed, expanded, and ranked.

> **New to the terminology?** See the [Glossary](GLOSSARY.md) for definitions of BM25, RRF, HyDE, and other terms.

## The Search Pipeline

The diagram below shows how your query flows through GNO's search system:

**Stage 0: Strong Signal Check** → Quick BM25 check. If top result is highly confident with clear separation, skip expensive expansion.

**Stage 1: Query Expansion** → Your query is expanded by an LLM into keyword variants (for BM25), semantic variants (for vectors), and a HyDE passage.

**Stage 2: Parallel Search** → Document-level BM25 and chunk-level vector searches run simultaneously on original query + all variants.

**Stage 3: RRF Fusion** → Results are merged using Reciprocal Rank Fusion. Original query gets 2× weight. Top-ranked documents get tiered bonuses.

**Stage 4: Reranking** → Top candidates rescored by Qwen3-Reranker using best chunk per document (4K chars).

```
┌───────────────────────────────────────────────────────────────┐
│                         YOUR QUERY                            │
│                "how do I deploy to production"                │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  STAGE 0: STRONG SIGNAL CHECK                                 │
│                                                               │
│  Quick BM25 search with top 5 results.                        │
│  If top result score ≥ 0.84 AND gap to #2 ≥ 0.14:             │
│    → Skip expansion, go straight to Stage 2                   │
│  Else:                                                        │
│    → Continue to Stage 1                                      │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  STAGE 1: QUERY EXPANSION (LLM)                               │
│                                                               │
│  Lexical variants (for BM25):                                 │
│    • "deployment process", "deploy application"               │
│                                                               │
│  Semantic variants (for vectors):                             │
│    • "steps to release software"                              │
│                                                               │
│  HyDE passage (hypothetical answer):                          │
│    "To deploy, run build, push to staging..."                 │
└───────────────────────────────┬───────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│  STAGE 2A: BM25 SEARCH      │ │  STAGE 2B: VECTOR SEARCH    │
│                             │ │                             │
│  Document-level FTS5 with   │ │  Chunk-level embeddings     │
│  Snowball English stemming  │ │  with contextual prefixes   │
│                             │ │                             │
│  Searches in parallel:      │ │  Searches in parallel:      │
│  • Original query (2×)      │ │  • Original query (2×)      │
│  • Each lexical variant     │ │  • Semantic variants + HyDE │
└──────────────┬──────────────┘ └──────────────┬──────────────┘
               │                               │
               └───────────────┬───────────────┘
                               ▼
┌───────────────────────────────────────────────────────────────┐
│  STAGE 3: RECIPROCAL RANK FUSION (RRF)                        │
│                                                               │
│  score = Σ (weight / (k + rank))    where k=60                │
│                                                               │
│  Weights: original=2.0, variants=1.0, HyDE=1.4                │
│  Tiered bonus: +0.05 for #1, +0.02 for #2-3                   │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  STAGE 4: RERANKING (Qwen3-Reranker)                          │
│                                                               │
│  Best chunk per document passed to cross-encoder (4K chars).  │
│                                                               │
│  Position-aware blending:                                     │
│    1-3: 75% fusion / 25% rerank                               │
│    4-10: 60% fusion / 40% rerank                              │
│    11+: 40% fusion / 60% rerank                               │
│                                                               │
│  Guardrail: preserve original BM25 #1 exact hit as top result │
└───────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                        FINAL RESULTS                          │
│                 Sorted by blended score [0-1]                 │
└───────────────────────────────────────────────────────────────┘
```

## Strong Signal Detection

Before running expensive LLM-based query expansion, GNO checks if BM25 already has a confident match. This optimization skips expansion when:

1. **High confidence**: Top result's normalized score ≥ 0.84
2. **Clear separation**: Gap between #1 and #2 ≥ 0.14

Both conditions must be true. This is conservative: we'd rather spend time on expansion than miss relevant results.

When triggered, you'll see `skipped_strong` in `--explain` output. Typical speedup: 1-3 seconds saved per query.

## Query Expansion with HyDE

GNO uses a technique inspired by [HyDE (Hypothetical Document Embeddings)](https://arxiv.org/abs/2212.10496). Instead of just searching with your query, the LLM generates:

### Lexical Queries

Keyword variations optimized for BM25 full-text search. If you ask "how to protect my app", these might be:

- "security application"
- "protect app authentication"
- "app security measures"

### Semantic Queries

Rephrased versions that capture the meaning differently, optimized for vector search:

- "ways to secure software from attacks"
- "implementing application security"

### HyDE Passage

A short hypothetical document that _would_ answer your question. This is powerful because:

- Documents are written in "answer style", not "question style"
- Searching with an answer-like text finds similar answer-like documents
- Bridges the vocabulary gap between questions and documentation

```
Query: "how do I deploy to production"

HyDE: "To deploy the application to production, first ensure all tests pass,
       then run the build command with production flags, push the artifacts
       to your staging environment for validation, and finally promote to
       production using the deployment pipeline..."
```

### Expansion Guardrails

GNO applies deterministic guardrails after generation to reduce query drift:

- Preserves quoted phrases and negations in lexical variants
- Preserves named/symbol-heavy entities (for example `Bob`, `C++`, `Node.js`)
- Filters lexical/semantic variants that do not overlap query intent
- Falls back to the original query when variants are fully filtered
- Drops HyDE text when it has no meaningful overlap with the query

This keeps expansion useful for recall without letting unrelated variants dominate retrieval.

### Why Expansion Helps

Without expansion, searching "deploy to production" only finds documents with those exact words. With expansion:

| Search Type       | Finds Documents About                    |
| ----------------- | ---------------------------------------- |
| Original          | "deploy", "production"                   |
| Lexical variants  | "deployment", "release", "shipping"      |
| Semantic variants | CI/CD, infrastructure, DevOps            |
| HyDE              | Step-by-step guides, tutorials, runbooks |

## Search Modes

GNO offers different search commands for different needs:

### `gno search` - BM25 Only

Fast keyword search using SQLite FTS5 with document-level indexing. Best for:

- Exact term lookups
- Code identifiers
- Known phrases

**Document-level BM25**: Unlike chunk-level search, GNO indexes entire documents. This means a query for "authentication JWT" finds documents where these terms appear anywhere, even in different sections.

**Snowball stemming**: The exposed default tokenizer is specifically
`snowball english`. It handles English word forms such as "running" → "run"
and "scored" → "score"; GNO does not expose the other Snowball language
stemmers. `unicode61` provides language-neutral tokenization without stemming.

**Weighted BM25 fields**: `gno search` intentionally favors title hits first, then filepath hits, then body-only mentions. This helps code/doc lookups like `auth-flow`, `DEC-0054`, and `jwt token rotation` rank the expected document above a weak incidental body mention.

**Lexical query grammar**: BM25 search supports plain prefix terms, quoted phrases, and negation with at least one positive term. Hyphenated compounds like `real-time`, `gpt-4`, and `multi-agent` are handled intentionally rather than relying on accidental tokenizer behavior.

```bash
gno search "useEffect cleanup"
```

### `gno vsearch` - Vector Only

Pure semantic search using embeddings. Best for:

- Conceptual queries
- "How do I..." questions
- Finding related content

**Contextual chunking**: Each chunk is embedded with its document title prepended (`title: My Doc | text: ...`). This helps the embedding model understand context. A chunk about "configuration" in a React doc is different from one in a database doc.

**Code-aware chunking (automatic first pass)**: for `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, and `.rs`, GNO prefers structural breakpoints such as imports, functions, classes, and type definitions before falling back to the default markdown/prose chunker. Unsupported extensions and files without useful structural boundaries continue through the default chunker unchanged.

GNO also benchmarks this against a real tree-sitter AST chunker. The latest canonical code fixture showed no retrieval-quality gain (`nDCG@10` stayed `0.963`), so production indexing keeps the lighter heuristic chunker for now.

```bash
gno vsearch "how to prevent memory leaks in React"
```

### `gno query` - Hybrid (Recommended)

Combines BM25 + vector + expansion + reranking. Best for:

- General purpose search
- When you're not sure what terms to use
- Complex questions

```bash
gno query "best practices for error handling"
```

## Score Normalization

All scores are normalized to **[0.0 - 1.0]** range where 1.0 is the best match. This makes scores comparable within a result set.

**Important**: Scores are normalized _per query_ and are NOT comparable across different queries. A score of 0.8 on query A doesn't mean the same relevance as 0.8 on query B.

### BM25 Scores

```
Raw BM25: smaller (more negative) = better
Normalized: (worst - raw) / (worst - best)
Result: 1.0 = best match in results, 0.0 = worst
```

### Vector Scores

```
Cosine distance: 0 = identical, 2 = opposite
Similarity: 1 - (distance / 2)
Result: 1.0 = identical vectors
```

### Fusion Scores

RRF produces position-based scores that are then normalized. Documents appearing highly in multiple lists score best.

### Blended Scores

Final score combines fusion + rerank with position-aware weights, then normalized to [0,1].

## Reciprocal Rank Fusion (RRF)

RRF is an algorithm that merges multiple ranked lists without needing to calibrate scores across different retrieval methods. The formula:

```
RRF_score(doc) = Σ weight_i / (k + rank_i)
```

Where:

- `k = 60` (dampening constant, reduces impact of exact rank)
- `rank_i` = position in result list i (1-indexed)
- `weight_i` = importance of that result list

### Why RRF Works

Consider a document that appears:

- Rank 1 in BM25: `1.0 / (60 + 1) = 0.0164`
- Rank 3 in Vector: `1.0 / (60 + 3) = 0.0159`
- **Total: 0.0323**

vs a document that appears:

- Rank 1 in BM25 only: `1.0 / (60 + 1) = 0.0164`
- Not in Vector results
- **Total: 0.0164**

The document appearing in both lists wins, even if another document ranked #1 in just one list.

### Variant Weighting

Not all searches are equal. Original queries get **2× weight** to prevent dilution by LLM-generated variants:

| Source          | Weight | Reasoning                     |
| --------------- | ------ | ----------------------------- |
| Original BM25   | 2.0    | Direct match to user query    |
| Original Vector | 2.0    | Direct semantic match         |
| BM25 variants   | 1.0    | LLM-generated, less direct    |
| Vector variants | 1.0    | LLM-generated, less direct    |
| HyDE passage    | 1.4    | Powerful but indirect         |
| Graph neighbors | 0.8    | Linked context from top seeds |

## Graph-Aware Candidate Expansion

`gno query --graph` uses the document graph as a retrieval adjunct. After BM25 and vector candidates are found, GNO takes the top seeds, follows a bounded one-hop set of graph neighbors, and feeds those added candidates back through fusion and reranking.

This is not graph traversal mode. Missing graph data, missing embeddings, or unavailable similarity edges degrade to the normal hybrid path. Explicit wiki/markdown links are weighted above inferred path fallbacks, ambiguous matches, and vector-similarity edges.

Use `gno query "topic" --graph --explain` to inspect graph activity:

```text
[explain] graph: seeds=5, candidates=4/20, explicit=3, inferred=1, ambiguous=0, similarity=0
```

Graph expansion is off by default for latency. Omit `--graph` when you need pure BM25/vector retrieval without graph-neighbor candidates.

### Tiered Top-Rank Bonus

Documents that rank highly in retrieval get a bonus before reranking:

| Position | Bonus |
| -------- | ----- |
| #1       | +0.05 |
| #2-3     | +0.02 |
| #4+      | None  |

This preserves strong initial signals through the pipeline.

## Chunk-Level Reranking

After RRF fusion, top candidates are reranked using **Qwen3-Reranker**. For efficiency, GNO reranks the **best chunk per document** (selected by highest fusion score) rather than full documents.
Chunk text loading is batched (`getChunksBatch`) to avoid per-document N+1 lookups in this stage.

**Why chunk-level?** Full-document reranking (128K chars) is 25× slower than chunk-level (4K chars). Testing shows chunk-level achieves similar quality at ~2s vs ~10s for the same query.

### Position-Aware Blending

We don't just replace fusion scores with rerank scores. We blend them based on position:

| Position | Fusion Weight | Rerank Weight | Why                                               |
| -------- | ------------- | ------------- | ------------------------------------------------- |
| 1-3      | 75%           | 25%           | Top results from multi-signal fusion are reliable |
| 4-10     | 60%           | 40%           | Balanced - both signals useful                    |
| 11+      | 40%           | 60%           | Lower ranks benefit more from reranker judgment   |

This approach:

- Trusts the robust multi-signal fusion for top positions
- Lets the deeper cross-encoder model refine lower positions
- Prevents a single model from dominating results

## Retrieval Limits

GNO retrieves more candidates than you request, then filters down:

| Stage                   | Candidates Retrieved   |
| ----------------------- | ---------------------- |
| BM25 (original query)   | `limit × 2`            |
| BM25 (each variant)     | `limit`                |
| Vector (original query) | `limit × 2`            |
| Vector (each variant)   | `limit`                |
| Vector (HyDE)           | `limit`                |
| After fusion            | All unique docs        |
| Reranking               | Top 20                 |
| Final output            | Your requested `limit` |

## Content Types and Categories

GNO stores a canonical `contentType` and category filters for every indexed document. JSON search/query results include both fields per result:

```json
{
  "contentType": "person",
  "categories": ["person", "relationship"]
}
```

Content type inference is additive and follows this order:

1. Frontmatter `type` becomes canonical `contentType` only when it exactly matches a configured `contentTypes[].id`.
2. Otherwise, configured `contentTypes[].prefixes` apply, longest prefix first.
3. Frontmatter `category` / `categories` / unconfigured `type` remain category filters only.
4. Existing path and extension heuristics classify code, meetings, specs, notes, or prose.
5. Fallback is `prose`.

The `--category` filter checks both canonical `contentType` and category filters, so `gno search --category person --json` matches pages whose configured type is `person` as well as pages categorized as `person`.

GNO persists a fingerprint of the normalized `contentTypes` rules used during ingestion. If you edit prefixes or type IDs later, unchanged files are reprocessed on the next sync so stored `contentType` metadata is re-derived; this is not tied only to an ingest-version bump.

## Typed Graphs and Retrieval Diagnosis

GNO stores semantic relationships in a derived `doc_edges` layer. Wiki links and
markdown links are projected into typed edges during sync, `relations:`
frontmatter can declare explicit relationship targets, and
`contentTypes[].graphHints` type projected links without changing ranking by
default.

`gno graph query <doc>` traverses this typed edge layer with bounded depth,
direction, and node/edge caps. `gno links <doc> --edge-type <type>` and
`gno backlinks <doc> --relation <type>` inspect the same semantic layer while
leaving the untyped positional link commands backward compatible.

`gno query diagnose "<query>" --target <doc>` resolves the target first, then
compares that document's chunks against every retrieval stage. It reports
whether the target was present in BM25, vector search, hybrid fusion, graph
expansion, and rerank, including target states such as `not_found`,
`filtered_out`, `no_indexed_content`, and diagnosed drop reasons such as
`not_in_candidate_set` or `below_cutoff`. In fast/BM25-only mode, vector and
rerank stages are skipped with reasons while fusion still runs over the BM25
candidate set.

## Controlling Search Behavior

### Search Modes

GNO offers three search modes with different speed/quality trade-offs:

| Mode     | Flag         | Time  | Description                   |
| -------- | ------------ | ----- | ----------------------------- |
| Fast     | `--fast`     | ~0.7s | Skip expansion and reranking  |
| Default  | (none)       | ~2-3s | Preset-aware balanced mode    |
| Thorough | `--thorough` | ~5-8s | Expansion + wider rerank pool |

```bash
gno query "quick lookup" --fast       # Fastest
gno query "my search"                 # Balanced (default)
gno query "complex topic" --thorough  # Best recall
```

Balanced mode is preset-aware:

- `slim` / `slim-tuned`: expansion + reranking
- larger presets: reranking on, expansion off by default

### Fine-grained Control

For specific combinations, use `--no-expand` or `--no-rerank`:

```bash
gno query "exact phrase" --no-expand  # Precise query, no expansion needed
gno query "my search" --no-rerank     # Trust fusion scores
```

### Filter by Score

Only show high-confidence results:

```bash
gno query "my search" --min-score 0.5
```

### Limit Results

```bash
gno query "my search" -n 10
```

### See Pipeline Details

The `--explain` flag shows what happened:

```bash
gno query "my search" --explain
```

This includes stage timings (`lang`, `expansion`, `bm25`, `vector`, `fusion`, `rerank`, `assembly`, `total`), fallback counters, and per-result fusion/rerank score components.

## Benchmark Your Own Retrieval

Use `gno bench <fixture.json>` to measure retrieval quality on an indexed corpus with stable fixtures. This is separate from the internal Evalite suites and is meant for project-owned regression tracking.

```bash
gno bench bench.json
gno bench bench.json --mode bm25 --mode no-rerank --mode thorough --json
```

Fixtures define queries, expected documents or `gno://` URIs, optional graded judgments, optional collection filters, query modes, and mode settings. GNO reports Precision@K, Recall@K, F1@K, MRR, nDCG@K, and latency summaries per mode.

Use mode comparisons to decide whether a corpus benefits from BM25, vector, hybrid, no-rerank, or thorough retrieval before changing defaults.

## Graceful Degradation

GNO works even when components are missing:

| Missing Component    | Behavior                   |
| -------------------- | -------------------------- |
| sqlite-vec extension | BM25 search only           |
| Embedding model      | Vector search disabled     |
| Rerank model         | Skip reranking, use fusion |
| Generation model     | Skip query expansion       |

Run `gno doctor` to check what's available.

## Language Support

Query expansion prompts are language-aware:

- **English** (`en-*`): Optimized English prompt
- **German** (`de-*`): Native German prompt
- **Other**: Multilingual fallback prompt

Query-language classification uses [franc](https://github.com/wooorm/franc)
with an explicit 34-language allowlist. That classification chooses prompt
language and metadata; it does not prove retrieval quality or determine the
language recorded for indexed documents.

Indexed-document detection is a separate deterministic path covering seven
languages: English, German, French, Italian, Chinese, Japanese, and Korean
(`en`, `de`, `fr`, `it`, `zh`, `ja`, `ko`). A collection's explicit
`languageHint` overrides inferred document language.

### Measured multilingual scope

<!-- public-truth:general-embedding-benchmark -->

The immutable April 2026 FastAPI-docs fixture contains 15 documents in five
languages (`en`, `de`, `fr`, `es`, `zh`) and 13 queries. It measured
[bge-m3 incumbent](../evals/fixtures/general-embedding-benchmark/2026-04-06-bge-m3-incumbent.md)
at vector nDCG@10 `0.3503` / hybrid `0.642`, and
[Qwen3 Embedding 0.6B](../evals/fixtures/general-embedding-benchmark/2026-04-06-qwen3-embedding-0-6b.md)
at vector `0.8594` / hybrid `0.947`.

<!-- /public-truth -->

The separate [July 2026 Nemotron screen](../research/embeddings/2026-07-21-nemotron-3-embed-1b.md)
measured Qwen at `0.9891` / `0.9891` and Nemotron at `0.9023` / `0.9461`
on that 13-query lane after runtime/profile changes. Nemotron ran through a
temporary PyTorch HTTP adapter, so its timings are not comparable with Qwen's
production GGUF path; no official production Nemotron GGUF was validated.

These are small semantic/hybrid fixtures, not general language guarantees.

<!-- public-truth:cjk-lexical-benchmark -->

Degraded lexical behavior is measured separately in the immutable
[July 22, 2026 CJK benchmark](../evals/fixtures/cjk-lexical-benchmark/2026-07-22.md).
Across eight queries per language, production BM25 Recall@10/nDCG@10 was
`0.125` for Chinese, `0.125` for Japanese, and `0.5` for Korean, with
zero-result rates of `0.875`, `0.875`, and `0.5`. The frozen
[promotion-gates.md](../evals/fixtures/cjk-lexical-benchmark/promotion-gates.md)
requires floors of `0.375`, `0.375`, and `0.75` before any lexical analyzer can
ship, with maximum zero-result rates of `0.625`, `0.625`, and `0.25`.
Token-boundary, normalization, mixed-script, identifier, and ranking failures
are reported as concrete cases. This lexical baseline does not measure semantic
retrieval, and production BM25 remains unchanged. All positive qrels use
relevance `3`; nDCG therefore measures placement but not distinctions among
positive gain grades.

<!-- /public-truth -->

The legacy `evals/multilingual.eval.ts` suite remains a four-case BM25-only
sanity lane and is not a release gate.

## Performance Characteristics

| Operation             | Typical Time           |
| --------------------- | ---------------------- |
| BM25 search           | ~5-20ms                |
| Vector search         | ~10-50ms               |
| Query expansion       | ~3-5s (LLM generation) |
| Chunk-level reranking | ~1-2s                  |
| **Fast mode**         | ~0.7s                  |
| **Default mode**      | ~2-3s                  |
| **Thorough mode**     | ~5-8s                  |

**Optimizations**:

- Balanced mode can skip expansion on larger presets to save 3-5s
- Chunk-level reranking: 4K chars vs 128K = 25× faster
- Strong signal detection skips expansion for confident BM25 matches
- Query expansion is cached by query + model

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System overview and data flow
- [CLI Commands](CLI.md) - Full command reference
- [Configuration](CONFIGURATION.md) - Model presets and settings
- [Glossary](GLOSSARY.md) - Term definitions
