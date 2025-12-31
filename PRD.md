# PRD: GNO - Local Knowledge Index and Retrieval (CLI + MCP)

**Document status:** Draft (spec-driven, implementation-driving)
**Last updated:** 2025-12-23
**Working product name:** GNO (from “gnosis”)
**Binary / command (default):** `gno`
**Virtual URI scheme (default):** `gno://`
**Primary interfaces:** CLI + MCP server (stdio)
**Implementation stack:** Bun + TypeScript (ESM), SQLite (FTS5), sqlite-vec, node-llama-cpp
**Hard constraint:** No Python dependency anywhere in the toolchain (conversion and inference included)

---

## 1. Summary

GNO is a local-first knowledge indexing and retrieval system that:

* Ingests Markdown and common document formats (DOCX, PPTX, XLSX, PDF, TXT, and more over time).
* Converts non-Markdown files into deterministic Markdown mirrors for indexing, search, and retrieval.
* Provides high retrieval quality via:

  * BM25 keyword search (SQLite FTS5)
  * vector semantic search (sqlite-vec)
  * hybrid search with structured query expansion, parallel retrieval, fusion, reranking, and explainability
* Runs fully on-device:

  * No external services required
  * No separate LLM runtime required (no Ollama)
  * Local inference via node-llama-cpp with GGUF models resolved and cached automatically
* Exposes capabilities through:

  * a world-class CLI for humans and scripting
  * an MCP server so agent runtimes can query and read local knowledge via tools and `gno://` resources
* Optimizes for first-run success (MVP):

  * `gno init` creates config and index DB (migrations) and can register content roots
  * `gno index` performs ingestion plus embedding in one command (wrapper over `update` plus `embed`)
  * `gno ask` is the human-default query UX (citations-first; optional short grounded synthesis)
  * target: first useful result in 3 commands or fewer (`init` -> `index` -> `ask`)

---

## 2. Naming and configurability

### 2.1 Defaults (MVP)

* Tool name: GNO
* CLI: `gno`
* URI scheme: `gno://`
* Directories (defaults, OS-idiomatic; overridable via env vars and `--config` / `--index`):

  * Linux (XDG):
    * Config dir: `${XDG_CONFIG_HOME:-~/.config}/gno/`
    * Data dir (SQLite DB): `${XDG_DATA_HOME:-~/.local/share}/gno/`
    * Cache dir (models, temp artifacts): `${XDG_CACHE_HOME:-~/.cache}/gno/`

  * macOS:
    * Config dir: `~/Library/Application Support/gno/config/`
    * Data dir (SQLite DB): `~/Library/Application Support/gno/data/`
    * Cache dir (models, temp artifacts): `~/Library/Caches/gno/`

  * Windows:
    * Config dir: `%APPDATA%\\gno\\config\\`
    * Data dir (SQLite DB): `%LOCALAPPDATA%\\gno\\data\\`
    * Cache dir (models, temp artifacts): `%LOCALAPPDATA%\\gno\\cache\\`

### 2.2 Renaming is cheap by design

All user-visible identifiers must be centrally configurable in `src/app/constants.ts` (or equivalent), including:

* CLI name
* URI scheme
* config/data/cache directory names
* MCP server name
* MCP tool namespace prefix

### 2.3 Directory resolution rules (MVP)

Resolution precedence:
1. Environment overrides (recommended for tests/CI):
   * `GNO_CONFIG_DIR`
   * `GNO_DATA_DIR`
   * `GNO_CACHE_DIR`
2. Platform defaults from §2.1 (XDG vs Library vs AppData)

Index DB path rule:
* DB file is stored under the resolved data dir as:
  * `<dataDir>/index-<indexName>.sqlite`
* `--index <indexName>` selects the file suffix; default index name is `default`.

---

## 3. Goals and non-goals

### 3.1 Goals (MVP)

1. Local-only indexing and search over multiple collections (directories + glob rules).
2. Deterministic conversion to Markdown mirrors suitable for:

   * stable indexing
   * stable embeddings (given same converter version + model)
   * golden conversion fixtures
3. Hybrid retrieval pipeline:

   * structured query expansion (lexical + semantic + optional HyDE)
   * parallel BM25 and vector retrieval
   * fusion via RRF (+ optional top-rank bonus)
   * cross-encoder reranking
   * position-aware blending to keep results stable
4. Zero extra runtime for inference:

   * local embeddings, generation, reranking via node-llama-cpp
   * GGUF models auto-resolved and cached
5. Agent-first interfaces:

   * CLI structured outputs (JSON, files line protocol, CSV, MD, XML)
   * MCP tools/resources with explicit schemas and predictable behavior
6. World-class engineering:

   * spec-driven development
   * layered architecture (ports/adapters)
   * high unit and integration coverage
   * deterministic test fixtures
   * eval harness and regression gates for stochastic or ranking-sensitive behavior (Evalite v1)

7. World-class first-run UX:
   * a user can go from zero to a useful result in 3 commands or fewer (`init` -> `index` -> `ask`)
   * defaults work without manual configuration edits
   * missing optional components (models, vectors) degrade gracefully with actionable diagnostics
   * scripted onboarding is supported via `--yes` (no prompts; safe defaults only)

8. Multilingual-first retrieval:
   * storage and retrieval preserve language signals end-to-end (converter -> chunks -> ranking -> outputs)
   * default model preset is multilingual and robust across DE/FR/IT/EN
   * lexical search remains deterministic, with tokenizer configured per index (DB), and opt-in stemming only where appropriate

### 3.2 Non-goals (MVP)

* GUI application
* Background watch daemon (explicit `gno update` only)
* Cloud indexing, hosted mode, or remote retrieval endpoints (other than MCP over stdio)
* Multi-user collaborative indices
* Editing documents through the tool (read-only retrieval)
* OCR/audio transcription/image understanding (best-effort only if a converter happens to extract it; not required)

---

## 4. Key concepts and invariants

### 4.1 Collection

A named set of files defined by:

* root directory path
* glob pattern(s)
* optional include and exclude rules
* optional update command to run before indexing
* optional contexts (global, per-collection, per-path prefix)

### 4.2 Source file vs Markdown mirror

* Source file: original artifact on disk (example: `contracts/nda.docx`)
* Markdown mirror: deterministic canonical Markdown derived from the source (example: `nda.docx` converted to Markdown)

Invariant:

* Search and retrieval operate on the mirror text.
* Identity, references, and URIs always refer to the source file.

