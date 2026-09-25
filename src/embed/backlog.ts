import type { Database } from "bun:sqlite";

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

import {
  assertInferenceActive,
  isBackgroundInference,
} from "../llm/inference-scope";
import { formatDocForEmbedding } from "../pipeline/contextual";
import { err, ok } from "../store/types";
import {
  embeddingPartitionIdentity,
  recordReferenceRuntime,
  resolveRuntimePartition,
} from "../store/vector/runtime-compat";
import { getVectorStatsDatabase } from "../store/vector/stats";
import { createVectorVariantStore } from "../store/vector/variants";
import { getEmbeddingFingerprint } from "./fingerprint";
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
  /** Explicit confirmation to build a separate vector partition (never implied by --yes). */
  allowNewPartition?: boolean;
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
  const background = isBackgroundInference();
  const batchSize = background
    ? Math.min(deps.batchSize ?? 32, 32)
    : (deps.batchSize ?? 32);
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
        identityStillCurrent: deps.identityStillCurrent,
        statsPort,
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
        identityStillCurrent: deps.identityStillCurrent,
        statsPort,
      });
      embedded += batchStoreResult.embedded;
      errors += batchStoreResult.errors;
      contentionErrors += batchStoreResult.contentionErrors;
      if (background) {
        errors += batchStoreResult.retryItems.length;
        deps.onProgress?.(embedded, errors);
        // Each cursor page is a turn. Failed early pages cannot starve later work.
        await Bun.sleep(0);
        if (deps.identityStillCurrent && !deps.identityStillCurrent()) break;
        continue;
      }
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

function formatEstimate(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `about ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90
    ? `about ${minutes} min`
    : `about ${(minutes / 60).toFixed(1)} h`;
}

/** Time this port on a few current chunks when no compatibility sample ran. */
async function measureEmbedRate(
  db: Database,
  port: EmbeddingPort
): Promise<number | undefined> {
  const inputs = db
    .query<{ text: string; title: string | null }, []>(`
      SELECT c.text, d.title FROM documents d
      JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      WHERE d.active = 1 ORDER BY d.id, c.seq LIMIT 8
    `)
    .all()
    .map((row) =>
      formatDocForEmbedding(row.text, row.title ?? undefined, port.modelUri)
    );
  if (!inputs.length) return undefined;
  const startedAt = performance.now();
  const result = await port.embedBatch(inputs);
  return result.ok
    ? (performance.now() - startedAt) / inputs.length
    : undefined;
}

/** R3: a fork names itself, its full size and a measured estimate before it runs. */
async function separatePartitionMessage(
  db: Database,
  port: EmbeddingPort,
  reason: string,
  msPerChunk: number | undefined
): Promise<string> {
  const chunks = db
    .query<{ count: number }, []>(`
      SELECT count(*) AS count FROM documents d
      JOIN content_chunks c ON c.mirror_hash = d.mirror_hash WHERE d.active = 1
    `)
    .get()!.count;
  const rate = msPerChunk ?? (await measureEmbedRate(db, port));
  const estimate =
    rate === undefined
      ? "no estimate: embedding could not be timed"
      : `estimated ${formatEstimate(rate * chunks)} at the measured ${Math.round(rate)} ms per chunk`;
  return `Embedding would build a separate vector partition (${reason}). It re-embeds all ${chunks} chunks (${estimate}). Confirm with \`gno embed --new-partition\`; --yes alone does not confirm.`;
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
      const primary = embeddingPartitionIdentity(deps.embedPort);
      if (identity && primary) {
        const identitySnapshot = JSON.stringify(identity);
        const dimensions = primary.dimensions;
        const resolved = await resolveRuntimePartition(
          db,
          deps.embedPort,
          primary
        );
        if (resolved.blocked && !deps.allowNewPartition)
          return err(
            "VECTOR_PARTITION_FORK",
            await separatePartitionMessage(
              db,
              deps.embedPort,
              resolved.blocked.reason,
              resolved.msPerChunk
            )
          );
        const variantStore = await createVectorVariantStore(
          db,
          resolved.blocked?.separate ?? resolved.identity,
          identity.runtimeLabel
        );
        if (resolved.blocked || resolved.verdict === "unverified") {
          // Vectors without a current owner cannot be measured; they must not
          // survive to be reused by the runtime that becomes the reference.
          variantStore.collectGarbage();
          recordReferenceRuntime(db, variantStore.partitionId, identity);
        }
        variantStore.selectForEmbedding();
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
