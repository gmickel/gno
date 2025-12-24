/**
 * Ingestion subsystem types.
 * Defines Walker, Chunker, and Sync interfaces.
 *
 * @module src/ingestion/types
 */

import type { Collection } from '../config/types';

// ─────────────────────────────────────────────────────────────────────────────
// Walker Types
// ─────────────────────────────────────────────────────────────────────────────

/** File entry from walker */
export type WalkEntry = {
  /** Absolute path to file */
  absPath: string;
  /** Relative path within collection (POSIX forward slashes) */
  relPath: string;
  /** File size in bytes */
  size: number;
  /** Modification time (ISO 8601) */
  mtime: string;
};

/** Walker configuration */
export type WalkConfig = {
  /** Collection root path (absolute) */
  root: string;
  /** Glob pattern (default: **\/*) */
  pattern: string;
  /** Extension allowlist (empty = all) */
  include: string[];
  /** Paths/patterns to exclude */
  exclude: string[];
  /** Max file size in bytes (files larger are skipped) */
  maxBytes: number;
};

/** Skipped file entry (for error tracking) */
export type SkippedEntry = {
  absPath: string;
  relPath: string;
  reason: 'TOO_LARGE' | 'EXCLUDED';
  size?: number;
};

/** Walker port interface */
export type WalkerPort = {
  /**
   * Walk collection directory yielding file entries.
   * Filters by pattern, include, exclude.
   * Files > maxBytes are tracked in skipped array.
   */
  walk(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Chunker Types
// ─────────────────────────────────────────────────────────────────────────────

/** Chunk parameters */
export type ChunkParams = {
  /** Max tokens per chunk (default: 800) */
  maxTokens: number;
  /** Overlap percentage 0-1 (default: 0.15) */
  overlapPercent: number;
};

/** Default chunk params */
export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  maxTokens: 800,
  overlapPercent: 0.15,
};

/** Chunked output */
export type ChunkOutput = {
  /** Sequence number (0-indexed) */
  seq: number;
  /** Character position in source */
  pos: number;
  /** Chunk text */
  text: string;
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based) */
  endLine: number;
  /** Detected language (BCP-47 or null) */
  language: string | null;
  /** Token count estimate (null for char-based) */
  tokenCount: number | null;
};

/** Chunker port interface */
export type ChunkerPort = {
  /**
   * Chunk markdown content.
   * Returns deterministic chunks for (text, params).
   */
  chunk(
    markdown: string,
    params?: ChunkParams,
    documentLanguageHint?: string
  ): ChunkOutput[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Sync Types
// ─────────────────────────────────────────────────────────────────────────────

/** Sync options */
export type SyncOptions = {
  /** Run git pull before scanning */
  gitPull?: boolean;
  /** Run collection updateCmd before scanning */
  runUpdateCmd?: boolean;
  /** Conversion limits override */
  limits?: {
    maxBytes?: number;
    timeoutMs?: number;
    maxOutputChars?: number;
  };
  /**
   * Max concurrent file processing (default: 1).
   * Higher values improve throughput but increase memory pressure.
   * SQLite operations are serialized regardless of this setting.
   */
  concurrency?: number;
};

/** Per-file sync status */
export type FileSyncStatus =
  | 'added'
  | 'updated'
  | 'unchanged'
  | 'error'
  | 'skipped';

/** Per-file sync result */
export type FileSyncResult = {
  relPath: string;
  status: FileSyncStatus;
  docid?: string;
  mirrorHash?: string;
  errorCode?: string;
  errorMessage?: string;
};

/** Collection sync summary */
export type CollectionSyncResult = {
  collection: string;
  filesProcessed: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesErrored: number;
  filesSkipped: number;
  filesMarkedInactive: number;
  durationMs: number;
  errors: Array<{
    relPath: string;
    code: string;
    message: string;
  }>;
};

/** Full sync summary */
export type SyncResult = {
  collections: CollectionSyncResult[];
  totalDurationMs: number;
  totalFilesProcessed: number;
  totalFilesAdded: number;
  totalFilesUpdated: number;
  totalFilesErrored: number;
  totalFilesSkipped: number;
};

/** Decision for whether to process a file */
export type ProcessDecision =
  | { kind: 'skip'; reason: string }
  | { kind: 'process'; reason: string }
  | { kind: 'repair'; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Language Detection Types
// ─────────────────────────────────────────────────────────────────────────────

/** Language detector port */
export type LanguageDetectorPort = {
  /**
   * Detect language from text.
   * Returns BCP-47 code or null if undetermined.
   * Must be deterministic for same input.
   */
  detect(text: string): string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper to create WalkConfig from Collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create WalkConfig from Collection with maxBytes override.
 */
export function collectionToWalkConfig(
  collection: Collection,
  maxBytes: number
): WalkConfig {
  return {
    root: collection.path,
    pattern: collection.pattern,
    include: collection.include,
    exclude: collection.exclude,
    maxBytes,
  };
}
