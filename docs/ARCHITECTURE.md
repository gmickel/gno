# Architecture

GNO is a local knowledge indexing and search system built on SQLite.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   User                                      │
│                       (developer, researcher, writer)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                 │                 │           │
              ▼                 ▼                 ▼           ▼
        ┌──────────┐     ┌──────────────┐   ┌───────────┐ ┌──────────┐
        │   CLI    │     │  MCP Server  │   │  AI Agent │ │  Web UI  │
        │  (gno)   │     │  (gno mcp)   │   │  (Claude) │ │(gno serve)│
        └──────────┘     └──────────────┘   └───────────┘ └──────────┘
              │                 │                 │           │
              └─────────────────┼─────────────────┴───────────┘
                                │
                                ▼
       ┌───────────────────────────────────────────────────────────────┐
       │                           GNO Core                            │
       │  ┌──────────────┐  ┌────────────┐  ┌────────────────────────┐ │
       │  │  Ingestion   │  │  Pipeline  │  │   LLM Layer            │ │
       │  │  (walker,    │  │  (search,  │  │   (embed, rerank, gen) │ │
       │  │   chunker)   │  │   fusion)  │  │   (node-llama-cpp)     │ │
       │  └──────────────┘  └────────────┘  └────────────────────────┘ │
       └───────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
       ┌───────────────────────────────────────────────────────────────┐
       │                         Storage Layer                         │
       │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
       │  │   SQLite     │  │  FTS5 +      │  │    sqlite-vec        │ │
       │  │  (documents, │  │  Snowball    │  │   (vector KNN)       │ │
       │  │   chunks)    │  │  (20+ langs) │  │   (optional)         │ │
       │  └──────────────┘  └──────────────┘  └──────────────────────┘ │
       └───────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
       ┌───────────────────────────────────────────────────────────────┐
       │                          File System                          │
       │          ~/notes    ~/work/docs    ~/papers                   │
       │           (collections configured by user)                    │
       └───────────────────────────────────────────────────────────────┘
```

## Data Flow

### Ingestion Pipeline

```
File on disk
    │
    ▼ Walker (glob patterns, exclude lists)
    │
    ▼ Hash source content (SHA-256 → sourceHash)
    │
    ├─[ sourceHash unchanged ]─► Skip (file not modified)
    │
    ▼ Converter (MIME detection → Markdown)
    │
    ▼ Canonicalize (NFC, normalize whitespace)
    │
    ▼ Hash canonical markdown (→ mirrorHash)
    │
    ├─[ mirrorHash exists ]─► Reuse content (deduplication)
    │
    ▼ Chunker (~800 tokens, 15% overlap)
    │
    ▼ Store (SQLite: documents, content, chunks, document-level FTS)
    │
    ▼ [Optional] Embed chunks with title context (llama.cpp → vectors)
    │   Format: "title: Doc Title | text: chunk content..."
```

### Search Pipeline

```
User query
    │
    ▼ Detect query language (franc, 30+ languages)
    │
    ├─[ BM25-only mode ]─► searchBm25 only (document-level)
    │
    ▼ Strong signal check (skip expansion if confident BM25 match)
    │
    ▼ [Optional] Query expansion (LLM variants + HyDE)
    │
    ▼ Document-level BM25 Search (FTS5 + Snowball stemmer)
    │
    ▼ Chunk-level Vector Search (sqlite-vec KNN)
    │
    ▼ RRF Fusion (k=60, 2× weight for original, tiered bonus)
    │
    ▼ [Optional] Rerank with full documents (Qwen3, 32K context)
    │
    ▼ Results (sorted by blended score)
```

## Code Architecture

GNO uses **"Ports without DI"** - a pragmatic simplification of hexagonal architecture:

```
CLI/MCP/Web UI → new Adapter() → adapter.createPort() → Port interface → Pipeline
```

**Port interfaces** (in `src/llm/types.ts`):
- `EmbeddingPort` - vector embeddings
- `GenerationPort` - LLM text generation
- `RerankPort` - cross-encoder reranking
- `VectorIndexPort` - vector search (in `src/store/vector`)

**Adapters** (instantiate ports):
- `LlmAdapter` - creates LLM ports via node-llama-cpp
- `SqliteAdapter` - SQLite storage

**Why not full hexagonal?**
- Single implementation per port (no swappable backends)
- CLI tool with fixed dependencies - DI adds complexity without benefit
- Pipeline code still testable via port interfaces

## Key Components

### Storage

| Table | Purpose |
|-------|---------|
| documents | Source file tracking (path, hash, docid) |
| content | Canonical markdown by mirrorHash |
| content_chunks | Chunked text (800 tokens each) |
| documents_fts | Document-level FTS5 with Snowball stemmer |
| content_vectors | Chunk embeddings with title context (optional) |

### Content Addressing

GNO uses content-addressed storage:

- `sourceHash` = SHA-256 of original file content
- `mirrorHash` = SHA-256 of canonical markdown

Multiple source files with identical canonical content share the same chunks and vectors. This deduplicates storage and speeds up indexing.

### LLM Models

All models run locally via node-llama-cpp:

| Model | Purpose | Default |
|-------|---------|---------|
| Embed | Generate vector embeddings | bge-m3-Q4 (1024 dims) |
| Rerank | Cross-encoder scoring | Qwen3-Reranker-0.6B-Q8 (32K context) |
| Gen | Answer generation | Qwen3-1.7B-Q4 |

Models are GGUF-quantized for efficiency. First use triggers automatic download.

### Search Modes

| Mode | Description |
|------|-------------|
| BM25 | Document-level keyword matching via FTS5 + Snowball |
| Vector | Chunk-level semantic similarity with contextual embeddings |
| Hybrid | BM25 + vector with RRF fusion (2× original weight, tiered bonus) |
| Reranked | Hybrid + full-document cross-encoder (32K context) |

## Graceful Degradation

GNO works with reduced capabilities when components are missing:

| Component | If Missing | Behavior |
|-----------|------------|----------|
| sqlite-vec | Extension not loaded | BM25 search only |
| Embed model | Not downloaded | Vector search disabled |
| Rerank model | Not downloaded | Skip reranking |
| Gen model | Not downloaded | `--answer` disabled |

Run `gno doctor` to check component status.

## File Locations

**Linux** (XDG standard):
| Location | Purpose |
|----------|---------|
| `~/.config/gno/index.yml` | Configuration |
| `~/.local/share/gno/index-default.sqlite` | Database |
| `~/.cache/gno/models/` | Model cache |

**macOS**:
| Location | Purpose |
|----------|---------|
| `~/Library/Application Support/gno/config/index.yml` | Configuration |
| `~/Library/Application Support/gno/data/index-default.sqlite` | Database |
| `~/Library/Caches/gno/models/` | Model cache |

Run `gno doctor` to see resolved paths.

## Technical Notes

For implementation details, see:

- [How Search Works](HOW-SEARCH-WORKS.md) - Deep dive into query expansion, HyDE, and RRF fusion
- [docs/NOTES.md](NOTES.md) - Internal architecture notes
- [spec/cli.md](../spec/cli.md) - CLI specification
- [spec/mcp.md](../spec/mcp.md) - MCP specification
