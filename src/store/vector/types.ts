/**
 * Vector index types and interfaces.
 * Defines VectorIndexPort and VectorStatsPort for embedding storage/search.
 *
 * @module src/store/vector/types
 */

import type { StoreResult } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Row Types
// ─────────────────────────────────────────────────────────────────────────────

/** Vector row for storage */
export type VectorRow = {
  mirrorHash: string;
  seq: number;
  model: string;
  embedding: Float32Array;
  embeddedAt: string;
};

/** Vector search result */
export type VectorSearchResult = {
  mirrorHash: string;
  seq: number;
  distance: number;
};

/** Cursor for seek-based backlog pagination */
export type BacklogCursor = { mirrorHash: string; seq: number };

/** Backlog item needing embedding */
export type BacklogItem = {
  mirrorHash: string;
  seq: number;
  text: string;
  reason: 'new' | 'changed' | 'force';
};

// ─────────────────────────────────────────────────────────────────────────────
// VectorIndexPort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VectorIndexPort handles vector search acceleration via sqlite-vec.
 * Storage is ALWAYS via content_vectors table (works without sqlite-vec).
 * This port adds KNN search capability when sqlite-vec is available.
 */
export type VectorIndexPort = {
  /** True if sqlite-vec loaded successfully */
  readonly searchAvailable: boolean;
  /** Model URI this index is configured for */
  readonly model: string;
  /** Vector dimensions */
  readonly dimensions: number;

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
    options?: { minScore?: number }
  ): Promise<StoreResult<VectorSearchResult[]>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Index maintenance
  // ─────────────────────────────────────────────────────────────────────────

  /** Drop and rebuild vec index from content_vectors */
  rebuildVecIndex(): Promise<StoreResult<void>>;

  /** Sync vec index with content_vectors (add missing, remove orphans) */
  syncVecIndex(): Promise<StoreResult<{ added: number; removed: number }>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// VectorStatsPort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VectorStatsPort for backlog/stats queries (model-aware).
 * Works without sqlite-vec.
 */
export type VectorStatsPort = {
  /** Count vectors for a model */
  countVectors(model: string): Promise<StoreResult<number>>;

  /** Count chunks needing embedding for a model */
  countBacklog(model: string): Promise<StoreResult<number>>;

  /** Get chunks needing embedding for a model (seek pagination) */
  getBacklog(
    model: string,
    options?: { limit?: number; after?: BacklogCursor }
  ): Promise<StoreResult<BacklogItem[]>>;
};
