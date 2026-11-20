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
  const checkIdentity = deps.identityStillCurrent;
  if (!checkIdentity)
    return err(
      "INVALID_INPUT",
      "Variant embedding requires an effective runtime identity check"
    );
  // The predicate can throw while a port is half re-initialized (its
  // dimensions are cleared); treat that as "not current" everywhere.
  const identityStillCurrent = (): boolean => {
    try {
      return checkIdentity();
    } catch {
      return false;
    }
  };
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
  // Chunks charged against --max-chunks: every text submitted to the
  // provider, adaptive recovery resubmissions included. Owners that share an
  // input or reuse a stored vector cost nothing. The limit is checked at
  // batch boundaries.
  let attempted = limits?.spent ?? 0;
  let pagesStarted = 0;
  const onSubmit = (texts: number): void => {
    attempted += texts;
  };
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
    // Advisory: a busy database must not turn a finished slice into a
    // failure. The next run then starts from the previous position.
    try {
      await inWriteTurn(deps.acquireWriteTurn, async () =>
        writeResumeCursor(db, resumeKey, cursor)
      );
    } catch {
      // Keep the receipt; resumption is best effort.
    }
  };
  const identityHolds = identityStillCurrent;
  /**
   * A failed request can drop the port's cached identity (a native worker is
   * retired). Reload it once before treating the runtime as changed, so a
   * chunk that keeps failing is a failure, not an identity change.
   */
  const identityCurrent = async (): Promise<boolean> => {
    if (identityHolds()) return true;
    if (background) return false;
    let reloaded: { ok: boolean } | undefined;
    try {
      reloaded = await deps.embedPort.init();
    } catch {
      return false;
    }
    return !!reloaded?.ok && identityHolds();
  };
  const limitReached = (): boolean =>
    !!limits &&
    ((limits.maxChunks !== undefined && attempted >= limits.maxChunks) ||
      (limits.maxSeconds !== undefined &&
        (performance.now() - startedAt) / 1000 >= limits.maxSeconds));
  /**
   * At a batch boundary: "limit" once a bound is reached while owners in
   * scope are still pending, "incomplete" when the runtime cannot be
   * re-established there (never another batch past the limit), else
   * "continue".
   */
  const stopAtLimit = async (): Promise<
    "limit" | "incomplete" | "continue"
  > => {
    if (!limitReached()) return "continue";
    // A runtime change is an incomplete pass, never a limit stop.
    if (!(await identityCurrent())) return "incomplete";
    // A bound reached on the batch that empties the backlog is a finished
    // pass. Under the CLI write lease the starting backlog minus what was
    // committed is exact (failed owners stay pending), so no scan is needed.
    const pending =
      limits?.pendingAtStart !== undefined
        ? limits.pendingAtStart - total.embedded > 0
        : // Otherwise probe: owners after the cursor first, then the first
          // pending owner from the start (including this run's failures).
          variantBacklogPage(deps, store, 1, after).length > 0 ||
          variantBacklogPage(deps, store, 1).length > 0;
    return pending ? "limit" : "continue";
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
      if (!(await identityCurrent())) {
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
      // Time can run out while the page is fetched: stop before inference,
      // keeping this page eligible for the next run (the cursor stays put).
      // Every run processes at least one page, even one that submits nothing,
      // unless runtime verification already spent the chunk budget.
      if ((pagesStarted > 0 || attempted > 0) && limitReached())
        return await stop();
      pagesStarted += 1;
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
          onSubmit,
        });
      let result = background
        ? await withInferencePage(embedPage)
        : await embedPage();
      if (!result) {
        // Past its deadline: this page stays pending for the next pass.
        total.errors += owners.length;
        deps.onProgress?.(total.embedded, total.errors);
        const verdict = await stopAtLimit();
        if (verdict === "limit") return await stop();
        if (verdict === "incomplete") {
          identityLost = true;
          break;
        }
        await Bun.sleep(0);
        continue;
      }
      if (result.deferred) return ok({ ...total, deferred: true });
      // The identity dropped during inference: the batch discarded its
      // results. Its owners stay pending and count as this run's failures
      // (the port is reloaded at the top of the loop).
      if (!identityHolds()) {
        total.errors += Math.max(
          0,
          owners.length -
            result.embedded -
            result.errors -
            result.contentionErrors -
            result.retryOwners.length
        );
      }
      total.embedded += result.embedded;
      total.errors += result.errors;
      total.contentionErrors += result.contentionErrors;
      if (background) total.errors += result.retryOwners.length;
      // A retry counts toward the limits; once they are reached, failed
      // owners stay pending for the next run instead of a further batch.
      if (!background && result.retryOwners.length && !limitReached()) {
        const retrying = result.retryOwners.length;
        result = await embedVariantBatch({
          store,
          embedPort: deps.embedPort,
          owners: result.retryOwners,
          identityStillCurrent,
          force: deps.force,
          onSubmit,
        });
        total.embedded += result.embedded;
        total.errors += result.errors + result.retryOwners.length;
        total.contentionErrors += result.contentionErrors;
        // Same accounting when the identity drops during the retry.
        if (!identityHolds())
          total.errors += Math.max(
            0,
            retrying -
              result.embedded -
              result.errors -
              result.contentionErrors -
              result.retryOwners.length
          );
      } else if (!background) {
        // Failed in this run; left pending without a retry past the limit.
        total.errors += result.retryOwners.length;
      }
      deps.onProgress?.(total.embedded, total.errors);
      const verdict = await stopAtLimit();
      if (verdict === "limit") return await stop();
      if (verdict === "incomplete") {
        identityLost = true;
        break;
      }
      if (background) await Bun.sleep(0);
    }
    // A traversal that reached its end leaves nothing to resume.
    if (!identityLost) await saveResume(undefined);
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
    return ok(identityLost ? { ...total, incomplete: true } : total);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}
