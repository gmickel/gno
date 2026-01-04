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
  converter_id TEXT,
  converter_version TEXT,
  language_hint TEXT,               -- BCP-47 or NULL

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
  embedding BLOB NOT NULL,          -- Float32Array serialized
  embedded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mirror_hash, seq, model),
  FOREIGN KEY (mirror_hash, seq) REFERENCES content_chunks(mirror_hash, seq) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vectors_model ON content_vectors(model);

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
