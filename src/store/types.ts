/**
 * Store layer types and interfaces.
 * Defines StorePort (port interface) and all data types for persistence.
 *
 * @module src/store/types
 */

import type { Collection, Context, FtsTokenizer } from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

/** Store error codes */
export type StoreErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONSTRAINT_VIOLATION'
  | 'MIGRATION_FAILED'
  | 'CONNECTION_FAILED'
  | 'QUERY_FAILED'
  | 'TRANSACTION_FAILED'
  | 'INVALID_INPUT'
  | 'IO_ERROR'
  | 'INTERNAL'
  // Vector-specific error codes (EPIC 7)
  | 'VECTOR_WRITE_FAILED'
  | 'VECTOR_DELETE_FAILED'
  | 'VEC_SEARCH_UNAVAILABLE'
  | 'VEC_SEARCH_FAILED'
  | 'VEC_REBUILD_FAILED'
  | 'VEC_SYNC_FAILED';

/** Store error with structured details */
export interface StoreError {
  code: StoreErrorCode;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** Result type for store operations */
export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StoreError };

/** Create a success result */
export function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

/** Create an error result */
export function err<T>(
  code: StoreErrorCode,
  message: string,
  cause?: unknown
): StoreResult<T> {
  return { ok: false, error: { code, message, cause } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Types (DB representations)
// ─────────────────────────────────────────────────────────────────────────────

/** Collection row from DB (mirrors config) */
export interface CollectionRow {
  name: string;
  path: string;
  pattern: string;
  include: string[] | null;
  exclude: string[] | null;
  updateCmd: string | null;
  languageHint: string | null;
  syncedAt: string;
}

/** Context row from DB (mirrors config) */
export interface ContextRow {
  scopeType: 'global' | 'collection' | 'prefix';
  scopeKey: string;
  text: string;
  syncedAt: string;
}

/** Document row from DB */
export interface DocumentRow {
  id: number;
  collection: string;
  relPath: string;

  // Source metadata
  sourceHash: string;
  sourceMime: string;
  sourceExt: string;
  sourceSize: number;
  sourceMtime: string;

  // Derived identifiers
  docid: string;
  uri: string;

  // Conversion output
  title: string | null;
  mirrorHash: string | null;
  converterId: string | null;
  converterVersion: string | null;
  languageHint: string | null;

  // Status
  active: boolean;

  // Error tracking
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

/** Chunk row from DB */
export interface ChunkRow {
  mirrorHash: string;
  seq: number;
  pos: number;
  text: string;
  startLine: number;
  endLine: number;
  language: string | null;
  tokenCount: number | null;
  createdAt: string;
}

/** Ingest error row from DB */
export interface IngestErrorRow {
  id: number;
  collection: string;
  relPath: string;
  occurredAt: string;
  code: string;
  message: string;
  detailsJson: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Types (for upsert operations)
// ─────────────────────────────────────────────────────────────────────────────

/** Input for upserting a document */
export interface DocumentInput {
  collection: string;
  relPath: string;
  sourceHash: string;
  sourceMime: string;
  sourceExt: string;
  sourceSize: number;
  sourceMtime: string;
  title?: string;
  mirrorHash?: string;
  converterId?: string;
  converterVersion?: string;
  languageHint?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

/** Input for a single chunk */
export interface ChunkInput {
  seq: number;
  pos: number;
  text: string;
  startLine: number;
  endLine: number;
  language?: string;
  tokenCount?: number;
}

/** Input for recording an ingest error */
export interface IngestErrorInput {
  collection: string;
  relPath: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for FTS search */
export interface FtsSearchOptions {
  /** Max results to return */
  limit?: number;
  /** Filter by collection */
  collection?: string;
  /** Filter by language */
  language?: string;
  /** Include snippet with highlights */
  snippet?: boolean;
}

/** Single FTS search result */
export interface FtsResult {
  mirrorHash: string;
  seq: number;
  score: number;
  snippet?: string;
  // Joined from documents table
  docid?: string;
  uri?: string;
  title?: string;
  collection?: string;
  relPath?: string;
  // Source metadata (optional for backward compat)
  sourceMime?: string;
  sourceExt?: string;
  sourceMtime?: string;
  sourceSize?: number;
  sourceHash?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-collection status */
export interface CollectionStatus {
  name: string;
  path: string;
  totalDocuments: number;
  activeDocuments: number;
  errorDocuments: number;
  chunkedDocuments: number;
  /** Total chunks for this collection */
  totalChunks: number;
  /** Chunks with embeddings (EPIC 7) */
  embeddedChunks: number;
}

/** Index-level status */
export interface IndexStatus {
  /** Config version string */
  version: string;
  /** Index name (from dbPath) */
  indexName: string;
  /** Full path to config file */
  configPath: string;
  /** Full path to database file */
  dbPath: string;
  /** FTS tokenizer in use */
  ftsTokenizer: FtsTokenizer;
  /** Per-collection status */
  collections: CollectionStatus[];
  /** Total documents across all collections */
  totalDocuments: number;
  /** Active (non-deleted) documents */
  activeDocuments: number;
  /** Total chunks across all collections */
  totalChunks: number;
  /** Chunks without embeddings */
  embeddingBacklog: number;
  /** Recent ingest errors (last 24h) */
  recentErrors: number;
  /** Last successful update timestamp (ISO 8601) */
  lastUpdatedAt: string | null;
  /** Overall health status */
  healthy: boolean;
}

/** Cleanup operation stats */
export interface CleanupStats {
  orphanedContent: number;
  orphanedChunks: number;
  orphanedVectors: number;
  expiredCache: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Types
// ─────────────────────────────────────────────────────────────────────────────

/** Migration result */
export interface MigrationResult {
  applied: number[];
  currentVersion: number;
  ftsTokenizer: FtsTokenizer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional transaction wrapper capability.
 * Store implementations that support batching multiple writes into a single
 * durable commit should implement this.
 */
export type WithTransaction = <T>(
  fn: () => Promise<T>
) => Promise<StoreResult<T>>;

// ─────────────────────────────────────────────────────────────────────────────
// StorePort Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StorePort - Port interface for data persistence.
 * Implementations: SQLite adapter (src/store/sqlite/adapter.ts)
 */
export interface StorePort {
  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Open database connection and run migrations.
   * Creates DB file if it doesn't exist.
   */
  open(
    dbPath: string,
    ftsTokenizer: FtsTokenizer
  ): Promise<StoreResult<MigrationResult>>;

  /**
   * Close database connection and cleanup resources.
   */
  close(): Promise<void>;

  /**
   * Check if database is open.
   */
  isOpen(): boolean;

  /**
   * Run an async function within a single transaction.
   * Optional - implementations without transactional support can omit this.
   * Used by SyncService to batch document writes for better Windows performance.
   */
  withTransaction?: WithTransaction;

  // ─────────────────────────────────────────────────────────────────────────
  // Config Sync (YAML -> DB)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sync collections from config to DB.
   * Adds new, updates existing, removes deleted.
   */
  syncCollections(collections: Collection[]): Promise<StoreResult<void>>;

  /**
   * Sync contexts from config to DB.
   * Adds new, updates existing, removes deleted.
   */
  syncContexts(contexts: Context[]): Promise<StoreResult<void>>;

  /**
   * Get all collections from DB.
   */
  getCollections(): Promise<StoreResult<CollectionRow[]>>;

  /**
   * Get all contexts from DB.
   */
  getContexts(): Promise<StoreResult<ContextRow[]>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Documents
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upsert a document. Returns docid.
   * Creates new or updates existing by (collection, relPath).
   */
  upsertDocument(doc: DocumentInput): Promise<StoreResult<string>>;

  /**
   * Get document by collection and relative path.
   */
  getDocument(
    collection: string,
    relPath: string
  ): Promise<StoreResult<DocumentRow | null>>;

  /**
   * Get document by docid (#hex).
   */
  getDocumentByDocid(docid: string): Promise<StoreResult<DocumentRow | null>>;

  /**
   * Get document by URI (gno://collection/path).
   */
  getDocumentByUri(uri: string): Promise<StoreResult<DocumentRow | null>>;

  /**
   * List all documents, optionally filtered by collection.
   */
  listDocuments(collection?: string): Promise<StoreResult<DocumentRow[]>>;

  /**
   * Mark documents as inactive (soft delete).
   * Returns count of affected documents.
   */
  markInactive(
    collection: string,
    relPaths: string[]
  ): Promise<StoreResult<number>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Content (content-addressed)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Store markdown content by mirror hash.
   * Idempotent - no-op if hash exists.
   */
  upsertContent(
    mirrorHash: string,
    markdown: string
  ): Promise<StoreResult<void>>;

  /**
   * Get markdown content by mirror hash.
   */
  getContent(mirrorHash: string): Promise<StoreResult<string | null>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Chunks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Store chunks for a mirror hash.
   * Replaces existing chunks for this hash.
   */
  upsertChunks(
    mirrorHash: string,
    chunks: ChunkInput[]
  ): Promise<StoreResult<void>>;

  /**
   * Get all chunks for a mirror hash.
   */
  getChunks(mirrorHash: string): Promise<StoreResult<ChunkRow[]>>;

  /**
   * Batch fetch chunks for multiple mirror hashes.
   * Returns Map where each ChunkRow[] is sorted by seq ascending.
   * Missing hashes are not present in the returned Map.
   * Note: Map is not JSON-serializable; internal pipeline optimization only.
   */
  getChunksBatch(
    mirrorHashes: string[]
  ): Promise<StoreResult<Map<string, ChunkRow[]>>>;

  // ─────────────────────────────────────────────────────────────────────────
  // FTS Search
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Search chunks using FTS5.
   */
  searchFts(
    query: string,
    options?: FtsSearchOptions
  ): Promise<StoreResult<FtsResult[]>>;

  /**
   * Rebuild FTS index for a mirror hash.
   * Called after upserting chunks.
   */
  rebuildFtsForHash(mirrorHash: string): Promise<StoreResult<void>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Status
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get index status with counts and health info.
   */
  getStatus(): Promise<StoreResult<IndexStatus>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Errors
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record an ingest error.
   */
  recordError(error: IngestErrorInput): Promise<StoreResult<void>>;

  /**
   * Get recent ingest errors.
   */
  getRecentErrors(limit?: number): Promise<StoreResult<IngestErrorRow[]>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Remove orphaned content, chunks, vectors, and expired cache.
   */
  cleanupOrphans(): Promise<StoreResult<CleanupStats>>;
}
