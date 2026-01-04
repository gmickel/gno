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
  VectorRow,
  VectorStatsPort,
} from "../store/vector";

import { formatDocForEmbedding } from "../pipeline/contextual";
import { err, ok } from "../store/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedBacklogDeps {
  statsPort: VectorStatsPort;
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  modelUri: string;
  batchSize?: number;
}

export interface EmbedBacklogResult {
  embedded: number;
  errors: number;
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
  const { statsPort, embedPort, vectorIndex, modelUri } = deps;
  const batchSize = deps.batchSize ?? 32;

  let embedded = 0;
  let errors = 0;
  let cursor: Cursor | undefined;

  try {
    while (true) {
      // Get next batch using seek pagination
      const batchResult = await statsPort.getBacklog(modelUri, {
        limit: batchSize,
        after: cursor,
      });

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

      // Embed batch with contextual formatting (title prefix)
      const embedResult = await embedPort.embedBatch(
        batch.map((b: BacklogItem) =>
          formatDocForEmbedding(b.text, b.title ?? undefined)
        )
      );

      if (!embedResult.ok) {
        errors += batch.length;
        continue;
      }

      // Validate batch/embedding count match
      const embeddings = embedResult.value;
      if (embeddings.length !== batch.length) {
        errors += batch.length;
        continue;
      }

      // Store vectors (embeddedAt set by DB)
      const vectors: VectorRow[] = batch.map((b: BacklogItem, idx: number) => ({
        mirrorHash: b.mirrorHash,
        seq: b.seq,
        model: modelUri,
        embedding: new Float32Array(embeddings[idx] as number[]),
      }));

      const storeResult = await vectorIndex.upsertVectors(vectors);
      if (!storeResult.ok) {
        errors += batch.length;
        continue;
      }

      embedded += batch.length;
    }

    return ok({ embedded, errors });
  } catch (e) {
    return err(
      "INTERNAL",
      `Embedding failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
