# How Search Works

GNO uses a sophisticated multi-stage search pipeline that combines traditional keyword search with modern neural techniques. This document explains how your queries are processed, expanded, and ranked.

> **New to the terminology?** See the [Glossary](GLOSSARY.md) for definitions of BM25, RRF, HyDE, and other terms.

## The Search Pipeline

The diagram below shows how your query flows through GNO's search system:

**Stage 0: Strong Signal Check** → Quick BM25 check. If top result is highly confident with clear separation, skip expensive expansion.

**Stage 1: Query Expansion** → Your query is expanded by an LLM into keyword variants (for BM25), semantic variants (for vectors), and a HyDE passage.

**Stage 2: Parallel Search** → Document-level BM25 and chunk-level vector searches run simultaneously on original query + all variants.

**Stage 3: RRF Fusion** → Results are merged using Reciprocal Rank Fusion. Original query gets 2× weight. Top-ranked documents get tiered bonuses.

**Stage 4: Reranking** → Top candidates rescored by Qwen3-Reranker with full document context (up to 32K tokens).

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
│  Snowball stemmer (20+ langs)│ │  with contextual prefixes   │
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
│  STAGE 4: RERANKING (Qwen3-Reranker, 32K context)             │
│                                                               │
│  Full document content passed to cross-encoder.               │
│                                                               │
│  Position-aware blending:                                     │
│    1-3: 75% fusion / 25% rerank                               │
│    4-10: 60% fusion / 40% rerank                              │
│    11+: 40% fusion / 60% rerank                               │
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

**Snowball stemming**: FTS5 uses the Snowball stemmer supporting 20+ languages. "running" matches "run", "scored" matches "score", plurals match singulars.

```bash
gno search "useEffect cleanup"
```

### `gno vsearch` - Vector Only

Pure semantic search using embeddings. Best for:

- Conceptual queries
- "How do I..." questions
- Finding related content

**Contextual chunking**: Each chunk is embedded with its document title prepended (`title: My Doc | text: ...`). This helps the embedding model understand context. A chunk about "configuration" in a React doc is different from one in a database doc.

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

| Source          | Weight | Reasoning                  |
| --------------- | ------ | -------------------------- |
| Original BM25   | 2.0    | Direct match to user query |
| Original Vector | 2.0    | Direct semantic match      |
| BM25 variants   | 1.0    | LLM-generated, less direct |
| Vector variants | 1.0    | LLM-generated, less direct |
| HyDE passage    | 1.4    | Powerful but indirect      |

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

## Controlling Search Behavior

### Search Modes

GNO offers three search modes with different speed/quality trade-offs:

| Mode     | Flag         | Time  | Description                    |
| -------- | ------------ | ----- | ------------------------------ |
| Fast     | `--fast`     | ~0.7s | Skip expansion and reranking   |
| Default  | (none)       | ~2-3s | Skip expansion, with reranking |
| Thorough | `--thorough` | ~5-8s | Full pipeline with expansion   |

```bash
gno query "quick lookup" --fast       # Fastest
gno query "my search"                 # Balanced (default)
gno query "complex topic" --thorough  # Best recall
```

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

Language is auto-detected from your query text using the [franc](https://github.com/wooorm/franc) library (supports 30+ languages).

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

- Default mode skips expansion (saves 3-5s on every query)
- Chunk-level reranking: 4K chars vs 128K = 25× faster
- Strong signal detection skips expansion for confident BM25 matches
- Query expansion is cached by query + model

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System overview and data flow
- [CLI Commands](CLI.md) - Full command reference
- [Configuration](CONFIGURATION.md) - Model presets and settings
- [Glossary](GLOSSARY.md) - Term definitions
