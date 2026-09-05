/**
 * Vector index types and interfaces.
 * Defines VectorIndexPort and VectorStatsPort for embedding storage/search.
 *
 * @module src/store/vector/types
 */

import type { DocumentEligibilityOptions, StoreResult } from "../types";

/** Full effective embedding identity, including truncation/runtime policy. */
export interface VectorVariantIdentity {
  model: string;
  modelFingerprint: string;
  contextSize: number;
  truncationPolicy: string;
  dimensions: number;
}

/** Snapshot carried through asynchronous embedding; write revalidates input. */
export interface VectorOwnerInput {
  documentId: number;
  mirrorHash: string;
  seq: number;
  formattedInput: string;
  inputHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Types
// ─────────────────────────────────────────────────────────────────────────────

/** Vector row for storage */
export interface VectorRow {
  mirrorHash: string;
  seq: number;
  model: string;
  embedFingerprint: string;
  embedding: Float32Array;
  // embeddedAt is set by DB via datetime('now')
}

export interface VectorSearchOptions {
  minScore?: number;
  allowedMirrorHashes?: string[];
  /** Exact active owner/chunk domain, applied before the nearest-neighbor budget. */
  eligibility?: DocumentEligibilityOptions & { language?: string };
}

/** Vector search result */
export interface VectorSearchResult {
  mirrorHash: string;
  seq: number;
  distance: number;
}

/** Cursor for seek-based backlog pagination */
export interface BacklogCursor {
  mirrorHash: string;
  seq: number;
}

/** Backlog item needing embedding */
export interface BacklogItem {
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
  reason: "new" | "changed" | "force";
}

// ─────────────────────────────────────────────────────────────────────────────
// VectorIndexPort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VectorIndexPort handles vector search acceleration via sqlite-vec.
 * Storage is ALWAYS via content_vectors table (works without sqlite-vec).
 * This port adds KNN search capability when sqlite-vec is available.
 */
export interface VectorIndexPort {
  /** True if sqlite-vec loaded successfully */
  readonly searchAvailable: boolean;
  /** Model URI this index is configured for */
  readonly model: string;
  /** Vector dimensions */
  readonly dimensions: number;
  /** Error message if sqlite-vec failed to load (for diagnostics) */
  readonly loadError?: string;
  /** User-facing recovery guidance when search is unavailable */
  readonly guidance?: string;
  /** True if vec0 inserts failed during this session (needs sync) */
  vecDirty: boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // Storage (always works, uses content_vectors table)
  // ─────────────────────────────────────────────────────────────────────────

  /** Upsert vectors into storage and vec index */
  upsertVectors(rows: VectorRow[]): Promise<StoreResult<void>>;

  /** Delete all vectors for a mirror hash (for this model) */
  deleteVectorsForMirror(mirrorHash: string): Promise<StoreResult<void>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Search (requires sqlite-vec)
  // ─────────────────────────────────────────────────────────────────────────

  /** Find k nearest neighbors */
  searchNearest(
    embedding: Float32Array,
    k: number,
    options?: VectorSearchOptions
  ): Promise<StoreResult<VectorSearchResult[]>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Index maintenance
  // ─────────────────────────────────────────────────────────────────────────

  /** Drop and rebuild vec index from content_vectors */
  rebuildVecIndex(): Promise<StoreResult<void>>;

  /** Sync vec index with content_vectors (add missing, remove orphans) */
  syncVecIndex(): Promise<StoreResult<{ added: number; removed: number }>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// VectorStatsPort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VectorStatsPort for backlog/stats queries (model-aware).
 * Works without sqlite-vec.
 */
export interface VectorStatsPort {
  /** Count vectors for a model */
  countVectors(model: string): Promise<StoreResult<number>>;

  /** Count chunks needing embedding for a model */
  countBacklog(
    model: string,
    embedFingerprint: string,
    options?: { collection?: string }
  ): Promise<StoreResult<number>>;

  /** Get chunks needing embedding for a model (seek pagination) */
  getBacklog(
    model: string,
    embedFingerprint: string,
    options?: { limit?: number; after?: BacklogCursor; collection?: string }
  ): Promise<StoreResult<BacklogItem[]>>;
}