### 4.3 Virtual URI scheme

Stable, transport-friendly identifier:

`gno://<collection>/<relativePath>`

Examples:

* `gno://work/contracts/nda.docx`
* `gno://notes/meetings/2025-11-12.md`

### 4.4 docid

A short handle for quick reference:

* Format: `#<6-8 hex>`
* Derived from `source_hash` (sha256 of source bytes), truncated
* Not stable across edits (edits change source_hash), but stable across converter upgrades if the source bytes are unchanged

Example:

* `#a1b2c3`

### 4.5 Context

Optional human-authored metadata associated with:

* global scope (`/`)
* a collection root (`collection:`)
* a path prefix within a collection (`gno://collection/prefix`)

Context can be used to:

* display richer search results
* optionally improve embeddings/reranking by prepending context to LLM inputs (configurable)

---

## 5. Users and primary workflows

### 5.1 Personas

* Knowledge workers with mixed-format archives (MD + Office + PDFs)
* Engineers building local RAG for personal or team docs
* Agent workflows needing safe, local retrieval (MCP integration)

### 5.2 Golden workflows

Index (fast path, recommended):
* `gno init ~/notes --name notes --pattern "**/*.md"`
* `gno init ~/work/docs --name work --pattern "**/*.{md,pdf,docx,pptx,xlsx,txt}"`
* `gno index`

Index (explicit steps):
* `gno collection add ~/notes --name notes --pattern "**/*.md"`
* `gno collection add ~/work/docs --name work --pattern "**/*.{md,pdf,docx,pptx,xlsx,txt}"`
* `gno update`
* `gno embed`

Ask (human-default):
* `gno ask "termination clause" --collection work`
* `gno ask "wie deployen wir nach staging" --collection work`

Search (lower-level):
* `gno search "termination clause"`
* `gno vsearch "how do we deploy to staging"`
* `gno query "quarterly planning process" --explain`

Retrieve:

* `gno get gno://work/runbooks/oncall.pdf`
* `gno get "#a1b2c3" --line-numbers`
* `gno multi-get "work/runbooks/*" --json`

Agent integration:

* `gno mcp` and tools `gno_search`, `gno_query`, `gno_get`, etc.

---

## 6. Product principles

1. Local truth: source files are authoritative; mirrors are derived.
2. Deterministic interfaces: CLI and MCP outputs are stable, versioned, schema-driven.
3. Explainable retrieval: return docid, URI, path, snippet, scores, and optional line ranges.
4. Fail-soft ingestion: conversion failures do not block indexing; they produce structured errors and actionable diagnostics.
5. Minimal friction for inference: no separate server; models resolved and cached automatically.
6. No Python: all conversion and inference are Node native (Bun/TS) with well-defined adapters.
7. Human-first commands: `init`, `index`, and `ask` provide the simplest on-ramp while preserving lower-level primitives (`collection`, `update`, `embed`, `query`).
8. Multilingual by default: store language hints/tags and use language-aware defaults for embedding, ranking, and explainability.

---

## 7. Functional scope (MVP)

### 7.1 Collections and configuration

Features:

* create/list/remove/rename collections
* per-collection:

  * `path` (absolute)
  * `pattern` (glob)
  * optional `include` extensions allowlist
  * optional `exclude` patterns (defaults include `.git`, `node_modules`, `.venv`, `.idea`, `dist`, `build`)
  * optional `update` shell command executed during `gno update`
  * per-path contexts
  * optional `languageHint` (BCP-47 like `de`, `fr`, `it`, `en`, or `und`; hint only, never required)

Index-level settings (per index DB, not per collection):
* `ftsTokenizer`:
  * default: `unicode61` (multilingual-safe)
  * optional: `porter` (English stemming only; opt-in)
  * optional: `trigram` (if available in the SQLite build; higher index size; validated by `gno doctor`)

Config:
* config file path: `<configDir>/index.yml` (resolved per §2.1–§2.3)
* override via `--config <path>` and env vars (for tests/CI)

Onboarding convenience (MVP):
* `gno init` is a thin, ergonomic wrapper over:
  * config creation (if missing)
  * index DB creation and migrations (if missing)
  * `collection add` (optional, if a path is provided)
  * printing next steps and environment info (resolved config/data/cache paths and index DB path)
* `gno init` must be safe to run repeatedly (idempotent; no destructive actions without explicit flags)

### 7.2 Ingestion and sync

On `gno update`, per collection:

1. Enumerate files matching rules.
2. For each file:

   * stat (mtime, size)
   * if size > `maxBytes` limit, record `TOO_LARGE` error and skip (do not read bytes)
   * read bytes
   * compute `source_hash = sha256(bytes)`
   * detect MIME/ext (layered detection)
   * select converter adapter
   * convert to Markdown mirror
   * canonicalize mirror markdown deterministically
   * compute `mirror_hash = sha256(canonicalMarkdown)`
3. Upsert document record keyed by `(collection, relativePath)`.
4. Store mirror markdown in `content` keyed by `mirror_hash` (dedupe).
5. Chunk mirror content into `content_chunks`.
   * assign `chunk_language` (BCP-47 or `und`) deterministically (see §10.2)
6. Update FTS index over chunks.
7. Mark missing files as inactive (soft delete).
8. Record conversion warnings/errors for diagnostics and status.

Deletion handling:

* If previously indexed file no longer exists, mark document inactive.
* `gno cleanup` removes orphaned content/chunks/vectors not referenced by any active document.

Converter upgrade handling:

* Store `converter_id` and `converter_version` per document.
* If converter version changes (or routing changes), mirror must be regenerated even if source bytes are unchanged.

Human command alias (MVP):
* `gno index` is the recommended human command to build/update an index end-to-end:
  * default behavior: run `gno update` then `gno embed`
  * `--no-embed` runs ingestion only
  * `--collection <name>` scopes ingestion/embedding to a single collection (optional)
  * `--models-pull` allows model download (network) before embedding (prompted unless `--yes`)

### 7.3 Supported file types (MVP)

Always supported:

* `.md` (passthrough + canonicalization)
* `.txt` (plaintext to Markdown + canonicalization)

Converter-backed (MVP):

* `.pdf`, `.docx`, `.xlsx` via a Node MarkItDown port adapter (primary choice: `markitdown-ts`)
* `.pptx` via `officeparser` (239 stars, 119K weekly downloads, in-memory extraction)

Future (explicitly supported by architecture, not MVP):

