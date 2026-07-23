-- GNO Database Schema v1
-- SQLite with FTS5
--
-- Tables:
--   schema_meta       - Migration tracking and index metadata
--   collections       - Cached collection config (synced from YAML)
--   contexts          - Cached context config (synced from YAML)
--   documents         - Source file identity and conversion metadata
--   content           - Content-addressed markdown mirrors
--   content_chunks    - Chunked content with line ranges
--   content_fts       - FTS5 virtual table over chunks
--   content_vectors   - Embeddings per chunk per model (EPIC 7)
--   llm_cache         - Cached LLM responses (EPIC 6+)
--   ingest_errors     - Conversion/indexing error records
--   doc_tags          - Document tags (frontmatter and user-added)
--   doc_links         - Wiki and markdown links between documents
--   doc_edges         - Derived semantic document relationships
--   activation_receipts - Bounded per-collection retrieval proof receipts
--   retrieval_traces - Opt-in private retrieval trace headers
--   retrieval_trace_runs/events/judgments - Bounded trace outcome records
--   retrieval_trace_exports/export_traces - Export manifests and trace joins

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema Metadata
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seeded by migration runner:
--   version = '1'
--   fts_tokenizer = 'unicode61' (from config)
--   created_at = datetime('now')

-- ─────────────────────────────────────────────────────────────────────────────
-- Collections (synced from YAML config)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS collections (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  pattern TEXT NOT NULL DEFAULT '**/*',
  include TEXT,              -- JSON array of extensions
  exclude TEXT,              -- JSON array of patterns
  update_cmd TEXT,
  language_hint TEXT,        -- BCP-47 or NULL
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Contexts (synced from YAML config)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contexts (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'collection', 'prefix')),
  scope_key TEXT NOT NULL,
  text TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_type, scope_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Documents (source file identity)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  rel_path TEXT NOT NULL,

  -- Source file metadata
  source_hash TEXT NOT NULL,        -- SHA-256 of source bytes
  source_mime TEXT NOT NULL,
  source_ext TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime TEXT NOT NULL,

  -- Derived identifiers
  docid TEXT NOT NULL,              -- #<8 hex> from source_hash
  uri TEXT NOT NULL,                -- gno://collection/rel_path

  -- Conversion output
  title TEXT,
  mirror_hash TEXT,                 -- FK to content.mirror_hash (NULL if failed)
  fts_mirror_hash TEXT,             -- supported writers maintain transactionally; migration 013 validates legacy bodies once
  converter_id TEXT,
  converter_version TEXT,
  language_hint TEXT,               -- BCP-47 or NULL
  content_type_source TEXT,         -- frontmatter | rules | default | extension | null

  -- Status
  active INTEGER NOT NULL DEFAULT 1,

  -- Error tracking (denormalized for quick status)
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_at TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (collection, rel_path),
  FOREIGN KEY (collection) REFERENCES collections(name) ON DELETE CASCADE
  -- Note: mirror_hash is NOT an FK - documents are tracked before content exists
  -- Cleanup via cleanupOrphans() handles orphaned content
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_documents_active ON documents(active);
CREATE INDEX IF NOT EXISTS idx_documents_mirror_hash ON documents(mirror_hash);
CREATE INDEX IF NOT EXISTS idx_documents_docid ON documents(docid);
CREATE INDEX IF NOT EXISTS idx_documents_uri ON documents(uri);

