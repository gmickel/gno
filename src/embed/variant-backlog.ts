import type { StoreResult } from "../store/types";
import type { VectorVariantStore } from "../store/vector/variants";
import type { EmbedBacklogDeps, EmbedBacklogResult } from "./backlog";

import {
  assertInferenceActive,
  isBackgroundInference,
  withInferencePage,
} from "../llm/inference-scope";
import { err, ok } from "../store/types";
import { getVectorStatsDatabase } from "../store/vector/stats";
import { inWriteTurn } from "./retry";
import { variantBacklogPage } from "./variant-plan";
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
  const background = isBackgroundInference();
  const batchSize = background
    ? Math.min(deps.batchSize ?? 32, 32)
    : (deps.batchSize ?? 32);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    return err("INVALID_INPUT", "Invalid embedding batch size");
  const total = { embedded: 0, errors: 0, contentionErrors: 0 };
  let after: { documentId: number; seq: number } | undefined;
  const limits = deps.limits;
  const startedAt = performance.now();
  let attempted = 0;
  /** True once a bound is reached and the next page still has owners. */
  const stopAtLimit = (): boolean => {
    if (!limits) return false;
    const chunksReached =
      limits.maxChunks !== undefined && attempted >= limits.maxChunks;
    const secondsReached =
      limits.maxSeconds !== undefined &&
      (performance.now() - startedAt) / 1000 >= limits.maxSeconds;
    if (!chunksReached && !secondsReached) return false;
    // A bound reached on the last page is a finished pass: activate as usual.
    return variantBacklogPage(deps, store, 1, after).length > 0;
  };
  try {
    while (true) {
      // A failed request drops the port's cached identity (a timed-out native
      // worker is retired); reload it so one failed page cannot end the pass.
      if (background) {
        const reloaded = await withInferencePage(() => deps.embedPort.init());
        // Without an identity the pass cannot continue. Failing it schedules
        // the scheduler's bounded retry instead of ending with pages pending.
        if (!reloaded?.ok)
          throw new Error(
            reloaded?.error.message ??
              "Embedding model reload exceeded its inference deadline"
          );
      }
      if (!identityStillCurrent()) break;
      assertInferenceActive();
      const pending = variantBacklogPage(deps, store, batchSize, after);
      if (!pending.length) break;
      const last = pending.at(-1)!;
      after = { documentId: last.documentId, seq: last.seq };
      // Pages are already limited to deps.collection in SQL.
      const owners = pending;
      const embedPage = () =>
        embedVariantBatch({
          store,
          embedPort: deps.embedPort,
          owners,
          identityStillCurrent,
          force: deps.force,
          acquireWriteTurn: deps.acquireWriteTurn,
        });
      let result = background
        ? await withInferencePage(embedPage)
        : await embedPage();
      if (!result) {
        // Past its deadline: this page stays pending for the next pass.
        total.errors += owners.length;
        deps.onProgress?.(total.embedded, total.errors);
        attempted += owners.length;
        if (stopAtLimit()) return ok({ ...total, stopped: "limit" });
        await Bun.sleep(0);
        continue;
      }
      if (result.deferred) return ok({ ...total, deferred: true });
      total.embedded += result.embedded;
      total.errors += result.errors;
      total.contentionErrors += result.contentionErrors;
      if (background) total.errors += result.retryOwners.length;
      if (!background && result.retryOwners.length) {
        result = await embedVariantBatch({
          store,
          embedPort: deps.embedPort,
          owners: result.retryOwners,
          identityStillCurrent,
          force: deps.force,
        });
        total.embedded += result.embedded;
        total.errors += result.errors + result.retryOwners.length;
        total.contentionErrors += result.contentionErrors;
      }
      deps.onProgress?.(total.embedded, total.errors);
      attempted += owners.length;
      if (stopAtLimit()) return ok({ ...total, stopped: "limit" });
      if (background) await Bun.sleep(0);
    }
    assertInferenceActive();
    // Capture the epoch before checking completeness; activate rechecks under write lock.
    const epoch = store.epoch();
    if (identityStillCurrent() && !store.hasPending()) {
      const turn = await inWriteTurn(deps.acquireWriteTurn, async () => {
        try {
          if (!store.isActive()) store.syncIndex();
          if (identityStillCurrent()) store.activate(epoch);
          return undefined;
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause);
        }
      });
      if (turn.deferred) return ok({ ...total, deferred: true });
      if (turn.value !== undefined)
        return ok({ ...total, syncError: turn.value });
    }
    assertInferenceActive();
    return ok(total);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}