* pdf.js based PDF extraction
* mammoth DOCX conversion
* PPTX parsing
* SheetJS for XLSX
* additional formats via adapter registry

---

## 8. Converter subsystem (Node-only, deterministic)

This section is implementation-driving.

### 8.1 Converter goals

* Single stable conversion API independent of any vendor library
* Deterministic Markdown output (canonicalization rules locked)
* Structured errors and warnings
* Clear routing via MIME detection and registry
* Golden conversion fixtures in the repo

### 8.2 Converter interfaces

`src/converters/types.ts`:

```ts
export type ConverterId =
  | "native/markdown"
  | "native/plaintext"
  | "adapter/markitdown-ts"
  | string;

export type ConvertInput = {
  sourcePath: string;        // absolute
  relativePath: string;      // within collection
  collection: string;
  bytes: Uint8Array;
  mime: string;
  ext: string;               // ".pdf"
  limits: {
    maxBytes: number;
    timeoutMs: number;
  };
};

export type ConvertWarning = {
  code: "LOSSY" | "TRUNCATED" | "PARTIAL" | "UNSUPPORTED_FEATURE" | "LOW_CONFIDENCE";
  message: string;
  details?: Record<string, unknown>;
};

export type ConvertOutput = {
  markdown: string;          // canonical markdown (see 8.4)
  title?: string;
  languageHint?: string;     // optional BCP-47 or "und"
  meta: {
    converterId: ConverterId;
    converterVersion: string;
    sourceMime: string;
    warnings?: ConvertWarning[];
  };
};

export type ConvertResult =
  | { ok: true; value: ConvertOutput }
  | { ok: false; error: ConvertError };

export interface Converter {
  readonly id: ConverterId;
  readonly version: string;
  canHandle(mime: string, ext: string): boolean;
  convert(input: ConvertInput): Promise<ConvertResult>;
}
```

### 8.3 Error model

`src/converters/errors.ts`:

```ts
export type ConvertErrorCode =
  | "UNSUPPORTED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "CORRUPT"
  | "PERMISSION"
  | "IO"
  | "ADAPTER_FAILURE"
  | "INTERNAL";

export type ConvertError = {
  code: ConvertErrorCode;
  message: string;

  retryable: boolean;
  fatal: boolean;            // reserved for unrecoverable store corruption, not conversion

  converterId: string;
  sourcePath: string;
  mime: string;
  ext: string;

  cause?: unknown;
  details?: Record<string, unknown>;
};
```

Indexing policy (MVP):

* `UNSUPPORTED`, `TOO_LARGE`, `CORRUPT`: document is indexed as metadata-only and marked non-searchable (no chunks), with a recorded error entry.
* `TIMEOUT`, `ADAPTER_FAILURE`: same as above, plus a warning in `gno status`.
* `IO`, `PERMISSION`: warn, continue.
* Conversion errors never crash the full update unless the DB layer fails.

### 8.4 Canonical Markdown conventions

Canonicalization must be deterministic and independent of machine/time.

Rules:

1. Use `\n` newlines.
2. Strip `\u0000` and other non-printable control chars except `\n` and `\t`.
3. Trim trailing whitespace per line.
4. Collapse 3+ blank lines to exactly 2.
5. Ensure exactly one final newline at end of document.

Important:

* Do not inject run-specific timestamps into the canonical markdown.
* Do not inject absolute paths into the canonical markdown.
* Source references are surfaced via document metadata and CLI/MCP outputs, not embedded into mirror content used for hashing/indexing.

Language hint propagation (MVP):
* If a converter provides `languageHint`, persist it on the document record.
* If a converter does not provide `languageHint`, determine language at chunking time (see §10.2) and store per chunk.

Optional (display-only) header:

* `gno get` and MCP resource reads may optionally prepend a short comment header for agent friendliness, but that header must be generated at read time and must not be used to compute `mirror_hash`.

### 8.5 MIME detection strategy

Layered detection:

1. Extension map (MVP):

   * `.md` -> `text/markdown`
   * `.txt` -> `text/plain`
   * `.pdf` -> `application/pdf`
   * `.docx` -> `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   * `.pptx` -> `application/vnd.openxmlformats-officedocument.presentationml.presentation`
   * `.xlsx` -> `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`

2. Lightweight sniffing (MVP+):

   * bytes start with `%PDF-` -> PDF
   * bytes start with `PK\x03\x04` and ext in {docx,pptx,xlsx} -> OOXML MIME
   * fallback to ext map

API:

```ts
export type MimeDetection = {
  mime: string;
  ext: string;
  confidence: "high" | "medium" | "low";
  via: "sniff" | "ext" | "fallback";
};

export interface MimeDetector {
  detect(path: string, bytes: Uint8Array): MimeDetection;
}
```

### 8.6 Converter registry and routing

Priority order (MVP):

1. `native/markdown`
2. `native/plaintext`
3. `adapter/markitdown-ts` (PDF, DOCX, XLSX)
4. `adapter/officeparser` (PPTX)

Selection:

* choose first converter where `canHandle(mime, ext)` is true
* else return `UNSUPPORTED`

### 8.7 MVP converter adapter: markitdown-ts

Responsibilities:

* enforce `maxBytes` and `timeoutMs`
* prefer path-based conversion if supported by the library
* map library exceptions into `ConvertError`
* emit warnings for suspicious output:

  * empty output for non-empty input
  * truncation or partial extraction signals

Hard constraint:

* No Python-based MarkItDown. Node adapter only.

### 8.7b MVP converter adapter: officeparser (PPTX)

Responsibilities:

* handle `.pptx` files (markitdown-ts has incomplete PPTX support)
* extract slide text and speaker notes
* format extracted text as Markdown with filename-derived title
* enforce `maxBytes` (defense in depth; EPIC 5 does pre-read stat check)
* map library exceptions into `ConvertError`

Library choice rationale:

* 239 GitHub stars, 119K weekly npm downloads
* In-memory extraction (no disk writes)
* Full TypeScript support
* Active maintenance (Nov 2024 updates)

### 8.8 Converter golden fixture plan

Fixtures:

```
test/fixtures/conversion/
  pdf/
    simple.pdf
    simple.expected.md
  docx/
    headings.docx
    headings.expected.md
  xlsx/
    sheet1.xlsx
    sheet1.expected.md
  pptx/
    deck1.pptx
    deck1.expected.md
  md/
    sample.md
    sample.expected.md
