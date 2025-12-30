# How Search Works

GNO uses a sophisticated multi-stage search pipeline that combines traditional keyword search with modern neural techniques. This document explains how your queries are processed, expanded, and ranked.

> **New to the terminology?** See the [Glossary](GLOSSARY.md) for definitions of BM25, RRF, HyDE, and other terms.

## The Search Pipeline

The diagram below shows how your query flows through GNO's search system:

**Stage 1: Query Expansion** → Your query is expanded by an LLM into keyword variants (for BM25), semantic variants (for vectors), and a HyDE passage.

**Stage 2: Parallel Search** → BM25 and vector searches run simultaneously on original query + all variants.

**Stage 3: RRF Fusion** → Results are merged using Reciprocal Rank Fusion. Documents appearing in multiple lists get boosted.

**Stage 4: Reranking** → Top 20 candidates are rescored by a cross-encoder for final ordering.

```
          ┌─────────────────────────┐
          │       YOUR QUERY        │
          │ "how do I deploy to     │
          │       production"       │
          └───────────┬─────────────┘
                      ▼
          ┌─────────────────────────┐
          │  1. QUERY EXPANSION     │
          │                         │
          │  Lexical: "deploy app"  │
          │  Semantic: "release     │
          │    software to prod"    │
          │  HyDE: "To deploy..."   │
          └───────────┬─────────────┘
                      │
           ┌─────────┴─────────┐
           ▼                   ▼
   ┌──────────────┐   ┌──────────────┐
   │ 2A. BM25     │   │ 2B. VECTOR   │
   │              │   │              │
   │ Keyword      │   │ Semantic     │
   │ matching     │   │ similarity   │
   │ (FTS5)       │   │ (embeddings) │
   └──────┬───────┘   └───────┬──────┘
          │                   │
          └─────────┬─────────┘
                    ▼
          ┌─────────────────────────┐
          │  3. RRF FUSION          │
          │                         │
          │  Merges ranked lists    │
          │  score = Σ w/(k+rank)   │
          │  k=60, weights vary     │
          └───────────┬─────────────┘
                      ▼
          ┌─────────────────────────┐
          │  4. RERANKING           │
          │                         │
          │  Cross-encoder rescores │
          │  top 20 candidates      │
          └───────────┬─────────────┘
                      ▼
          ┌─────────────────────────┐
          │     FINAL RESULTS       │
          │  Sorted by score [0-1]  │
          └─────────────────────────┘
```

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
A short hypothetical document that *would* answer your question. This is powerful because:
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

| Search Type | Finds Documents About |
|-------------|----------------------|
| Original | "deploy", "production" |
| Lexical variants | "deployment", "release", "shipping" |
| Semantic variants | CI/CD, infrastructure, DevOps |
| HyDE | Step-by-step guides, tutorials, runbooks |

## Search Modes

GNO offers different search commands for different needs:

### `gno search` - BM25 Only
Fast keyword search using SQLite FTS5. Best for:
- Exact term lookups
- Code identifiers
- Known phrases

```bash
gno search "useEffect cleanup"
```

### `gno vsearch` - Vector Only
Pure semantic search using embeddings. Best for:
- Conceptual queries
- "How do I..." questions
- Finding related content

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

**Important**: Scores are normalized *per query* and are NOT comparable across different queries. A score of 0.8 on query A doesn't mean the same relevance as 0.8 on query B.

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

Not all searches are equal:

| Source | Weight | Reasoning |
|--------|--------|-----------|
| Original BM25 | 1.0 | Direct match to user query |
| Original Vector | 1.0 | Direct semantic match |
| BM25 variants | 0.5 | LLM-generated, less direct |
| Vector variants | 0.5 | LLM-generated, less direct |
| HyDE passage | 0.7 | Powerful but indirect |

## Position-Aware Blending

After RRF fusion, the top candidates are reranked using a cross-encoder model. But we don't just replace fusion scores with rerank scores - we blend them based on position:

| Position | Fusion Weight | Rerank Weight | Why |
|----------|---------------|---------------|-----|
| 1-3 | 75% | 25% | Top results from multi-signal fusion are reliable |
| 4-10 | 60% | 40% | Balanced - both signals useful |
| 11+ | 40% | 60% | Lower ranks benefit more from reranker judgment |

This approach:
- Trusts the robust multi-signal fusion for top positions
- Lets the deeper cross-encoder model refine lower positions
- Prevents a single model from dominating results

## Retrieval Limits

GNO retrieves more candidates than you request, then filters down:

| Stage | Candidates Retrieved |
|-------|---------------------|
| BM25 (original query) | `limit × 2` |
| BM25 (each variant) | `limit` |
| Vector (original query) | `limit × 2` |
| Vector (each variant) | `limit` |
| Vector (HyDE) | `limit` |
| After fusion | All unique docs |
| Reranking | Top 20 |
| Final output | Your requested `limit` |

## Controlling Search Behavior

### Skip Expansion
If you want faster results or have a precise query:
```bash
gno query "exact phrase match" --no-expand
```

### Skip Reranking
For speed or if you trust fusion scores:
```bash
gno query "my search" --no-rerank
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

| Missing Component | Behavior |
|-------------------|----------|
| sqlite-vec extension | BM25 search only |
| Embedding model | Vector search disabled |
| Rerank model | Skip reranking, use fusion |
| Generation model | Skip query expansion |

Run `gno doctor` to check what's available.

## Language Support

Query expansion prompts are language-aware:
- **English** (`en-*`): Optimized English prompt
- **German** (`de-*`): Native German prompt
- **Other**: Multilingual fallback prompt

Language is auto-detected from your query text using the [franc](https://github.com/wooorm/franc) library (supports 30+ languages).

## Performance Characteristics

| Operation | Typical Time |
|-----------|-------------|
| BM25 search | ~5-20ms |
| Vector search | ~10-50ms |
| Query expansion | ~1-3s (LLM generation) |
| Reranking (20 docs) | ~500ms-2s |
| **Full hybrid query** | ~2-5s |

Query expansion is cached by query + model, so repeated queries are fast.

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System overview and data flow
- [CLI Commands](CLI.md) - Full command reference
- [Configuration](CONFIGURATION.md) - Model presets and settings
- [Glossary](GLOSSARY.md) - Term definitions
