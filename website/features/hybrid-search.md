---
layout: feature
title: Hybrid Search
headline: The Best of Keywords and Semantics
description: GNO combines BM25 full-text search with vector similarity search using reciprocal rank fusion. Get accurate results whether you search for exact terms or conceptual matches.
keywords: hybrid search, bm25, vector search, semantic search, reciprocal rank fusion
icon: "🔎"
slug: hybrid-search
permalink: /features/hybrid-search/
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

```bash
gno search "authentication JWT"
```

### Vector Similarity Search
Semantic search using embeddings. When you search for "how to protect my app", vector search finds documents about security, authentication, and access control - even without those exact words.

```bash
gno vsearch "how to protect my app"
```

### Reciprocal Rank Fusion
The `query` command combines both methods using RRF, a proven algorithm that merges ranked lists. Documents that score well in both methods rise to the top.

```bash
gno query "authentication best practices"
```

### Learn More

For a deep dive into query expansion, HyDE, RRF fusion, and reranking, see the **[How Search Works](/docs/HOW-SEARCH-WORKS/)** guide.