```

Golden tests:

* converter output must match `*.expected.md` exactly
* converter version is locked in `package.json`
* if output changes, update fixtures deliberately

---

## 9. Storage model and schema (SQLite)

### 9.1 Design intent

* Source identity lives in `documents`
* Mirror content is content-addressed in `content` by `mirror_hash`
* Chunking is mirror-derived and stored in `content_chunks`
* FTS indexes chunk text
* Vectors index chunk embeddings by model
* Contexts are separate and applied at query/runtime

### 9.2 Conceptual tables (MVP)

* `collections`

  * `name`, `path`, `pattern`, `include`, `exclude`, `update_cmd`, timestamps
* `contexts`

  * `scope_type` (global, collection, prefix)
  * `scope_key` (e.g., `/`, `collection:work`, `gno://work/prefix`)
  * `text`
  * timestamps
* `documents`

  * `id`
  * `collection`
  * `rel_path`
  * `title`
  * `source_abs_path`
  * `source_mime`, `source_ext`
  * `source_mtime`, `source_size`
  * `source_hash` (sha256)
  * `docid` (derived from `source_hash`, 8 hex chars)
  * `mirror_hash` (soft reference to `content`, NOT an FK - documents are tracked before content exists; `cleanupOrphans()` handles integrity)
  * `converter_id`, `converter_version`
  * `language_hint` (optional; BCP-47 or `und`)
  * `active`
  * `last_error_code`, `last_error_message` (optional denormalization)
  * timestamps
* `content`

  * `mirror_hash` (PK)
  * `markdown`
  * timestamps
* `content_chunks`

  * `(mirror_hash, seq)` (PK)
  * `pos` (char offset)
  * `text`
  * `start_line`, `end_line` (recommended to support stable line-number output)
  * `language` (BCP-47 or `und`, derived deterministically)
  * `token_count` (optional; if tokenizer is available, for debugging and evals)
* `content_fts` (FTS5 virtual table over chunk text plus doc metadata columns)
* `content_vectors`

  * `(mirror_hash, seq, model)` (PK)
  * `embedding` stored via sqlite-vec backing
  * `embedded_at`
* `llm_cache`

  * `key` (PK)
  * `value`
  * timestamps
* `ingest_errors` (optional but recommended)

  * `(collection, rel_path, occurred_at)`
  * `code`, `message`, `details_json`

Schema source of truth:

* `spec/db/schema.sql` plus migrations

---

## 10. Chunking and indexing

### 10.1 Chunking requirements

* Token-aware chunking preferred when embedding model tokenizer is available
* Deterministic chunk boundaries for a given (model, text) pair
* Default parameters (configurable):

  * `maxTokens = 800`
  * `overlap = 15%` (120 tokens)

Fallback (MVP bootstrapping):

* char-based chunking if tokenizer is not available yet (must be deterministic)

### 10.2 Language detection and tagging (multilingual MVP)

Goals:
* stable per-chunk language tags to improve explainability, ranking prompt selection, and optional language filtering
* deterministic results for the same input text and the same detector version

Policy (MVP):
* Each chunk stores `language` as BCP-47 or `und`.
* Language tag derivation order:
  1. document-level `language_hint` from converter, if present and not `und`
  2. deterministic heuristic detector over chunk text (no network; no stochastic model)
  3. optional collection-level `languageHint` (if configured and not `und`)
  4. else `und`

Implementation guidance (MVP):
* Use a lightweight, deterministic detector with a pinned implementation version in code.
* Detector must not depend on system locale, current time, or non-deterministic APIs.

### 10.3 Indexing surfaces

* FTS indexes chunk text, not entire documents, to align with vector chunk retrieval
* Snippets returned from the best matching chunk(s), with optional line numbers

### 10.4 FTS tokenizer configuration (per index DB, multilingual MVP)

* FTS5 tokenizer is configured at FTS virtual table creation time.
* Therefore tokenizer selection is per index (DB), not per document or per row.
* Default tokenizer is `unicode61`.
* Optional tokenizers (if available) are validated by `gno doctor`.
* Tokenizer selection is stored in index metadata and reported in `gno status`.

---

## 11. Local inference and model strategy (node-llama-cpp)

### 11.1 Runtime requirements

Local inference uses node-llama-cpp with GGUF models, supporting:

* embeddings
* generation (query expansion and optional HyDE)
* reranking (cross-encoder)

Constraints:

* No separate server process
* Safe lifecycle management:

  * keep models loaded for repeated calls when practical
  * dispose contexts/sequences promptly
  * avoid leaking memory across long MCP sessions

### 11.2 Determinism settings (MVP)

For query expansion / HyDE:

* temperature = 0
* bounded max tokens
* versioned prompt templates
* cache results by `(prompt_version, model_uri, input_hash)`

### 11.3 Model management UX

Cache:

* `<cacheDir>/models` (resolved per §2.1–§2.3)

Commands:

* `gno models list`
* `gno models pull [--all|--embed|--rerank|--gen]`
* `gno models clear`
* `gno models path`

First-run fallback behavior (MVP):
* If embeddings are not available yet (no vectors present and/or embed model missing):
  * `gno vsearch` returns a structured error indicating vectors are unavailable and suggests `gno index` or `gno embed`
  * `gno query` and `gno ask` degrade gracefully to BM25-only retrieval by default and annotate this in `--explain` and JSON metadata
* If generation/rerank models are missing:
  * expansion/HyDE and reranking are skipped (with explainability), but retrieval still returns citations/snippets

### 11.4 Default model presets (config-driven)

Defaults must live in config presets, not in business logic.

Provide at least two presets (MVP):

* Preset A (multilingual, widely used):

  * Embedding: bge-m3 GGUF
  * Reranker: bge-reranker-v2-m3 (cross-encoder) GGUF where available
  * Generation: small Qwen Instruct GGUF for structured expansion/HyDE
* Preset B (Qwen family):

  * Embedding: Qwen3 embedding GGUF
  * Reranker: Qwen3 reranker GGUF
  * Generation: small Qwen3 Instruct GGUF

`gno doctor` must validate:

* model URIs resolvable
* models cached or downloadable
* embedding and rerank dimensions/config match expectations

Default preset rule (MVP):
* Preset A is the default unless the user explicitly selects another preset.
* Rationale: consistent multilingual behavior across DE/FR/IT/EN in a single default path.

---

## 12. Search modes and pipelines

### 12.1 Search commands