-- ─────────────────────────────────────────────────────────────────────────────
-- Content (content-addressed markdown mirrors)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS content (
  mirror_hash TEXT PRIMARY KEY,     -- SHA-256 of canonical markdown
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Content Chunks (for FTS and vectors)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS content_chunks (
  mirror_hash TEXT NOT NULL,
  seq INTEGER NOT NULL,             -- 0-indexed chunk sequence
  pos INTEGER NOT NULL,             -- Byte offset in markdown
  text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT,                    -- BCP-47 detected language
  token_count INTEGER,              -- Optional for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mirror_hash, seq),
  FOREIGN KEY (mirror_hash) REFERENCES content(mirror_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_mirror_hash ON content_chunks(mirror_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- FTS5 Virtual Table
-- ─────────────────────────────────────────────────────────────────────────────

-- Tokenizer is set from config (unicode61/porter/trigram)
-- External content mode for efficient updates
--
-- Note: FTS table created with dynamic tokenizer in migration runner:
--   CREATE VIRTUAL TABLE content_fts USING fts5(
--     text,
--     content='content_chunks',
--     content_rowid='rowid',
--     tokenize='unicode61'  -- or porter/trigram from config
--   );

-- Placeholder for reference (actual creation in migration):
-- CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
--   text,
--   tokenize='unicode61'
-- );

-- ─────────────────────────────────────────────────────────────────────────────
-- Content Vectors (embeddings - EPIC 7)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS content_vectors (
  mirror_hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  model TEXT NOT NULL,              -- Model identifier (e.g., 'bge-m3')
  embed_fingerprint TEXT NOT NULL DEFAULT '',
  embedding BLOB NOT NULL,          -- Float32Array serialized
  embedded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mirror_hash, seq, model),
  FOREIGN KEY (mirror_hash, seq) REFERENCES content_chunks(mirror_hash, seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vectors_model ON content_vectors(model);
CREATE INDEX IF NOT EXISTS idx_vectors_freshness
  ON content_vectors(model, embed_fingerprint, mirror_hash, seq, embedded_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- LLM Cache (EPIC 6+)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT                   -- NULL = never expires
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Ingest Errors
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingest_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  code TEXT NOT NULL,               -- Error code (UNSUPPORTED, TOO_LARGE, etc.)
  message TEXT NOT NULL,
  details_json TEXT                 -- Optional JSON details
);

CREATE INDEX IF NOT EXISTS idx_ingest_errors_occurred ON ingest_errors(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_collection ON ingest_errors(collection, rel_path);

-- ─────────────────────────────────────────────────────────────────────────────
-- Activation Receipts
-- ─────────────────────────────────────────────────────────────────────────────

-- Passive activation reads only document/FTS metadata and this owned-writer
-- marker; it never selects Markdown or FTS bodies. Direct post-migration
-- mutation of internal FTS bodies outside GNO is unsupported and may not alter
-- the metadata-only identity. Rebuild through the supported index writer.

CREATE TABLE IF NOT EXISTS activation_receipts (
  collection TEXT NOT NULL,
  connector_target TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (length(receipt_json) <= 16384),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection, connector_target),
  FOREIGN KEY (collection) REFERENCES collections(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activation_receipts_fingerprint
  ON activation_receipts(fingerprint);

-- ─────────────────────────────────────────────────────────────────────────────
-- Private Retrieval Trace Receipts
-- ─────────────────────────────────────────────────────────────────────────────

-- Recording is opt-in at the config/core layer. Metadata receipts keep no raw
-- query/goal/filter values; replay receipts require explicit consent.

CREATE TABLE IF NOT EXISTS retrieval_traces (
  trace_id TEXT PRIMARY KEY CHECK (length(trace_id) BETWEEN 1 AND 128),
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0'),
  redaction_mode TEXT NOT NULL CHECK (redaction_mode IN ('metadata', 'replay')),
  replay_capable INTEGER NOT NULL CHECK (replay_capable IN (0, 1)),
  query_text TEXT,
  query_digest TEXT,
  query_shape_json TEXT NOT NULL,
  goal_text TEXT,
  goal_digest TEXT,
  goal_shape_json TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  pipeline_fingerprint TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  index_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('open', 'completed', 'partial', 'failed', 'cancelled')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  creation_digest TEXT NOT NULL,
  CHECK (
    (redaction_mode = 'metadata' AND replay_capable = 0
      AND query_text IS NULL AND query_digest IS NULL
      AND goal_text IS NULL AND goal_digest IS NULL)
    OR
    (redaction_mode = 'replay' AND replay_capable = 1
      AND query_text IS NOT NULL AND query_digest IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_retention
  ON retrieval_traces(expires_at_ms, created_at_ms, trace_id);

CREATE TABLE IF NOT EXISTS retrieval_trace_runs (
  run_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('retrieval', 'context', 'get')),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL
    CHECK (payload_bytes = length(CAST(payload_json AS BLOB)))
    CHECK (payload_bytes <= 65536),
  canonical_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (trace_id, idempotency_key),
  UNIQUE (trace_id, run_id),
  FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retrieval_trace_events (
  event_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('query', 'retrieval', 'context', 'get', 'open', 'cite',
                    'pin', 'capability', 'complete')),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL
    CHECK (payload_bytes = length(CAST(payload_json AS BLOB)))
    CHECK (payload_bytes <= 65536),
  canonical_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (trace_id, idempotency_key),
  FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
  FOREIGN KEY (trace_id, run_id)
    REFERENCES retrieval_trace_runs(trace_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retrieval_trace_judgments (
  judgment_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  run_id TEXT,
  idempotency_key TEXT NOT NULL,
  label TEXT NOT NULL
    CHECK (label IN ('relevant', 'irrelevant', 'missing_expected')),
  target_kind TEXT NOT NULL
    CHECK (target_kind IN ('document', 'chunk', 'span', 'query')),
  target_ref TEXT NOT NULL,
  target_json TEXT NOT NULL,
  target_bytes INTEGER NOT NULL
    CHECK (target_bytes = length(CAST(target_json AS BLOB)))
    CHECK (target_bytes <= 16384),
  canonical_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (trace_id, idempotency_key),
  FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
  FOREIGN KEY (trace_id, run_id)
    REFERENCES retrieval_trace_runs(trace_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retrieval_trace_exports (
  export_id TEXT PRIMARY KEY,
  format TEXT NOT NULL CHECK (format IN ('agentic-receipt', 'qrels')),
  artifact_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (format, artifact_hash)
);

CREATE TABLE IF NOT EXISTS retrieval_trace_export_traces (
  export_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  PRIMARY KEY (export_id, trace_id),
  FOREIGN KEY (export_id) REFERENCES retrieval_trace_exports(export_id)
    ON DELETE CASCADE,
  FOREIGN KEY (trace_id) REFERENCES retrieval_traces(trace_id)
    ON DELETE CASCADE
);

-- Migration 014 also installs deterministic indexes, orphan-export cleanup,
-- and an absolute 100,000 subordinate-record safety cap per trace. Runtime
-- retention applies the lower configured maxRecordsPerTrace bound.

-- ─────────────────────────────────────────────────────────────────────────────
-- Document Tags
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS doc_tags (
  doc_id INTEGER NOT NULL,
  tag TEXT NOT NULL COLLATE NOCASE,   -- Tag name (lowercase alphanumeric, hyphens, dots, slashes)
  source TEXT NOT NULL DEFAULT 'frontmatter',  -- 'frontmatter' or 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (doc_id, tag),
  FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Tag grammar: lowercase, alphanumeric, hyphens, dots, slashes for hierarchy
-- Examples: javascript, project/web, status/draft, lang.en

CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags(tag);
CREATE INDEX IF NOT EXISTS idx_doc_tags_source ON doc_tags(source);

-- ─────────────────────────────────────────────────────────────────────────────
-- Document Links (wiki links and markdown links)
-- ─────────────────────────────────────────────────────────────────────────────

-- Links extracted from document content during sync.
-- Resolution is done at query time (no stored target_doc_id) to handle renames.
--
-- Link types:
--   wiki     - [[Target]], [[Target|Display]], [[Target#Heading]], [[collection:Target]]
--   markdown - [Display](path/to/doc.md) (relative/absolute within collection)
--
-- Note: External URLs (https://) are NOT stored.

CREATE TABLE IF NOT EXISTS doc_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_doc_id INTEGER NOT NULL,         -- Document containing the link
  link_type TEXT NOT NULL CHECK (link_type IN ('wiki', 'markdown')),
  target_ref TEXT NOT NULL,               -- Raw reference as written
  target_ref_norm TEXT NOT NULL,          -- Normalized for matching (wiki=NFC+lowercase, md=resolved path)
  target_anchor TEXT,                     -- #section if present
  target_collection TEXT,                 -- Explicit collection: prefix if used
  link_text TEXT,                         -- Display text if different from target
  start_line INTEGER NOT NULL,            -- 1-based line number
  start_col INTEGER NOT NULL,             -- 1-based column in line
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'parsed' CHECK (source IN ('parsed', 'user', 'suggested')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_doc_id, start_line, start_col, link_type),
  FOREIGN KEY (source_doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Index for finding all links from a document
CREATE INDEX IF NOT EXISTS idx_doc_links_source ON doc_links(source_doc_id);

-- Index for resolving links (backlinks query)
CREATE INDEX IF NOT EXISTS idx_doc_links_resolve ON doc_links(link_type, target_ref_norm, target_collection);

-- ─────────────────────────────────────────────────────────────────────────────
-- Document Edges (derived semantic relationships)
-- ─────────────────────────────────────────────────────────────────────────────

-- Derived from links/frontmatter/config. Stores resolved target ids for bounded
-- traversal; reads join active source and target documents to avoid stale edges
-- after soft-delete/inactivation.
CREATE TABLE IF NOT EXISTS doc_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_doc_id INTEGER NOT NULL,
  dst_doc_id INTEGER NOT NULL,
  edge_type TEXT NOT NULL,           -- free-form validated lowercase snake_case
  confidence TEXT NOT NULL CHECK (confidence IN ('parsed', 'configured', 'manual', 'inferred')),
  source TEXT NOT NULL CHECK (source IN ('wikilink', 'markdown-link', 'frontmatter-relation')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(src_doc_id, dst_doc_id, edge_type, source),
  FOREIGN KEY (src_doc_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_doc_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_doc_edges_src_type ON doc_edges(src_doc_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_doc_edges_dst_type ON doc_edges(dst_doc_id, edge_type);
