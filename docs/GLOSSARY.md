# Glossary

Key terms and concepts in GNO.

## Core Concepts

### Collection

A named group of documents from a single directory. Collections define:

- Path to source files
- Glob patterns for matching
- Include/exclude rules
- Optional language hint

```bash
gno collection add ~/notes --name notes --pattern "**/*.md"
```

### Context

Semantic hint attached to a scope to improve search relevance. Contexts provide additional meaning beyond the raw text.

Scope types:

- **Global** (`/`): Applies to all documents
- **Collection** (`notes:`): Applies to a collection
- **Prefix** (`gno://notes/projects`): Applies to path prefix

### Document

A single indexed file. Each document has:

- `docid`: Unique identifier (8-char hash prefix)
- `sourceHash`: SHA-256 of original file content
- `mirrorHash`: SHA-256 of canonical markdown

### Virtual URI

GNO's internal document identifier format:

```
gno://collection/relative/path/to/file.md
```

Used in search results and resource access.

## Search Terms

### BM25

Best Matching 25 - a ranking function for full-text search. Matches keywords based on term frequency and document length. Fast and works without models.

GNO uses **document-level BM25**: entire documents are indexed, not individual chunks. This means a query for "authentication JWT" finds documents where these terms appear anywhere, even in different sections.

```bash
gno search "keyword match"
```

### Strong Signal Detection

Optimization that skips expensive query expansion when BM25 already has a confident match. Triggered when the top result's normalized score is ≥ 0.84 AND the gap to #2 is ≥ 0.14. Saves 1-3 seconds per query.

### Vector Search

Semantic similarity search using embeddings. Finds conceptually similar content even without exact keyword matches.

```bash
gno vsearch "concept to find"
```

### Hybrid Search

Combines BM25 and vector search using Reciprocal Rank Fusion (RRF). Best of both approaches.

```bash
gno query "semantic plus keywords"
```

### Reranking

Cross-encoder model that rescores results for better relevance. More accurate but slower. Enabled by default with `gno query`.

```bash
gno query "topic"           # reranking enabled by default
gno query "topic" --no-rerank  # disable for speed
```

### RRF (Reciprocal Rank Fusion)

Algorithm for combining multiple ranked lists. Score = Σ(weight / (k + rank)) where k=60.

GNO applies **2× weight** to original query results to prevent dilution by LLM-generated variants.

See [How Search Works](HOW-SEARCH-WORKS.md) for detailed explanation.

### Tiered Top-Rank Bonus

Score boost applied to top-ranked documents before reranking: +0.05 for rank #1, +0.02 for ranks #2-3. Preserves strong initial retrieval signals through the pipeline.

### Query Expansion

LLM-powered technique that generates query variants to improve recall. Creates lexical variants (for BM25), semantic variants (for vectors), and HyDE passages.

See [How Search Works](HOW-SEARCH-WORKS.md#query-expansion-with-hyde) for details.

### HyDE (Hypothetical Document Embeddings)

Technique where an LLM generates a hypothetical document answering the query. The embedding of this synthetic document often better matches real answer documents than the original question embedding.

See [How Search Works](HOW-SEARCH-WORKS.md#query-expansion-with-hyde) for details.

## Storage Terms

### Source

Original file on disk. Tracked by absolute path and sourceHash.

### Mirror

Canonical markdown representation of source content. Identified by mirrorHash.

Multiple sources can share the same mirror (content deduplication).

### Chunk

Text segment (~800 tokens) created during indexing. Each chunk is:

- Part of document-level FTS5 index
- Optionally embedded for vector search with contextual prefix

### Contextual Chunking

Technique where each chunk is embedded with its document title prepended: `title: My Doc | text: chunk content...`. Helps the embedding model understand context. A chunk about "configuration" in a React doc is semantically different from one in a database doc. Based on Anthropic's contextual retrieval research.

### Embedding

Vector representation of a chunk. 1024-dimensional float array from bge-m3 model, with contextual title prefix.

### mirrorHash

SHA-256 hash of canonical markdown. Used for content-addressed storage and deduplication.

## Model Terms

### Embed Model

Neural network that converts text to vectors. Default: bge-m3 (multilingual, 1024 dims).

### Rerank Model

Cross-encoder that scores query-document pairs. Default: Qwen3-Reranker-0.6B (32K context). GNO passes **full document content** to the reranker, not truncated snippets, ensuring the model sees tables, code examples, and all sections.

### Gen Model

Language model for answer generation. Options:

- Qwen3-1.7B (slim preset)
- SmolLM3-3B (balanced preset)
- Qwen3-4B (quality preset)

### GGUF

Quantized model format for efficient inference. Used by llama.cpp.

### Model Preset

Predefined model configuration. Available presets: slim, balanced, quality.

## Database Terms

### FTS5

SQLite's full-text search extension. Provides BM25 ranking.

### sqlite-vec

SQLite extension for vector storage and KNN search. Required for vector search.

### Tokenizer

Text segmentation method for FTS5:

- `snowball english`: Snowball stemmer (default, 20+ languages supported)
- `unicode61`: Unicode-aware, no stemming
- `porter`: English-only stemming (legacy)
- `trigram`: Substring matching

### Snowball Stemmer

Multilingual stemming algorithm for FTS5. Reduces words to their root form: "running" → "run", "scored" → "score". Supports 20+ languages including English, German, French, Spanish, and more. GNO uses Snowball English by default.

## MCP Terms

### MCP (Model Context Protocol)

Protocol for AI assistants to access external tools and resources. GNO runs as an MCP server.

### Tool

MCP function that AI can invoke. GNO provides: gno_search, gno_vsearch, gno_query, gno_get, gno_multi_get, gno_status.

### Resource

MCP content accessible by URI. Format: `gno://collection/path`

## Exit Codes

| Code | Name       | Meaning                |
| ---- | ---------- | ---------------------- |
| 0    | SUCCESS    | Command completed      |
| 1    | VALIDATION | Bad input or arguments |
| 2    | RUNTIME    | System or IO error     |

## Abbreviations

| Term | Meaning                              |
| ---- | ------------------------------------ |
| BM25 | Best Matching 25 (ranking algorithm) |
| FTS  | Full-Text Search                     |
| KNN  | K-Nearest Neighbors                  |
| RAG  | Retrieval-Augmented Generation       |
| RRF  | Reciprocal Rank Fusion               |