* `gno search`: BM25/FTS only (fast, deterministic)
* `gno vsearch`: vector only (semantic)
* `gno query`: hybrid (best quality)
* `gno ask`: human-default wrapper over `gno query` (citations-first; optional grounded short answer)

### 12.2 Structured query expansion (hybrid)

Expansion returns a structured object:

* lexical variants for BM25
* semantic variants for embedding queries
* optional HyDE synthetic snippet (only if valid)

Example shape:

```json
{
  "lexicalQueries": ["...", "..."],
  "vectorQueries": ["...", "..."],
  "hyde": "optional synthetic paragraph",
  "notes": "optional debug notes"
}
```

Rules:

* Expansion must be JSON-schema constrained to avoid malformed outputs.
* Expansion is skipped when BM25 is already strong (configurable threshold).

### 12.3 Parallel retrieval

Hybrid retrieval runs in parallel:

* BM25 over:

  * original query (weighted)
  * lexicalQueries variants
* Vector over:

  * original query
  * vectorQueries variants
  * HyDE if present

### 12.4 Fusion via RRF (+ top-rank bonus)

* Reciprocal Rank Fusion with parameter `k = 60` (configurable)
* Weight original query results higher than expansions
* Optional top-rank bonus to reward agreement across retrieval modes
* Candidate cap for reranking (example: top 50-100 chunks)

### 12.5 Reranking

* Cross-encoder reranker scores candidate chunks (0..1 normalized)
* Rerank inputs include:

  * query
  * chunk text
  * optional title and applicable contexts (configurable)

### 12.6 Position-aware blending

Goal: avoid destabilizing top results due to reranker noise.

Example blending schedule (configurable):

* ranks 1-3: 0.75 retrieval score, 0.25 rerank score
* ranks 4-10: 0.60 retrieval score, 0.40 rerank score
* ranks 11+: 0.40 retrieval score, 0.60 rerank score

### 12.7 Explainability

`gno query --explain` prints to stderr:

* whether expansion was used
* expansion payload (redacted if needed)
* BM25 and vector contribution summary
* fusion and reranking parameters
* final score components per top result

---

## 13. Retrieval

### 13.1 `get`

Retrieves a single document mirror by:

* `gno://...`
* `collection/path`
* `#docid`
* fuzzy filename match (optional, must be deterministic and explainable)

Supports:

* `:line` suffix: `gno get gno://work/contracts/nda.docx:120`
* `--from <line>`
* `-l <maxLines>`
* `--line-numbers`
* `--source` (include abs source metadata in output; does not change mirror content)

Default:

* returns Markdown mirror plus metadata (CLI format)
* in JSON format returns structured object with mirror and source refs

### 13.2 `multi-get`

Retrieves multiple documents by:

* glob pattern
* comma-separated list of refs
* list of docids

Supports:

* `--max-bytes <n>` default 10240 for safety
* `--line-numbers`
* structured “skipped” records when limits exceeded

---

## 14. CLI specification

### 14.1 Global conventions

Exit codes:

* 0 success
* 1 validation / usage error
* 2 runtime failure (IO, DB, conversion, model, etc.)

Global flags:

* `--index <name>` use alternate DB name (multiple indices per machine)
* `--config <path>` override config path
* `--no-color`
* `--verbose`
* `--yes` non-interactive mode: accept safe defaults, never prompt (required for CI and scripted onboarding)

Output format flags (where applicable):

* `--json`
* `--files` (line protocol)
* `--csv`
* `--md`
* `--xml`

### 14.2 Command catalog (MVP)

* `gno status`
* `gno init [<path>] [--name <name>] [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>] [--yes]`
* `gno collection add <path> --name <name> [--pattern <glob>] [--include <csv-ext>] [--exclude <csv>] [--update <cmd>]`
* `gno collection list`
* `gno collection remove <name>`
* `gno collection rename <old> <new>`
* `gno update [--git-pull]`
* `gno index [--collection <name>] [--no-embed] [--models-pull] [--git-pull] [--yes]`
* `gno embed [--force] [--model <embedModelUri>] [--batch-size <n>]`
* `gno search <query> [options]`
* `gno vsearch <query> [options]`
* `gno query <query> [options]`
* `gno ask <query> [options]`
* `gno get <ref> [options]`
* `gno multi-get <pattern-or-list> [options]`
* `gno ls [collection|gno://collection/prefix]`
* `gno context add <path|gno://...|/> "text"`
* `gno context list`
* `gno context check`
* `gno context rm <path|gno://...|/>`
* `gno models list|pull|clear|path`
* `gno cleanup`
* `gno doctor`
* `gno mcp`

### 14.3 Search options (search, vsearch, query)

* `-n <num>` limit (default 5; default 20 for `--json`/`--files`)
* `--min-score <num>`
* `-c, --collection <name>`
* `--full` include full mirror (instead of snippet)
* `--line-numbers`
* `--lang <bcp47>` optional filter or hint:
  * for `search`: best-effort filter by chunk language where available
  * for `vsearch`/`query`/`ask`: hint for language detection and prompt selection
  * default: auto
* hybrid-only:

  * `--no-expand`
  * `--no-rerank`
  * `--explain`

### 14.4 Ask options (MVP)

`gno ask` is a wrapper over `gno query` with citations-first output.

Additional options:
* `--answer` enable a short grounded answer (requires generation model)
* `--no-answer` force retrieval-only output (citations/snippets only)
* `--max-answer-tokens <n>` hard cap for answer generation (default small, config-driven)

---

## 15. Output contracts (schema-driven)

### 15.1 Search result JSON shape

All search-like commands output:

```json
{
  "docid": "#a1b2c3",
  "score": 0.78,
  "uri": "gno://work/contracts/nda.docx",
  "title": "Extracted Title",
  "snippetLanguage": "de",
  "context": "Optional folder context",
  "snippet": "Markdown snippet (mirror)",
  "snippetRange": { "startLine": 120, "endLine": 145 },
  "source": {
    "absPath": "/abs/path/to/source.docx",
    "relPath": "contracts/nda.docx",
    "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ext": ".docx",
    "modifiedAt": "2025-11-12T10:30:00Z",
    "sizeBytes": 123456,
    "sourceHash": "sha256-hex"
  },
  "conversion": {
    "converterId": "adapter/markitdown-ts",
    "converterVersion": "x.y.z",
    "mirrorHash": "sha256-hex",
    "warnings": []
  }
}
```

