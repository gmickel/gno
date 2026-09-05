import type { EmbeddingPort } from "../llm/types";
/**
 * Shared embedding backlog processor.
 * Used by CLI embed, Web scheduler, and MCP tools.
 *
 * @module src/embed/backlog
 */
import type { StoreResult } from "../store/types";
import type {
  BacklogItem,
  VectorIndexPort,
  VectorStatsPort,
} from "../store/vector";
import type { VectorVariantStore } from "../store/vector/variants";

import { assertInferenceActive } from "../llm/inference-scope";
import { err, ok } from "../store/types";
import { getVectorStatsDatabase } from "../store/vector/stats";
import { createVectorVariantStore } from "../store/vector/variants";
import {
  getEmbeddingFingerprint,
  getVariantModelFingerprint,
} from "./fingerprint";
import {
  chunkRetryKey,
  embedAndStoreBatch,
  MAX_EMBED_CHUNK_ATTEMPTS,
} from "./retry";
import { embedVariantBacklog } from "./variant-backlog";

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
  force?: boolean;
  onProgress?: (embedded: number, errors: number) => void;
  variantStore?: VectorVariantStore;
  /** Recheck the effective runtime identity after asynchronous inference. */
  identityStillCurrent?: () => boolean;
}

export interface EmbedBacklogResult {
  embedded: number;
  errors: number;
  /**
   * Chunks whose persistence failed after SQLITE_BUSY/SQLITE_LOCKED retries.
   * Distinct from `errors` (embedding-provider failures). Default 0.
   */
  contentionErrors?: number;
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
  assertInferenceActive();
  const prepared = await prepareEmbeddingBacklog(deps);
  if (!prepared.ok) return prepared;
  deps = prepared.value;
  if (deps.variantStore) return embedVariantBacklog(deps, deps.variantStore);
  const { statsPort, embedPort, vectorIndex, modelUri, collection } = deps;
  const batchSize = deps.batchSize ?? 32;
  const embedFingerprint = getEmbeddingFingerprint({
    modelUri,
    dimensions: vectorIndex.dimensions,
  });

  let embedded = 0;
  let errors = 0;
  let contentionErrors = 0;
  let cursor: Cursor | undefined;
  const retryQueue = new Map<string, { item: BacklogItem; attempts: number }>();

  const enqueueRetryItems = (items: BacklogItem[], attempts: number): void => {
    for (const item of items) {
      assertInferenceActive();
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
      assertInferenceActive();
      const slice = entries.slice(idx, idx + batchSize);
      for (const entry of slice) {
        assertInferenceActive();
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
      contentionErrors += retryResult.contentionErrors;
      retryEmbedded += retryResult.embedded;

      const retryByKey = new Set(
        retryResult.retryItems.map((item) => chunkRetryKey(item))
      );
      for (const entry of slice) {
        assertInferenceActive();
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
      assertInferenceActive();
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
      contentionErrors += batchStoreResult.contentionErrors;
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

    assertInferenceActive();
    return ok({ embedded, errors, contentionErrors, syncError });
  } catch (e) {
    return err(
      "INTERNAL",
      `Embedding failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/** Resolve authority before counts, dry runs, forced work, or early returns. */
export async function prepareEmbeddingBacklog(
  deps: EmbedBacklogDeps
): Promise<StoreResult<EmbedBacklogDeps>> {
  if (deps.variantStore) return ok(deps);
  const db = getVectorStatsDatabase(deps.statsPort);
  if (db) {
    try {
      const initialized = await deps.embedPort.init();
      if (!initialized.ok) return err("INTERNAL", initialized.error.message);
      const identity = deps.embedPort.getIdentity?.();
      if (identity) {
        const identitySnapshot = JSON.stringify(identity);
        const dimensions = deps.embedPort.dimensions();
        const variantStore = await createVectorVariantStore(db, {
          model: deps.modelUri,
          modelFingerprint: getVariantModelFingerprint(
            { modelUri: deps.modelUri, dimensions },
            identity
          ),
          contextSize: identity.contextSize,
          truncationPolicy: identity.truncationPolicy,
          dimensions,
        });
        return ok({
          ...deps,
          variantStore,
          identityStillCurrent: () =>
            (deps.identityStillCurrent?.() ?? true) &&
            deps.embedPort.modelUri === deps.modelUri &&
            deps.embedPort.dimensions() === dimensions &&
            JSON.stringify(deps.embedPort.getIdentity?.()) === identitySnapshot,
        });
      }
      // Unverified/HTTP ports retain legacy behavior until variant authority exists.
      if (
        db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
          )
          .get() &&
        db
          .query(
            "SELECT 1 FROM vector_partitions WHERE model = ? AND state = ? AND activated_epoch IS NOT NULL LIMIT 1"
          )
          .get(deps.modelUri, "active")
      ) {
        return err(
          "INVALID_INPUT",
          "Effective embedding identity unavailable after variant activation"
        );
      }
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : String(cause)
      );
    }
  }
  return ok(deps);
}
