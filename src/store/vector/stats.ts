/**
 * VectorStatsPort implementation for backlog/stats queries.
 * Works without sqlite-vec.
 *
 * @module src/store/vector/stats
 */

import type { Database } from 'bun:sqlite';
import type { StoreResult } from '../types';
import { err, ok } from '../types';
import type { BacklogItem, VectorStatsPort } from './types';

/**
 * Create a VectorStatsPort for backlog detection and vector stats.
 * Uses EXISTS-based queries to avoid duplicates from multiple docs sharing mirror_hash.
 */
export function createVectorStatsPort(db: Database): VectorStatsPort {
  return {
    countVectors(model: string): Promise<StoreResult<number>> {
      try {
        const result = db
          .prepare(
            'SELECT COUNT(*) as count FROM content_vectors WHERE model = ?'
          )
          .get(model) as { count: number };
        return Promise.resolve(ok(result.count));
      } catch (e) {
        return Promise.resolve(
          err(
            'QUERY_FAILED',
            `Failed to count vectors: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    countBacklog(model: string): Promise<StoreResult<number>> {
      try {
        // Count chunks needing embedding (fast for progress display)
        // Uses EXISTS to avoid duplicates when multiple docs share mirror_hash
        const result = db
          .prepare(
            `
          SELECT COUNT(*) as count
          FROM content_chunks c
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors v
            WHERE v.mirror_hash = c.mirror_hash
              AND v.seq = c.seq
              AND v.model = ?
              AND v.embedded_at >= c.created_at
          )
        `
          )
          .get(model) as { count: number };
        return Promise.resolve(ok(result.count));
      } catch (e) {
        return Promise.resolve(
          err(
            'QUERY_FAILED',
            `Failed to count backlog: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    getBacklog(
      model: string,
      options?: { limit?: number; after?: { mirrorHash: string; seq: number } }
    ): Promise<StoreResult<BacklogItem[]>> {
      try {
        const limit = options?.limit ?? 1000;
        const after = options?.after;

        // Seek pagination: use cursor to avoid skipping items as backlog shrinks
        // Query structure changes based on whether we have a cursor
        const sql = after
          ? `
          SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
            CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM content_vectors v
                WHERE v.mirror_hash = c.mirror_hash
                  AND v.seq = c.seq
                  AND v.model = ?
              ) THEN 'new'
              ELSE 'changed'
            END as reason
          FROM content_chunks c
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors v
            WHERE v.mirror_hash = c.mirror_hash
              AND v.seq = c.seq
              AND v.model = ?
              AND v.embedded_at >= c.created_at
          )
          AND (c.mirror_hash > ? OR (c.mirror_hash = ? AND c.seq > ?))
          ORDER BY c.mirror_hash, c.seq
          LIMIT ?
        `
          : `
          SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
            CASE
              WHEN NOT EXISTS (
                SELECT 1 FROM content_vectors v
                WHERE v.mirror_hash = c.mirror_hash
                  AND v.seq = c.seq
                  AND v.model = ?
              ) THEN 'new'
              ELSE 'changed'
            END as reason
          FROM content_chunks c
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors v
            WHERE v.mirror_hash = c.mirror_hash
              AND v.seq = c.seq
              AND v.model = ?
              AND v.embedded_at >= c.created_at
          )
          ORDER BY c.mirror_hash, c.seq
          LIMIT ?
        `;

        const params = after
          ? [model, model, after.mirrorHash, after.mirrorHash, after.seq, limit]
          : [model, model, limit];

        const results = db.prepare(sql).all(...params) as BacklogItem[];
        return Promise.resolve(ok(results));
      } catch (e) {
        return Promise.resolve(
          err(
            'QUERY_FAILED',
            `Failed to get backlog: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },
  };
}