Contract rules:

* `uri` always refers to the source identity.
* `snippet` comes from mirror content.
* `snippetLanguage` is the best-effort language tag for the snippet range (BCP-47 or `und`).
* `source.absPath` is included when:

  * `--source` is set, or
  * output is from MCP tools (always include to support agent actions).

### 15.2 `--files` line protocol

One line per result:

`#docid,<score>,gno://collection/path`

Optional extra fields may be appended only in a versioned manner.

### 15.3 Schema artifacts

Repo must include JSON schemas for:

* search result item
* status payload
* get payload
* multi-get payload
* MCP tool structured outputs
* ask payload

### 15.4 `ask` JSON shape (MVP)

`gno ask --json` returns:

```json
{
  "query": "string",
  "mode": "hybrid",
  "queryLanguage": "auto",
  "answer": "optional string",
  "citations": [
    { "docid": "#a1b2c3", "uri": "gno://work/path", "startLine": 120, "endLine": 145 }
  ],
  "results": [],
  "meta": {
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true
  }
}
```

Rules:
* `results[]` items are identical to `gno query --json` result item shape.
* `answer` must be grounded in `results` and cite line ranges via `citations`.
* If generation is unavailable or disabled, omit `answer` (do not emit an empty string).
* If vectors are unavailable, set `mode` to `bm25_only` and set `meta.vectorsUsed=false`.

---

## 16. MCP specification

### 16.1 Server

* Command: `gno mcp`
* Transport: stdio
* Must keep DB open for server lifetime for performance

### 16.2 Resources

* `gno://{collection}/{path}`

  * returns `text/markdown` mirror content
  * may optionally prepend a display-only comment header with:

    * uri
    * source abs path
    * mime
    * docid
    * language metadata when available (document hint and/or chunk language for returned ranges)
  * line numbers default ON for agent friendliness

### 16.3 Tools (stable namespace)

Tool names are stable and versioned under `gno.*`:

* `gno_search` (BM25)
* `gno_vsearch` (vector)
* `gno_query` (hybrid)
* `gno_get`
* `gno_multi_get`
* `gno_status`

Each tool returns:

* `content[]`: human-readable summary strings
* `structuredContent`: machine-readable payloads matching schemas
* `isError: true` on failures (for example vector index missing)

Multilingual MCP requirement (MVP):
* Tool structured outputs include `snippetLanguage` where applicable (mirrors CLI schema).

### 16.4 MCP correctness requirements

* Strictly follow MCP tool response conventions
* Ensure `gno://` URIs are URL-encoded for special characters while preserving path slashes
* Maintain backward compatibility of tool schemas once published (version fields required)

---

## 17. Architecture

### 17.1 High-level design

* Ports and Adapters (hexagonal)
* Functional core / imperative shell
* Result-based error handling (no throws across boundaries)

Core domain responsibilities:

* document identity and source refs
* mirror content and hashing
* chunking
* retrieval orchestration and scoring

Ports:

* `ConverterPort`
* `StorePort`
* `EmbeddingPort`
* `GenerationPort` (for expansion/HyDE)
* `RerankPort`
* `FsPort`, `ClockPort` (testability)
* `MimeDetectorPort`
* `FileWalkerPort`

Adapters:

* SQLite store + migrations
* FTS5 adapter
* sqlite-vec adapter
* node-llama-cpp adapter
* markitdown-ts adapter
* CLI delivery
* MCP delivery

### 17.2 Proposed module layout

(Reference layout, not a constraint, but should remain layered.)

```
src/
  app/
  config/
  domain/
  converters/
    adapters/markitdownJs/
  llm/
    nodeLlamaCpp/
  store/
    migrations/
    sqlite/
  indexing/
  pipeline/
  cli/
  mcp/
test/
  fixtures/
  spec/
  eval/
spec/
  cli.md
  mcp.md
  db/schema.sql
  converters.md
  models.md
  evals.md
  output-schemas/
```

---

## 18. Engineering quality requirements

### 18.1 Tests

Unit tests:

* path normalization
* MIME detection
* canonical Markdown normalization
* chunking boundaries
* RRF and blending math
* query expansion schema validation
* language detector determinism and tagging rules

Integration tests:

* create temp index DB, run migrations
* `gno update` over fixture corpus
* `gno search/vsearch/query/get/multi-get` outputs match schemas
* converter golden fixtures
* MCP server tool contract tests (golden calls)
* multilingual fixture corpus:
  * at least one DE and one EN document
  * confirm `snippetLanguage` tagging is stable and surfaced in CLI and MCP outputs

### 18.2 Evals (Evalite v1)

Scope:

* ranking quality gates for `vsearch` and `query`
* stability checks for structured expansion outputs
* multilingual ranking sanity checks (DE/FR/IT/EN mixed corpus)

#### 18.2.1 Evalite Setup

File structure:

```
test/
  eval/
    vsearch.eval.ts       # vector search ranking evals
    query.eval.ts         # hybrid query pipeline evals
    expansion.eval.ts     # structured expansion stability
    multilingual.eval.ts  # cross-language ranking
    fixtures/
      corpus/             # DE/EN/FR/IT test documents
      queries.json        # query-judgment pairs
evalite.config.ts         # global eval configuration
```

Configuration (`evalite.config.ts`):

```ts
import { defineConfig } from "evalite/config";
import { createSqliteStorage } from "evalite/sqlite-storage";

export default defineConfig({
  storage: () => createSqliteStorage("./evalite.db"),
  testTimeout: 120000,    // 2 min for slow LLM calls
  maxConcurrency: 10,     // parallel test cases
  scoreThreshold: 70,     // MVP: 70%, tighten over time
  cache: true,            // cache LLM responses in dev
});
```

#### 18.2.2 Custom Scorers (IR Metrics)

Create reusable scorers for retrieval metrics (not built into Evalite):

