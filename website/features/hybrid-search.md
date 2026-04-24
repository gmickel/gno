---
layout: feature
title: Hybrid Search
headline: Exact Terms, Concepts, and Retrieval Control
description: GNO combines BM25 full-text search with vector similarity, reciprocal rank fusion, query expansion, and reranking. Search for exact terms or conceptual matches from one local engine.
keywords: hybrid search, bm25, vector search, semantic search, reciprocal rank fusion, query expansion, reranking
icon: hybrid-search
slug: hybrid-search
permalink: /features/hybrid-search/
og_image: /assets/images/og/og-hybrid-search.png
benefits:
  - Exact keyword matching with BM25
  - Semantic similarity with vector search
  - Reciprocal rank fusion combines both
  - Configurable weights for tuning
commands:
  - "gno search 'exact terms'"
  - "gno vsearch 'conceptual query'"
  - "gno query 'best of both'"
---

## How It Works

GNO's hybrid search combines two powerful search paradigms:

### BM25 Full-Text Search

Traditional keyword matching that excels at finding exact terms. When you search for "authentication JWT", BM25 finds documents containing those exact words.

BM25 search also handles quoted phrases, negation with a positive term, and technical compounds like `real-time`, `gpt-4`, and `DEC-0054` intentionally instead of relying on accidental tokenizer behavior.

```bash
gno search "authentication JWT"
gno search '"zero downtime deploy"'
gno search 'dashboard -lag'
```

### Vector Similarity Search

Semantic search using embeddings. When you search for "how to protect my app", vector search finds documents about security, authentication, and access control - even without those exact words.

```bash
gno vsearch "how to protect my app"
```

For supported code files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`), GNO also prefers structural chunk boundaries such as imports, functions, classes, and type definitions before falling back to the default chunker.

That production chunker was benchmarked against a real tree-sitter AST chunker. The AST version did not improve retrieval score on the canonical code fixture (`nDCG@10` stayed `0.963`), so GNO keeps the faster heuristic path.

### Reciprocal Rank Fusion

The `query` command combines both methods using RRF, a proven algorithm that merges ranked lists. Documents that score well in both methods rise to the top.

```bash
gno query "authentication best practices"
```

When stdout is a TTY, GNO can also wrap the visible `gno://...` result URI in a clickable terminal hyperlink that resolves to the source file path, with best-effort line hints when available.

For teams tuning retrieval quality over time, GNO now also ships dedicated benchmark workflows for hybrid retrieval and code embeddings. See [Benchmarks](/features/benchmarks/).

### Tag Filtering

Combine hybrid search with tag filters for precise results:

```bash
# Match any tag (OR)
gno query "authentication" --tags-any api,security

# Match all tags (AND)
gno query "API design" --tags-all status/review,priority/high
```

Tags are extracted automatically from markdown frontmatter. See the [Tag System](/features/tags/) for details.

### Learn More

For a deep dive into query expansion, HyDE, RRF fusion, and reranking, see the **[How Search Works](/docs/HOW-SEARCH-WORKS/)** guide.
