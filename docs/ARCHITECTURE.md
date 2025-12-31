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
       │  │   SQLite     │  │    FTS5      │  │    sqlite-vec        │ │
       │  │  (documents, │  │   (BM25)     │  │   (vector KNN)       │ │
       │  │   chunks)    │  │              │  │   (optional)         │ │
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
    ▼ Store (SQLite: documents, content, chunks, FTS)
    │
    ▼ [Optional] Embed chunks (llama.cpp → vectors)
```

### Search Pipeline

```
User query
    │
    ▼ Detect query language (franc, 30+ languages)
    │
    ├─[ BM25-only mode ]─► searchBm25 only
    │
    ▼ BM25 Search (FTS5 full-text)
    │
    ▼ Embed query (llama.cpp)
    │
    ▼ Vector Search (sqlite-vec KNN)
    │
    ▼ [Optional] Query expansion (LLM variants)
    │
    ▼ RRF Fusion (reciprocal rank, k=60)
    │
    ▼ [Optional] Rerank (cross-encoder)
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
| content_fts | FTS5 virtual table for BM25 |
| content_vectors | Embeddings (optional) |

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
| Rerank | Cross-encoder scoring | bge-reranker-v2-m3-Q4 |
| Gen | Answer generation | Qwen3-1.7B-Q4 |

Models are GGUF-quantized for efficiency. First use triggers automatic download.

### Search Modes

| Mode | Description |
|------|-------------|
| BM25 | Keyword matching via FTS5 |
| Vector | Semantic similarity via embeddings |
| Hybrid | BM25 + vector with RRF fusion |
| Reranked | Hybrid + cross-encoder reordering |

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