```ts
// test/eval/scorers/ir-metrics.ts
import { createScorer } from "evalite";

export const recallAtK = (k: number) => createScorer<
  { query: string },
  string[],    // output: docids
  string[]     // expected: relevant docids
>({
  name: `Recall@${k}`,
  description: `Fraction of relevant docs in top ${k} results`,
  scorer: ({ output, expected }) => {
    const topK = output.slice(0, k);
    const hits = expected.filter(id => topK.includes(id)).length;
    return {
      score: expected.length > 0 ? hits / expected.length : 1,
      metadata: { k, hits, total: expected.length },
    };
  },
});

export const ndcgAtK = (k: number) => createScorer<
  { query: string },
  string[],
  { docid: string; relevance: number }[]
>({
  name: `nDCG@${k}`,
  description: `Normalized DCG at rank ${k}`,
  scorer: ({ output, expected }) => {
    const relevanceMap = new Map(expected.map(e => [e.docid, e.relevance]));
    const dcg = output.slice(0, k).reduce((sum, docid, i) => {
      const rel = relevanceMap.get(docid) ?? 0;
      return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);
    const ideal = [...expected]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, k)
      .reduce((sum, e, i) => sum + (Math.pow(2, e.relevance) - 1) / Math.log2(i + 2), 0);
    return {
      score: ideal > 0 ? dcg / ideal : 1,
      metadata: { k, dcg, idcg: ideal },
    };
  },
});
```

#### 18.2.3 Example Eval File

```ts
// test/eval/vsearch.eval.ts
import { evalite } from "evalite";
import { recallAtK, ndcgAtK } from "./scorers/ir-metrics";
import { vsearch } from "../../src/pipeline/vsearch";

evalite("Vector Search Ranking", {
  data: async () => {
    const queries = await Bun.file("test/eval/fixtures/queries.json").json();
    return queries.map((q) => ({
      input: { query: q.query, collection: q.collection },
      expected: q.relevantDocs,
    }));
  },
  task: async (input) => {
    const results = await vsearch(input.query, { collection: input.collection, limit: 10 });
    return results.map(r => r.docid);
  },
  scorers: [
    { scorer: (args) => recallAtK(5).scorer(args) },
    { scorer: (args) => recallAtK(10).scorer(args) },
    { scorer: (args) => ndcgAtK(10).scorer(args) },
  ],
  trialCount: 1,  // deterministic for same embeddings
});
```

#### 18.2.4 Metrics

* recall@k (k=5,10) via custom scorer
* nDCG@k via custom scorer
* latency budgets (soft gate initially, tracked via custom column)

#### 18.2.5 Rules

* golden tests must not depend on exact expanded queries
* eval thresholds must tolerate minor model drift while catching major regressions
* use `trialCount > 1` for non-deterministic tasks (e.g., LLM expansion) to measure variance
* cache LLM responses in dev (`cache: true`) for fast iteration

#### 18.2.6 CLI Usage

```bash
# Dev: watch mode with UI at localhost:3006
bun run evalite watch

# CI: run once, fail if threshold not met
bun run evalite --threshold=70 --outputPath=./eval-results.json

# Export static UI for CI artifacts
bun run evalite export --output=./eval-ui
```

#### 18.2.7 Multilingual Eval Notes (MVP)

* include language-mismatched queries (e.g., DE query over EN doc) to validate vector + rerank behavior
* do not gate on exact expansion text, only on ranking metrics and schema validity
* use `columns` to show `snippetLanguage` for debugging cross-language behavior

See `spec/evals.md` for detailed implementation specification.

---

## 19. Packaging and distribution

Target: **npm registry, Bun-only**

```bash
# Requires Bun runtime
curl -fsSL https://bun.sh/install | bash

# Then run
bunx @gmickel/gno
# Or install globally
bun add -g @gmickel/gno
```

Note: `npm install` / `yarn` / `pnpm` will download the package but execution requires Bun runtime (code uses `bun:sqlite`, bin is `.ts`).

