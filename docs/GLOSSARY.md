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

```bash
gno search "keyword match"
```

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

Cross-encoder model that rescores results for better relevance. More accurate but slower.

```bash
gno query "topic" --rerank
```

### RRF (Reciprocal Rank Fusion)

Algorithm for combining multiple ranked lists. Score = Σ(1 / (k + rank)) where k=60.

## Storage Terms

### Source

Original file on disk. Tracked by absolute path and sourceHash.

### Mirror

Canonical markdown representation of source content. Identified by mirrorHash.

Multiple sources can share the same mirror (content deduplication).

### Chunk

Text segment (~800 tokens) created during indexing. Each chunk is:
- Indexed in FTS5 for BM25 search
- Optionally embedded for vector search

### Embedding

Vector representation of a chunk. 1024-dimensional float array from bge-m3 model.

### mirrorHash

SHA-256 hash of canonical markdown. Used for content-addressed storage and deduplication.

## Model Terms

### Embed Model

Neural network that converts text to vectors. Default: bge-m3 (multilingual, 1024 dims).

### Rerank Model

Cross-encoder that scores query-document pairs. Default: bge-reranker-v2-m3.

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
- `unicode61`: Unicode-aware (default)
- `porter`: English stemming
- `trigram`: Substring matching

## MCP Terms

### MCP (Model Context Protocol)

Protocol for AI assistants to access external tools and resources. GNO runs as an MCP server.

### Tool

MCP function that AI can invoke. GNO provides: search, vsearch, query, get, multi_get, status.

### Resource

MCP content accessible by URI. Format: `gno://collection/path`

## Exit Codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | SUCCESS | Command completed |
| 1 | VALIDATION | Bad input or arguments |
| 2 | RUNTIME | System or IO error |

## Abbreviations

| Term | Meaning |
|------|---------|
| BM25 | Best Matching 25 (ranking algorithm) |
| FTS | Full-Text Search |
| KNN | K-Nearest Neighbors |
| RAG | Retrieval-Augmented Generation |
| RRF | Reciprocal Rank Fusion |
