# Architecture

GNO is a local knowledge indexing and search system built on SQLite.

## Project-affinity seam

Caller trust is resolved before pipeline entry. The local CLI canonicalizes
cwd or explicit roots, discovers repository/worktree roots, and matches them to
configured collection paths with realpath-safe segment containment. SDK, REST,
MCP, and browser inputs remain opaque/untrusted and resolve to zero matches.

After each pipeline's base relevance is final—and before document cutoff/order—
one matched collection can request `+0.03`. Overlapping or duplicate roots do
not stack. All auxiliary signals use the order-independent shared formula
`clamp(sum, -0.08, 0.08)` before the final score is clamped to `0..1`.
Candidate breadth requested and returned are each bounded to at most `3×` the
output limit; complete StorePort call receipts enforce per-method maxima and
reject unexpected calls. Existing hard filters run unchanged. Explain uses
deterministic aliases, not absolute roots. Diagnose emits those closed redacted
fields only in affinity-bearing v1.1 output; zero-affinity requests preserve
exact legacy v1.0 bytes and omit `affinity`.

Configured content-type ranking enters the same seam. One canonical rule is
resolved from configured type ID before longest-prefix matching;
`searchBoost: 0.5..2` maps linearly to `-0.05..+0.05`. It composes
order-independently with affinity under the shared cap, cannot create a
candidate, and runs only after hard document filters. Explain carries the full
score receipt and live ranking fingerprint. Diagnose uses v1.2 only when this
component is active. Search-boost-only config changes affect live ranking but
not persisted metadata derivation, so they do not trigger conversion or vector
rebuilds.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   User                                      │
│                       (developer, researcher, writer)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────────────┐
              │                 │                 │           │       │
              ▼                 ▼                 ▼           ▼       ▼
        ┌──────────┐     ┌──────────────┐   ┌───────────┐ ┌──────────┐ ┌──────────┐
        │   CLI    │     │  MCP Server  │   │  AI Agent │ │  Web UI  │ │   SDK    │
        │  (gno)   │     │  (gno mcp)   │   │  (Claude) │ │(gno serve)│ │ (import) │
        └──────────┘     └──────────────┘   └───────────┘ └──────────┘ └──────────┘
              │                 │                 │           │       │
              └─────────────────┼─────────────────┴───────────┴───────┘
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

### Resident runtime ownership

`gno serve` and `gno daemon` are mutually exclusive modes of one resident core
per data directory. That core owns store/writer coordination, bounded readers,
the watcher and scheduler, jobs, model manager, session/request admission,
generation counters, and graceful shutdown. Serve adds Web UI and the full
loopback REST API; daemon stays headless. Both mount the same stateful MCP
surface at `/mcp` and safe lifecycle status endpoints.

Stdio MCP and direct CLI commands remain truthful standalone processes. They
reuse the same pure MCP tool/resource definitions but do not claim attachment
to the resident listener. Every HTTP MCP session owns independent SDK
server/transport state while borrowing resident stores and model leases.

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
    ▼ Chunker (~800 tokens, 15% overlap, code-aware for ts/js/python/go/rust family)
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
    ▼ Classify query language (franc, explicit 34-language allowlist)
    │
    ├─[ Structured query modes provided ]─► Use provided term/intent/hyde entries
    │
    ├─[ BM25-only mode ]─► searchBm25 only (document-level)
    │
    ▼ Strong signal check (skip expansion if confident BM25 match)
    │
    ▼ [Optional] Query expansion (LLM variants + HyDE)
    │
    ▼ Document-level BM25 Search (FTS5 + Snowball stemmer, weighted title/path/body)
    │
    ▼ Chunk-level Vector Search (sqlite-vec KNN)
    │
    ▼ [Optional] Bounded graph expansion (top seeds → one-hop neighbors)
    │
    ▼ RRF Fusion (k=60, 2× weight for original, tiered bonus)
    │
    ▼ [Optional] Rerank best chunk per document (Qwen3, 4K chars)
    │
    ▼ Results (sorted by blended score)
    │
    ▼ [Optional] Answer stage (adaptive source selection + citation hygiene)
