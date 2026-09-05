import type { StoreResult } from "../store/types";
import type { VectorVariantStore } from "../store/vector/variants";
import type { EmbedBacklogDeps, EmbedBacklogResult } from "./backlog";

import { err, ok } from "../store/types";
import { getVectorStatsDatabase } from "../store/vector/stats";
import { embedVariantBatch } from "./variant-retry";

/** One bounded owner pass plus one retry; mutations stay durably pending for the next pass. */
export async function embedVariantBacklog(
  deps: EmbedBacklogDeps,
  store: VectorVariantStore
): Promise<StoreResult<EmbedBacklogResult>> {
  const identityStillCurrent = deps.identityStillCurrent;
  if (!identityStillCurrent)
    return err(
      "INVALID_INPUT",
      "Variant embedding requires an effective runtime identity check"
    );
  const db = getVectorStatsDatabase(deps.statsPort);
  if (deps.collection && !db)
    return err(
      "INVALID_INPUT",
      "Collection-scoped variant backlog requires document ownership storage"
    );
  const batchSize = deps.batchSize ?? 32;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    return err("INVALID_INPUT", "Invalid embedding batch size");
  const total = { embedded: 0, errors: 0, contentionErrors: 0 };
  let after: { documentId: number; seq: number } | undefined;
  try {
    while (identityStillCurrent()) {
      const pending = store.pending({ limit: batchSize, after });
      if (!pending.length) break;
      const last = pending.at(-1)!;
      after = { documentId: last.documentId, seq: last.seq };
      const owners = deps.collection
        ? pending.filter(
            (owner) =>
              !!db!
                .query(
                  "SELECT 1 FROM documents WHERE id = ? AND collection = ? AND active = 1"
                )
                .get(owner.documentId, deps.collection!)
          )
        : pending;
      let result = await embedVariantBatch({
        store,
        embedPort: deps.embedPort,
        owners,
        identityStillCurrent,
      });
      total.embedded += result.embedded;
      total.errors += result.errors;
      total.contentionErrors += result.contentionErrors;
      if (result.retryOwners.length) {
        result = await embedVariantBatch({
          store,
          embedPort: deps.embedPort,
          owners: result.retryOwners,
          identityStillCurrent,
        });
        total.embedded += result.embedded;
        total.errors += result.errors + result.retryOwners.length;
        total.contentionErrors += result.contentionErrors;
      }
    }
    // Capture the epoch before checking completeness; activate rechecks under write lock.
    const epoch = store.epoch();
    if (identityStillCurrent() && !store.pending({ limit: 1 }).length) {
      try {
        store.activate(epoch);
      } catch (cause) {
        return ok({
          ...total,
          syncError: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return ok(total);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}
