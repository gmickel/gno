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
import {
  compareOwnerCursor,
  isOwnerCursor,
  type OwnerCursor,
  readResumeCursor,
  resumeCursorKey,
  writeResumeCursor,
} from "./resume-cursor";
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
  const limits = deps.limits;
  const startedAt = performance.now();
  let attempted = 0;
  let identityLost = false;
  // Bounded runs resume after the previous slice and wrap to the start, so a
  // chunk that keeps failing stays pending without blocking later chunks.
  const resumeKey = db
    ? resumeCursorKey(store.partitionId, deps.collection || undefined)
    : undefined;
  const resumeFrom =
    limits && db && resumeKey
      ? readResumeCursor(db, resumeKey, isOwnerCursor)
      : undefined;
  let after: OwnerCursor | undefined = resumeFrom;
  let wrapped = !resumeFrom;
  const saveResume = async (cursor: OwnerCursor | undefined) => {
    if (!db || !resumeKey) return;
    if (!cursor && !readResumeCursor(db, resumeKey, isOwnerCursor)) return;
    await inWriteTurn(deps.acquireWriteTurn, async () =>
      writeResumeCursor(db, resumeKey, cursor)
    );
  };
  /** True once a bound is reached while owners in scope are still pending. */
  const stopAtLimit = (): boolean => {
    if (!limits) return false;
    // A runtime change is an incomplete pass, never a limit stop.
    if (!identityStillCurrent()) return false;
    const chunksReached =
      limits.maxChunks !== undefined && attempted >= limits.maxChunks;
    const secondsReached =
      limits.maxSeconds !== undefined &&
      (performance.now() - startedAt) / 1000 >= limits.maxSeconds;
    if (!chunksReached && !secondsReached) return false;
    // A bound reached on the batch that empties the backlog is a finished
    // pass. Failed owners still count as pending work.
    return deps.force
      ? variantBacklogPage(deps, store, 1, after).length > 0
      : store.hasPending({ collection: deps.collection || undefined });
  };
  const stop = async () => {
    await saveResume(after);
    return ok({ ...total, stopped: "limit" as const });
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
      if (!identityStillCurrent()) {
        identityLost = true;
        break;
      }
      assertInferenceActive();
      let pending = variantBacklogPage(deps, store, batchSize, after);
      // After wrapping, stop where this run started.
      if (wrapped && resumeFrom)
        pending = pending.filter(
          (owner) => compareOwnerCursor(owner, resumeFrom) <= 0
        );
      if (!pending.length) {
        if (wrapped) break;
        wrapped = true;
        after = undefined;
        continue;
      }
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
        if (stopAtLimit()) return await stop();
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
      if (stopAtLimit()) return await stop();
      if (background) await Bun.sleep(0);
    }
    // A traversal that reached its end leaves nothing to resume.
    if (!identityLost) await saveResume(undefined);
    assertInferenceActive();
    // Retrieval authority was established by the first activation and search
    // validates every owner at query time, so a later pass with an intact vec0
    // mirror does not re-prove index-wide coverage (O(index) on every run).
    // A mirror that lost rows takes the full repair and activation path below.
    if (
      identityStillCurrent() &&
      store.hasActivated() &&
      store.materializationMatches()
    ) {
      assertInferenceActive();
      return ok(total);
    }
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
    return ok(identityLost ? { ...total, incomplete: true } : total);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}