```

### Retrieval V2 Controls

- **Structured query modes**: callers can pass explicit `term`, `intent`, and `hyde` entries.
- **Graph expansion**: when `--graph` is passed, hybrid query uses the current document graph as a bounded candidate-generation signal. It starts from top BM25/vector seeds, follows one-hop neighbors, caps added candidates, and weights explicit links above inferred, ambiguous, or similarity edges.
- **Compatibility**: existing query calls still work; structured modes are opt-in.
- **Mode behavior**: when structured modes are present, generated expansion is skipped for that query.

### Typed Graph Layer

GNO keeps positional links and semantic relationships separate:

- `doc_links` records how a link was written (`wiki` or `markdown`) and keeps
  line/column/link-text metadata for link listings.
- `doc_edges` records what the relationship means with `edgeType`,
  `confidence`, and `edgeSource`.

During sync, GNO projects wiki/markdown links into typed edges, parses
`relations:` frontmatter into explicit relation edges, and applies the first
matching `contentTypes[].graphHints` value as the projected edge type for plain
links. Reads join active source and target documents so inactive renamed files
do not surface stale edges.

`syncAll` defers this projection until every collection has synced, then runs
one exact global reconciliation. File-watcher batches use path-scoped ingestion
and reproject changed sources plus known backlinks; periodic/full sync remains
the exact fallback for previously unresolved frontmatter targets. Projection
yields to the event loop in bounded intervals so HTTP requests remain
responsive during larger graph rebuilds.

`gno graph query`, REST `/api/graph/query`, and MCP `gno_graph_query` all wrap
the same bounded traversal core. `gno query diagnose`, REST
`/api/query/diagnose`, and MCP `gno_query_diagnose` wrap the same target-first
diagnostic pipeline.

### Observability Surfaces

- `--explain` includes per-stage timings (`lang`, `expansion`, `bm25`, `vector`, `fusion`, `rerank`, `assembly`, `total`).
- `--explain` includes graph expansion seed/candidate counts, edge-confidence counts, and fallback reasons when graph expansion is enabled or skipped.
- Explain output includes fallback + cache counters for retrieval diagnostics.
- Result explain lines include score components (bm25/vector/fusion/rerank/blended).
- `gno ask --json` may include `meta.answerContext` with selected/dropped source explain details.

## Code Architecture

GNO uses **"Ports without DI"** - a pragmatic simplification of hexagonal architecture:

```
CLI/MCP/Web UI/SDK → new Adapter() → adapter.createPort() → Port interface → Pipeline
```

**Port interfaces** (in `src/llm/types.ts`):

- `EmbeddingPort` - vector embeddings
- `GenerationPort` - LLM text generation
- `RerankPort` - cross-encoder reranking
- `VectorIndexPort` - vector search (in `src/store/vector`)

**Adapters** (instantiate ports):

- `LlmAdapter` - creates LLM ports via node-llama-cpp
- `SqliteAdapter` - SQLite storage

**SDK surface**:

- package root exports `createGnoClient(...)`
- supports inline config or file-backed config
- exposes direct retrieval + indexing methods without CLI subprocesses

**Why not full hexagonal?**

- Single implementation per port (no swappable backends)
- CLI tool with fixed dependencies - DI adds complexity without benefit
- Pipeline code still testable via port interfaces

## Key Components

### Storage

| Table           | Purpose                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| documents       | Source file tracking (path, hash, docid)                                       |
| content         | Canonical markdown by mirrorHash                                               |
| content_chunks  | Chunked text (800 tokens each; structural first-pass for supported code files) |
| documents_fts   | Document-level FTS5 with Snowball stemmer                                      |
| content_vectors | Chunk embeddings with title context (optional)                                 |
| doc_tags        | Document tags (frontmatter and user-added)                                     |
| doc_links       | Wiki and markdown links between documents                                      |

### Content Addressing

GNO uses content-addressed storage:

- `sourceHash` = SHA-256 of original file content
- `mirrorHash` = SHA-256 of canonical markdown

Multiple source files with identical canonical content share the same chunks and vectors. This deduplicates storage and speeds up indexing.

### LLM Models

All models run locally via node-llama-cpp:

| Model  | Purpose                    | Default                              |
| ------ | -------------------------- | ------------------------------------ |
| Embed  | Generate vector embeddings | Qwen3-Embedding-0.6B-Q8              |
| Rerank | Cross-encoder scoring      | Qwen3-Reranker-0.6B-Q8 (32K context) |
| Gen    | Answer generation          | Qwen3-1.7B-Q4                        |

Models are GGUF-quantized for efficiency. First use triggers automatic download.

### Search Modes

| Mode     | Description                                                      |
| -------- | ---------------------------------------------------------------- |
| BM25     | Document-level keyword matching via weighted FTS5 + Snowball     |
| Vector   | Chunk-level semantic similarity with contextual embeddings       |
| Hybrid   | BM25 + vector with RRF fusion (2× original weight, tiered bonus) |
| Reranked | Hybrid + best-chunk-per-document cross-encoder (4K chars)        |

## Graceful Degradation

GNO works with reduced capabilities when components are missing:

| Component    | If Missing           | Behavior               |
| ------------ | -------------------- | ---------------------- |
| sqlite-vec   | Extension not loaded | BM25 search only       |
| Embed model  | Not downloaded       | Vector search disabled |
| Rerank model | Not downloaded       | Skip reranking         |
| Gen model    | Not downloaded       | `--answer` disabled    |

Run `gno doctor` to check component status.

## Retrieval-Proven Activation

CLI status/doctor, REST, and Web/Desktop onboarding consume one shared passive
activation model. A collection becomes lexically ready only after a bounded,
corpus-derived term returns the expected local source. Exact-fingerprint
deterministic negatives are reusable; transient query/result failures retry.

Passive identity uses document URI/source/mirror metadata, schema/tokenizer
identity, and the owned `fts_mirror_hash` marker. It does not select Markdown or
FTS bodies. Cold proof content work is capped at 64 prefixes of 32,768 characters
and 64 terms. Semantic capability is tri-state and independent from lexical
readiness. Connector proof is active only behind an explicit user action; all
ordinary health/status reads load bounded persisted projections and never start
a client process.

### Verified setup transaction

`gno setup` owns a short-lived store directly. It never consults resident
process status, attaches to `/mcp`, or enqueues through Web/daemon state. The
lexical transaction persists one closed `FolderSetupReceipt@1.0` across six
ordered stages and succeeds only after a corpus-derived query returns an exact
source URI.

Semantic work is composition, not another lexical stage. A detached one-shot
process owns `setup-semantic@1.0`, embeds one collection, updates its private
receipt, and exits. Connector composition is separate again: after lexical
proof the CLI opens its own store, installs only explicitly requested targets,
and verifies MCP targets with a bounded read. Store lifecycle and connector
failures reduce to bounded per-target results and cannot replace lexical
success.

Embedding inputs are clamped to the active local model context when tokenizer
metadata is available. Chunking remains the first guardrail; the runtime clamp
keeps pathological direct inputs from reaching native inference oversized.

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

## Link System

GNO extracts and tracks links between documents:

### Link Types

| Type     | Syntax                                       | Example                                      |
| -------- | -------------------------------------------- | -------------------------------------------- |
| Wiki     | `[[Target]]`                                 | `[[My Note]]`                                |
| Wiki     | `[[Target\|Display]]`                        | `[[My Note\|click here]]`                    |
| Wiki     | `[[Target#Heading]]`                         | `[[My Note#Section]]`                        |
| Wiki     | `[[collection:Target]]`                      | `[[work:Project Plan]]`                      |
| Wiki     | `[Display]([[Target]])`                      | `[Plan]([[Project Plan]])`                   |
| Wiki     | `&#123;&#123;embed ((block-id))&#125;&#125;` | `&#123;&#123;embed ((63f1d1a8))&#125;&#125;` |
| Markdown | `[text](path.md)`                            | `[docs](./README.md)`                        |

External URLs (https://) are NOT stored—only internal document links.

### Resolution

Links are resolved at query time, not stored with target document IDs. This handles document renames gracefully:

- **Wiki links**: Normalized title match with path-style fallbacks (basename/rel_path, optional .md)
- **Cross-collection**: `[[collection:Note]]` syntax with explicit collection prefix
- **Markdown links**: Resolved path stored for matching

Note: Case-insensitive matching relies on SQLite `lower()` (ASCII-only unless ICU).

### Storage

The `doc_links` table stores:

- Source document reference
- Link type (wiki/markdown)
- Target reference (raw and normalized)
- Position (line/column for editor integration)
- Optional anchor (#section) and display text

Links are extracted from original source content during sync, excluding frontmatter and code blocks.

## Technical Notes

For implementation details, see:

- [How Search Works](HOW-SEARCH-WORKS.md) - Deep dive into query expansion, HyDE, and RRF fusion
- [spec/cli.md](../spec/cli.md) - CLI specification
- [spec/mcp.md](../spec/mcp.md) - MCP specification
