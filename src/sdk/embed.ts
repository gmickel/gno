/**
 * SDK embedding helpers.
 *
 * @module src/sdk/embed
 */

import type { Database } from "bun:sqlite";

import type { Config } from "../config/types";
import type { LlmAdapter } from "../llm/nodeLlamaCpp/adapter";
import type { EmbeddingPort } from "../llm/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";
import type {
  BacklogItem,
  VectorIndexPort,
  VectorStatsPort,
} from "../store/vector";
import type { GnoEmbedOptions, GnoEmbedResult } from "./types";

import { embedBacklog } from "../embed";
import { getEmbeddingFingerprint } from "../embed/fingerprint";
import {
  chunkRetryKey,
  embedAndStoreBatch,
  MAX_EMBED_CHUNK_ATTEMPTS,
} from "../embed/retry";
import { resolveModelUri } from "../llm/registry";
import { err, ok } from "../store/types";
import { createVectorIndexPort, createVectorStatsPort } from "../store/vector";
import { getStoredEmbeddingFingerprint } from "../store/vector/freshness";
import { sdkError } from "./errors";

interface EmbedRuntimeOptions {
  config: Config;
  store: SqliteAdapter;
  llm: LlmAdapter;
  downloadPolicy?: import("../llm/policy").DownloadPolicy;
}

function getActiveChunkCount(db: Database): Promise<StoreResult<number>> {
  try {
    const result = db
      .prepare(
        `
        SELECT COUNT(*) as count FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
      `
      )
      .get() as { count: number };
    return Promise.resolve(ok(result.count));
  } catch (cause) {
    return Promise.resolve(
      err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to count chunks",
        cause
      )
    );
  }
}

function getActiveChunks(
  db: Database,
  limit: number,
  after?: { mirrorHash: string; seq: number }
): Promise<StoreResult<BacklogItem[]>> {
  try {
    const sql = after
      ? `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
          (SELECT d.title FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1 LIMIT 1) as title,
          'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
        AND (c.mirror_hash > ? OR (c.mirror_hash = ? AND c.seq > ?))
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `
      : `
        SELECT c.mirror_hash as mirrorHash, c.seq, c.text,
          (SELECT d.title FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1 LIMIT 1) as title,
          'force' as reason
        FROM content_chunks c
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
        )
        ORDER BY c.mirror_hash, c.seq
        LIMIT ?
      `;

    const params = after
      ? [after.mirrorHash, after.mirrorHash, after.seq, limit]
      : [limit];
    const result = db.prepare(sql).all(...params) as BacklogItem[];
    return Promise.resolve(ok(result));
  } catch (cause) {
    return Promise.resolve(
      err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get chunks",
        cause
      )
    );
  }
}

async function forceEmbedAll(
  db: Database,
  embedPort: EmbeddingPort,
  vectorIndex: VectorIndexPort,
  modelUri: string,
  batchSize: number
): Promise<{ embedded: number; errors: number }> {
  let embedded = 0;
  let errors = 0;
  let cursor: { mirrorHash: string; seq: number } | undefined;
  const retryQueue = new Map<string, { item: BacklogItem; attempts: number }>();
  const embedFingerprint = getEmbeddingFingerprint({
    modelUri,
    dimensions: vectorIndex.dimensions,
  });

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

  while (true) {
    const batchResult = await getActiveChunks(db, batchSize, cursor);
    if (!batchResult.ok) {
      throw sdkError("STORE", batchResult.error.message, {
        cause: batchResult.error.cause,
      });
    }

    const batch = batchResult.value;
    if (batch.length === 0) {
      break;
    }

    const lastItem = batch.at(-1);
    if (lastItem) {
      cursor = { mirrorHash: lastItem.mirrorHash, seq: lastItem.seq };
    }

    const beforeEmbedded = embedded;
    const embedResult = await embedAndStoreBatch({
      embedPort,
      vectorIndex,
      items: batch,
      modelUri,
      embedFingerprint,
    });
    embedded += embedResult.embedded;
    errors += embedResult.errors;
    enqueueRetryItems(embedResult.retryItems, 1);

    if (embedded > beforeEmbedded) {
      await drainRetryQueue();
    }
  }

  await drainRetryQueue();
  if (retryQueue.size > 0) {
    errors += retryQueue.size;
    retryQueue.clear();
  }

  if (vectorIndex.vecDirty) {
    const syncResult = await vectorIndex.syncVecIndex();
    if (syncResult.ok) {
      vectorIndex.vecDirty = false;
    }
  }

  return { embedded, errors };
}

async function checkVecAvailable(db: Database): Promise<boolean> {
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

export async function runEmbed(
  runtime: EmbedRuntimeOptions,
  options: GnoEmbedOptions = {}
): Promise<GnoEmbedResult> {
  const batchSize = options.batchSize ?? 32;
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;
  const modelUri = resolveModelUri(
    runtime.config,
    "embed",
    options.model,
    options.collection
  );
  const db = runtime.store.getRawDb();
  const stats: VectorStatsPort = createVectorStatsPort(db);

  const backlogResult = force
    ? await getActiveChunkCount(db)
    : await stats.countBacklog(
        modelUri,
        getStoredEmbeddingFingerprint(db, modelUri),
        { collection: options.collection }
      );
  if (!backlogResult.ok) {
    throw sdkError("STORE", backlogResult.error.message, {
      cause: backlogResult.error.cause,
    });
  }

  const totalToEmbed = backlogResult.value;
  if (totalToEmbed === 0 || dryRun) {
    return {
      embedded: totalToEmbed,
      errors: 0,
      duration: 0,
      model: modelUri,
      searchAvailable: await checkVecAvailable(db),
    };
  }

  const embedResult = await runtime.llm.createEmbeddingPort(modelUri, {
    policy: runtime.downloadPolicy,
  });
  if (!embedResult.ok) {
    throw sdkError("MODEL", embedResult.error.message, {
      cause: embedResult.error.cause,
    });
  }

  const embedPort = embedResult.value;
  try {
    const probeResult = await embedPort.embed("dimension probe");
    if (!probeResult.ok) {
      throw sdkError("MODEL", probeResult.error.message, {
        cause: probeResult.error.cause,
      });
    }

    const vectorResult = await createVectorIndexPort(db, {
      model: modelUri,
      dimensions: probeResult.value.length,
    });
    if (!vectorResult.ok) {
      throw sdkError("STORE", vectorResult.error.message, {
        cause: vectorResult.error.cause,
      });
    }

    const vectorIndex = vectorResult.value;
    const startedAt = Date.now();
    let result: { embedded: number; errors: number };
    if (force) {
      result = await forceEmbedAll(
        db,
        embedPort,
        vectorIndex,
        modelUri,
        batchSize
      );
    } else {
      const processed = await embedBacklog({
        statsPort: stats,
        embedPort,
        vectorIndex,
        collection: options.collection,
        modelUri,
        batchSize,
      });
      if (!processed.ok) {
        throw sdkError("STORE", processed.error.message, {
          cause: processed.error.cause,
        });
      }
      result = {
        embedded: processed.value.embedded,
        errors: processed.value.errors,
      };
    }

    return {
      embedded: result.embedded,
      errors: result.errors,
      duration: (Date.now() - startedAt) / 1000,
      model: modelUri,
      searchAvailable: vectorIndex.searchAvailable,
    };
  } finally {
    await embedPort.dispose();
  }
}
