# GNO Architecture Notes

Reviewed at commit: `5ea263f`

> Internal reference for maintainers. See `spec/` for interface contracts.

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI Layer                                   │
│   (index, search, vsearch, query, ask, embed, get, status, cleanup)     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────┬───────────────┴───────────────┬─────────────────────┐
│   Config Layer    │      Pipeline Layer           │    LLM Layer        │
│  (config/types)   │  (hybrid, search, vsearch)    │  (embed, rerank,    │
│                   │  (fusion, rerank, expansion)  │   gen, llama.cpp)   │
└───────────────────┴───────────────────────────────┴─────────────────────┘
                                    │
┌───────────────────────────────────┴─────────────────────────────────────┐
│                          Ingestion Layer                                 │
│   walker → converter → canonicalize → chunker → store                   │
│   (bun:glob)  (registry)   (NFC+hash)  (800tok)   (sqlite)             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┴─────────────────────────────────────┐
│                          Storage Layer                                   │
│   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│   │  SQLite     │  │  FTS5        │  │  sqlite-vec  │                   │
│   │ (bun:sqlite)│  │  (bm25)      │  │  (optional)  │                   │
│   └─────────────┘  └──────────────┘  └──────────────┘                   │
│        documents, content, content_chunks, content_vectors              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Abstractions (Port/Adapter Pattern)

- **StorePort** - SQLite adapter (migrations, collections, documents, chunks, FTS)
- **VectorIndexPort** - sqlite-vec adapter (per-model vec tables, graceful degradation)
- **EmbeddingPort** - llama.cpp GGUF embeddings
- **RerankPort** - llama.cpp GGUF cross-encoder
- **ChunkerPort** - Character-based markdown chunking
- **ConverterPort** - MIME→Markdown conversion (registry, first-match wins)

## 2. Data Flow (Ingestion)

```
File on disk
    │
    ▼ walker (glob patterns, exclude list)
WalkEntry { absPath, relPath, size, mtime }
    │
    ▼ hash source content (SHA-256 → sourceHash)
    │
    ├─[ sourceHash unchanged ]─► skip (unchanged)
    │
    ▼ converter registry (MIME detection → first matching converter)
ConvertOutput { markdown, title, languageHint, meta }
    │
    ▼ canonicalize (NFC, BOM strip, control chars, collapse blanks)
    │
    ▼ mirrorHash = SHA-256(canonical markdown)
    │
    ├─[ mirrorHash exists ]─► reuse existing content (content-addressed)
    │
    ▼ chunker (800 tokens * 4 chars = 3200 max, 15% overlap)
ChunkOutput[] { seq, pos, text, startLine, endLine, language }
    │
    ▼ store (upsertDocument, upsertContent, upsertChunks, rebuildFts)
```

**Content Addressing**: Multiple documents can share the same `mirror_hash` if their canonical markdown is identical. This deduplicates storage and FTS indexing.

## 3. Query Flow (Hybrid Search)

```
User query
    │
    ▼ detectQueryLanguage (franc, 30+ languages, ≥15 chars)
    │
    ├─[ BM25-only mode (no sqlite-vec) ]─► searchBm25 only
    │
    ▼ searchBm25 (FTS5 + escapeFts5Query)
    │
    ▼ embedQuery (llama.cpp)
    │
    ▼ searchVector (sqlite-vec knn)
    │
    ▼ [optional] query expansion (LLM generates variants)
    │   └─► additional BM25 + vector searches
    │
    ▼ RRF fusion (reciprocal rank, k=60)
    │   └─► bm25Weight=1.0, vecWeight=1.0
    │   └─► topRankBonus=0.1 if both top-5
    │
    ▼ [optional] rerank (cross-encoder)
    │   └─► position-aware blending schedule
    │
    ▼ Final results (sorted by blendedScore)
```

## 4. Score Semantics

**IMPORTANT**: Scores are normalized per-query and NOT comparable across queries.

### BM25 (src/pipeline/search.ts:29-52)

```
Raw BM25: smaller (more negative) = better match
Normalization: min-max scaling to [0,1]
  normalized = (worst - raw) / (worst - best)
  where worst = max(scores), best = min(scores)
  Edge case: if all scores equal (best === worst), all get 1.0
Result: 1.0 = best match in result set, 0.0 = worst
```

### Vector (src/pipeline/vsearch.ts:26-28)

```
Cosine distance: 0 = identical, 2 = opposite
Similarity = 1 - (distance / 2)
Result: [0,1] where 1.0 = identical vectors
```

### RRF Fusion (src/pipeline/fusion.ts)

```
RRF score = Σ weight / (k + rank)
  k = 60 (default)
  bm25Weight = 1.0
  vecWeight = 1.0
  variant weights (fusion.ts:66-106): bm25_variant=0.5, vector_variant=0.5, hyde=0.7
  topRankBonus = 0.1 (added if result in top-5 of both BM25 and vector)
```

### Blending (src/pipeline/rerank.ts + types.ts:196-200)

