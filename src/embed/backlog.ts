/**
 * Shared embedding backlog processor.
 * Used by CLI embed, Web scheduler, and MCP tools.
 *
 * @module src/embed/backlog
 */

import type { EmbeddingPort } from "../llm/types";
import type { StoreResult } from "../store/types";
import type {
  BacklogItem,
  VectorIndexPort,
  VectorStatsPort,
} from "../store/vector";

import { err, ok } from "../store/types";
import { getEmbeddingFingerprint } from "./fingerprint";
import {
  chunkRetryKey,
  embedAndStoreBatch,
  MAX_EMBED_CHUNK_ATTEMPTS,
} from "./retry";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedBacklogDeps {
  statsPort: VectorStatsPort;
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  collection?: string;
  modelUri: string;
  batchSize?: number;
}

export interface EmbedBacklogResult {
  embedded: number;
  errors: number;
  /** Error message if vec index sync failed (embeddings stored, but search may be stale) */
  syncError?: string;
}

interface Cursor {
  mirrorHash: string;
  seq: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process embedding backlog in batches.
 * Cursor-based pagination, batch embedding, vector storage.
 */
export async function embedBacklog(
  deps: EmbedBacklogDeps
): Promise<StoreResult<EmbedBacklogResult>> {
  const { statsPort, embedPort, vectorIndex, modelUri, collection } = deps;
  const batchSize = deps.batchSize ?? 32;
  const embedFingerprint = getEmbeddingFingerprint({
    modelUri,
    dimensions: vectorIndex.dimensions,
  });

  let embedded = 0;
  let errors = 0;
  let cursor: Cursor | undefined;
  const retryQueue = new Map<string, { item: BacklogItem; attempts: number }>();

  const enqueueRetryItems = (items: BacklogItem[], attempts: number): void => {
    for (const item of items) {
      const key = chunkRetryKey(item);
      const existing = retryQueue.get(key);
      retryQueue.set(key, {
        item,
        attempts: Math.max(existing?.attempts ?? 0, attempts),
      });
    }
  };

  const drainRetryQueue = async (): Promise<number> => {
    if (retryQueue.size === 0) {
      return 0;
    }

    let retryEmbedded = 0;
    const entries = [...retryQueue.values()].filter(
      (entry) => entry.attempts < MAX_EMBED_CHUNK_ATTEMPTS
    );

    for (let idx = 0; idx < entries.length; idx += batchSize) {
      const slice = entries.slice(idx, idx + batchSize);
      for (const entry of slice) {
        retryQueue.delete(chunkRetryKey(entry.item));
        entry.attempts += 1;
      }

      const retryResult = await embedAndStoreBatch({
        embedPort,
        vectorIndex,
        items: slice.map((entry) => entry.item),
        modelUri,
        embedFingerprint,
      });

      embedded += retryResult.embedded;
      errors += retryResult.errors;
      retryEmbedded += retryResult.embedded;

      const retryByKey = new Set(
        retryResult.retryItems.map((item) => chunkRetryKey(item))
      );
      for (const entry of slice) {
        if (!retryByKey.has(chunkRetryKey(entry.item))) {
          continue;
        }
        if (entry.attempts >= MAX_EMBED_CHUNK_ATTEMPTS) {
          errors += 1;
        } else {
          retryQueue.set(chunkRetryKey(entry.item), entry);
        }
      }
    }

    return retryEmbedded;
  };

  try {
    while (true) {
      // Get next batch using seek pagination
      const batchResult = await statsPort.getBacklog(
        modelUri,
        embedFingerprint,
        {
          limit: batchSize,
          after: cursor,
          collection,
        }
      );

      if (!batchResult.ok) {
        return err("QUERY_FAILED", batchResult.error.message);
      }

      const batch = batchResult.value;
      if (batch.length === 0) {
        break;
      }

      // Advance cursor (even on failure, to avoid infinite loops)
      const lastItem = batch.at(-1);
      if (lastItem) {
        cursor = { mirrorHash: lastItem.mirrorHash, seq: lastItem.seq };
      }

      const beforeEmbedded = embedded;
      const batchStoreResult = await embedAndStoreBatch({
        embedPort,
        vectorIndex,
        items: batch,
        modelUri,
        embedFingerprint,
      });
      embedded += batchStoreResult.embedded;
      errors += batchStoreResult.errors;
      enqueueRetryItems(batchStoreResult.retryItems, 1);

      if (embedded > beforeEmbedded) {
        await drainRetryQueue();
      }
    }

    await drainRetryQueue();

    // Sync vec index once at end if any vec0 writes failed
    let syncError: string | undefined;
    if (vectorIndex.vecDirty) {
      const syncResult = await vectorIndex.syncVecIndex();
      if (syncResult.ok) {
        const { added, removed } = syncResult.value;
        if (added > 0 || removed > 0) {
          console.log(`[vec] Synced index: +${added} -${removed}`);
        }
        vectorIndex.vecDirty = false;
      } else {
        syncError = syncResult.error.message;
        console.warn(`[vec] Sync failed: ${syncError}`);
      }
    }

    return ok({ embedded, errors, syncError });
  } catch (e) {
    return err(
      "INTERNAL",
      `Embedding failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