Prebuilt standalone binaries not viable due to native deps (sqlite-vec needs sidecar, node-llama-cpp can't bundle). See `notes/spike-bun-compile.md`.

First-run UX:

* `gno init` guides initial setup and prints what was created and where it lives.
* `gno doctor` guides:

  * converter readiness
  * sqlite-vec availability
  * model resolution and downloads
  * embedding backlog

---

## 20. Risks and mitigations

1. Native dependency friction (sqlite-vec, node-llama-cpp)
   Mitigation: `doctor`, clear error messages, platform matrix CI, documented rebuild guidance.

2. Converter output drift across library versions
   Mitigation: lock converter versions, store converter version per doc, golden fixtures updated deliberately.

3. Reranking latency on CPU
   Mitigation: cap candidates, cache rerank results, position-aware blending.

4. Multilingual lexical search limitations
   Mitigation:
   * default `unicode61` tokenizer for multilingual safety
   * opt-in stemming only where appropriate (`porter` for English)
   * rely on vector + rerank for cross-language and morphology-heavy cases
   * store per-chunk language tags to improve explainability and prompt selection

---

## 21. Spec-driven development workflow

Rule: No implementation merges without spec updates and executable contract tests.

Repo must include:

* `spec/cli.md` ✓
* `spec/mcp.md` ✓
* `spec/db/schema.sql` (placeholder exists)
* `spec/converters.md`
* `spec/models.md`
* `spec/evals.md` (Evalite v1 implementation spec)
* `spec/output-schemas/*.json` ✓

Contract tests: `test/spec/schemas/` (94 tests via Ajv)

Definition of done (per epic):

* specs updated and reviewed
* contract tests and golden fixtures added/updated
* unit and integration tests pass
* eval gates pass where applicable
* CLI help updated

---

## 22. Implementation plan (ordered epics and tasks)

### EPIC 0 - Repo scaffold and naming constants

* T0.1 Bun + TS ESM scaffold, lint/typecheck, test runner baseline
* T0.2 Central constants module for CLI name, URI scheme, dirs, MCP namespace
* T0.3 CI pipeline: typecheck + tests

Acceptance:

* `bun test` passes
* renaming GNO elements is a single-module change

---

### EPIC 1 - Specs and contract tests (freeze interfaces early)

* T1.1 Write `spec/cli.md` (commands, flags, exit codes, output formats)
* T1.2 Write `spec/mcp.md` (tools/resources, schemas, versioning rules)
* T1.3 Write `spec/output-schemas/*.json`
* T1.4 Add contract tests validating JSON outputs against schemas

Acceptance:

* schema contract tests exist before feature implementation expands

---

### EPIC 2 - Config, collections, contexts

* T2.1 Config schema + loader/saver (YAML), XDG defaults, overrides
* T2.2 `collection add/list/remove/rename`
* T2.3 `context add/list/check/rm` including global (`/`) and prefix contexts
* T2.4 `init` command (idempotent):
  * create config + DB if missing
  * optionally add a collection (same flags as `collection add`)
  * support `--yes`
* T2.5 Multilingual config:
  * collection-level `languageHint` parsing and validation
  * index-level `ftsTokenizer` parsing and validation (per index DB)

Acceptance:

* deterministic config edits, validated by unit tests

---

### EPIC 3 - Store layer (SQLite + migrations)

* T3.1 Implement migrations runner
* T3.2 Implement core tables and queries (collections, contexts, documents, content, chunks, errors)
* T3.3 Status/health queries

Acceptance:

* integration tests migrate and run CRUD correctly

---

### EPIC 4 - Converter subsystem (Node-only)

* T4.1 MIME detector + tests
* T4.2 Canonical Markdown normalizer + tests
* T4.3 Converter interfaces, registry, error mapping + tests
* T4.4 Native markdown/plaintext converters
* T4.5 markitdown-ts adapter + golden fixtures for pdf/docx/xlsx
* T4.5b officeparser adapter + golden fixtures for pptx

Acceptance:

* conversion fixtures match expected markdown exactly
* no Python dependency

---

### EPIC 5 - Indexing sync (`gno update`) and FTS

* T5.1 File walker + include/exclude logic + deterministic path normalization
* T5.2 Sync algorithm: hash, convert, upsert, soft-delete missing
* T5.3 Chunking (deterministic, tokenizer-aware when available)
* T5.4 FTS5 indexing over chunks + snippet extraction (with optional line ranges)
* T5.5 `gno status` and `gno cleanup`
* T5.6 `index` command wrapper:
  * runs `update` then `embed` (unless `--no-embed`)
  * supports `--collection` scoping
  * supports `--models-pull` (model resolution/download; prompted unless `--yes`)
  * supports `--git-pull` (best-effort git pull in git repos)
  * supports `--yes`
* T5.7 Language tagging:
  * persist document `language_hint`
  * deterministic per-chunk language detection and storage
  * surface `snippetLanguage` in CLI and MCP outputs

Acceptance:

* `gno update` on fixture corpus yields correct docs/chunks/fts
* conversion errors recorded but do not block overall update

---

### EPIC 6 - LLM subsystem (node-llama-cpp) and model UX

* T6.1 LLM adapter lifecycle management
* T6.2 Model presets and config overrides
* T6.3 Model cache resolver (hf: URIs) and `gno models` commands
* T6.4 `gno doctor` checks for models, vec availability, conversion readiness

Acceptance:

* local models resolvable and cached
* doctor produces actionable diagnostics

---

### EPIC 7 - Vector index and embeddings workflow (`gno embed`)

* T7.1 sqlite-vec integration (optional deps handled cleanly)
* T7.2 Embedding backlog detection
* T7.3 Batch embed chunks and store vectors per model
* T7.4 `--force` re-embed support

Acceptance:

* vectors populated and status shows backlog decreasing to zero

---

### EPIC 8 - Search pipelines

* T8.1 `gno search` (FTS)
* T8.2 `gno vsearch` (vector)
* T8.3 `gno query` hybrid:

  * strong BM25 skip expansion
  * structured expansion with schema constraint
  * parallel retrieval
  * RRF fusion + top-rank bonus
    * rerank + blended scoring
    * `--explain`
* T8.4 `ask` command:
  * wrapper over `query` with citations-first output
  * optional grounded short answer when generation is configured (gated by `--answer`)
* T8.5 Multilingual awareness:
  * deterministic query language detection (heuristics)
  * language-aware prompt template selection for expansion and rerank
  * cache keys include language tags and template versions

Acceptance:

* deterministic golden tests for `search`
* evalite gates for hybrid behavior and ranking

---

### EPIC 9 - Retrieval and output polish

* T9.1 Output formatters: cli/json/files/csv/md/xml
* T9.2 `get` and `multi-get` including limits and skipped records
* T9.3 `ls` (collections and per-prefix listing)

Acceptance:

* output schemas enforced by tests across formats where applicable

---

### EPIC 10 - MCP server (stdio)

* T10.1 MCP server skeleton
* T10.2 Implement tools: `gno_search`, `gno_vsearch`, `gno_query`, `gno_get`, `gno_multi_get`, `gno_status`
* T10.3 Implement resource reads for `gno://...`
* T10.4 MCP contract tests (golden tool calls)

Acceptance:

* MCP inspector can call tools and read resources consistently

---

### EPIC 11 - Evals and regression gates (Evalite v1)

* T11.1 Curate corpus, queries, judgments
* T11.2 Implement eval harness and metrics
* T11.3 CI gating (soft fail then hard fail after baseline)

Acceptance:

* evals run locally and in CI with documented thresholds

---

### EPIC 12 - Packaging, release, docs

* T12.1 npm packaging and install docs
* T12.1a Quickstart docs:
  * `gno init` -> `gno index` -> `gno ask`
  * include OS-specific paths and what gets created where
  * include multilingual note: default preset is multilingual; language tagging is best effort
* T12.2 release automation, versioning, changelog
* T12.3 troubleshooting: native deps, caches, model downloads

Acceptance:

* clean install path; `gno doctor` makes first-run successful

---

## 23. MVP acceptance criteria

1. User can index:

   * a Markdown folder
   * a folder containing at least PDF and DOCX (and ideally PPTX/XLSX)
2. `gno search`, `gno vsearch`, `gno query` return results with:

   * docid
   * `gno://` URI
   * source path + MIME (in structured output; always for MCP)
   * snippet and optional line range
3. `gno get` returns mirror markdown and can include source metadata.
4. `gno mcp` exposes tools with stable schemas and supports `gno://` reads.
5. Test suite includes:

   * converter golden fixtures
   * CLI integration tests on a fixture corpus
   * evalite harness for ranking quality and expansion stability
6. No Python dependency anywhere.

7. First-run success:
   * a new user can run `gno init` -> `gno index` -> `gno ask` and get usable results without editing config files manually

8. Multilingual behavior:
   * per-chunk language tags are stored deterministically and surfaced in CLI and MCP outputs (`snippetLanguage`)
   * default model preset supports DE/FR/IT/EN, and hybrid retrieval remains usable without manual tuning

---

## 24. Future extensions (explicitly supported by architecture)

* Watch mode: `gno watch` incremental updates (non-MVP)
* Cross-device sync protocol (content-addressed manifests)
* Rich metadata extraction (authors, dates, slide titles, sheet names)
* OS integration: `gno open` / reveal (non-MVP)
* Additional native converters (pdf.js, mammoth, pptx parsing, SheetJS)

---