Position-aware blending between fusion and rerank scores:

| Position | Fusion Weight | Rerank Weight |
|----------|---------------|---------------|
| 1-3      | 0.75          | 0.25          |
| 4-10     | 0.60          | 0.40          |
| 11+      | 0.40          | 0.60          |

**minScore filter**: Applied AFTER normalization (search.ts:357-361).

## 5. Model Presets

Presets define disk storage only. RAM varies by context length, batch size, GPU offload.

| Preset | Disk | Embed | Rerank | Gen |
|--------|------|-------|--------|-----|
| slim | ~1GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | Qwen3-1.7B-Q4 |
| balanced | ~2GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | SmolLM3-3B-Q4 |
| quality | ~2.5GB | bge-m3-Q4 | bge-reranker-v2-m3-Q4 | Qwen3-4B-Q4 |

All use bge-m3 (multilingual, 1024 dims) for embedding.

**RAM Note**: Actual memory usage depends on:
- Context window size (longer = more RAM)
- GPU offload (VRAM vs system RAM)
- Batch size during embedding

## 6. Design Decisions

### Content-Addressed Storage
- `mirror_hash` = SHA-256 of canonical markdown
- Multiple source files can share same mirror (dedup)
- Chunks keyed by (mirror_hash, seq)
- Vectors keyed by (mirror_hash, seq, model)

### FTS Tokenizer Immutability
- Tokenizer stored in `schema_meta.fts_tokenizer`
- Changing tokenizer requires `--rebuild-fts` (drops and recreates FTS table)
- Options: unicode61 (default), porter (stemming), trigram (substring)

### Per-Model Vector Tables
- Table name: `vec_<sha256(modelUri)[:8]>`
- Avoids dimension mismatches when switching models
- Graceful degradation: storage works without sqlite-vec

### Converter Priority (registry.ts)
1. native/markdown (.md)
2. native/plaintext (.txt)
3. adapter/markitdown-ts (.pdf, .docx, .xlsx)
4. adapter/officeparser (.pptx)

### Canonicalization Contract (canonicalize.ts)
**BREAKING CHANGE WARNING**: Modifying these rules invalidates all mirrorHash values.
- Strip BOM (U+FEFF)
- Normalize \r\n → \n
- NFC Unicode normalization
- Strip control chars except \n, \t
- Trim trailing whitespace per line
- Whitespace-only lines treated as blank (trim first, then count)
- Collapse 2+ blank lines → 1
- Ensure single trailing \n

## 7. Graceful Degradation Paths

| Component | If Missing | Behavior |
|-----------|------------|----------|
| sqlite-vec | Not installed | Vector storage works, search disabled |
| Embedding model | Not downloaded | `gno embed` fails, hybrid falls back to BM25-only |
| Reranker model | Not downloaded | Skip reranking, use fusion scores only |
| Gen model | Not downloaded | `gno ask --answer` fails |
| Collection path | Not accessible | Ingestion errors recorded per-file |

sqlite-vec graceful degradation (sqlite-vec.ts):
1. Try load extension
2. If fail: `searchAvailable = false`, `loadError` set
3. Vectors stored in `content_vectors` (always works)
4. KNN search disabled, queries fall back to BM25

## 8. Interface Invariants

### Exit Codes (spec/cli.md)
- 0 = SUCCESS
- 1 = VALIDATION (user error, bad input)
- 2 = RUNTIME (system error, retryable)

### Output Formats
- `--json` - JSON to stdout (default for scripting)
- `--files` - One path per line
- `--csv` - CSV with header
- `--md` - Markdown table
- `--xml` - XML document

### Error Shape (--json mode)
```json
{ "error": { "code": "ERROR_CODE", "message": "...", "details": {} } }
```

### Schema Contract
12 JSON schemas in `spec/output-schemas/`:
- search-result.schema.json
- status.schema.json
- sync-result.schema.json
- etc.

Contract tests: `test/spec/schemas/` using Ajv validator.

### MCP Interface (spec/mcp.md)
Tools: search, vsearch, query, get, multi_get, status
Resource: `gno://collection/path/to/file`

## 9. Database Schema Summary

| Table | Purpose |
|-------|---------|
| schema_meta | Migration version, fts_tokenizer |
| collections | Collection definitions from config |
| contexts | Context metadata from config |
| documents | Source file tracking (sourceHash → docid, mirrorHash) |
| content | Canonical markdown by mirrorHash |
| content_chunks | Chunked text (mirrorHash, seq, pos, startLine, endLine) |
| content_fts | FTS5 virtual table (text) |
| content_vectors | Embeddings (mirrorHash, seq, model, embedding) |
| vec_<hash> | sqlite-vec KNN index (per model) |
| ingest_errors | Error log |
| llm_cache | Response caching |

Key relationships:
- documents.mirror_hash → content.mirror_hash (many-to-one)
- content_chunks.mirror_hash → content.mirror_hash
- content_vectors (mirror_hash, seq) → content_chunks (mirror_hash, seq)
