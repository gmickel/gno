import type { StoreResult } from "../store/types";
import type { VectorOwnerInput } from "../store/vector/types";
import type { VectorVariantStore } from "../store/vector/variants";
import type { EmbedBacklogDeps, EmbedBacklogResult } from "./backlog";

import { isHttpModelUri } from "../llm/httpEmbedding";
import {
  assertInferenceActive,
  isBackgroundInference,
  withInferencePage,
} from "../llm/inference-scope";
import { err, ok } from "../store/types";
import { getVectorStatsDatabase } from "../store/vector/stats";
import { embedTextsWithRecovery } from "./batch";
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
import {
  commitVariantBatch,
  embedVariantBatch,
  type PreparedVariantBatch,
  prepareVariantBatch,
  type VariantBatchOutcome,
} from "./variant-retry";

const DEFAULT_FOREGROUND_BATCH_SIZE = 64;
const HTTP_EMBED_MAX_CONCURRENCY = 3;

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
    : (deps.batchSize ?? DEFAULT_FOREGROUND_BATCH_SIZE);
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
  const handleForegroundOutcome = async (
    ownersCount: number,
    outcome: VariantBatchOutcome
  ): Promise<boolean> => {
    if (outcome.deferred) return true;
    if (!identityHolds()) {
      total.errors += Math.max(
        0,
        ownersCount -
          outcome.embedded -
          outcome.errors -
          outcome.contentionErrors -
          outcome.retryOwners.length
      );
    }
    total.embedded += outcome.embedded;
    total.errors += outcome.errors;
    total.contentionErrors += outcome.contentionErrors;
    if (outcome.retryOwners.length && !limitReached()) {
      const retrying = outcome.retryOwners.length;
      const retryResult = await embedVariantBatch({
        store,
        embedPort: deps.embedPort,
        owners: outcome.retryOwners,
        identityStillCurrent,
        force: deps.force,
        onSubmit,
      });
      total.embedded += retryResult.embedded;
      total.errors += retryResult.errors + retryResult.retryOwners.length;
      total.contentionErrors += retryResult.contentionErrors;
      if (!identityHolds())
        total.errors += Math.max(
          0,
          retrying -
            retryResult.embedded -
            retryResult.errors -
            retryResult.contentionErrors -
            retryResult.retryOwners.length
        );
    } else {
      total.errors += outcome.retryOwners.length;
    }
    deps.onProgress?.(total.embedded, total.errors);
    return false;
  };

  try {
    const canPipelineForeground =
      !background && !deps.acquireWriteTurn && !limits;
    const isHttpPort = isHttpModelUri(deps.modelUri);

    if (canPipelineForeground && isHttpPort) {
      // Bounded concurrent in-flight HTTP batches (up to HTTP_EMBED_MAX_CONCURRENCY)
      // with in-flight inputHash deduplication across the active window.
      type HttpInFlight = {
        owners: VectorOwnerInput[];
        prepared: PreparedVariantBatch;
        keys: string[];
        dependentHashes: string[];
        endCursor: OwnerCursor;
        promise: ReturnType<typeof embedTextsWithRecovery>;
      };
      const inFlight: HttpInFlight[] = [];
      const inFlightHashes = new Set<string>();
      // Retain completed vectors ONLY while at least one queued page depends on
      // them; evict each hash as soon as its last dependent page commits.
      const queuedDependentCount = new Map<string, number>();
      const completedVectors = new Map<string, Float32Array>();
      let exhausted = false;

      const fillWindow = async (): Promise<void> => {
        while (!exhausted && inFlight.length < HTTP_EMBED_MAX_CONCURRENCY) {
          if (!(await identityCurrent())) {
            identityLost = true;
            exhausted = true;
            return;
          }
          assertInferenceActive();
          const pending = variantBacklogPage(deps, store, batchSize, after);
          if (!pending.length) {
            exhausted = true;
            return;
          }
          const last = pending.at(-1)!;
          const endCursor: OwnerCursor = {
            documentId: last.documentId,
            seq: last.seq,
          };
          after = endCursor;
          const prepared = prepareVariantBatch({
            store,
            owners: pending,
            force: deps.force,
            inFlightHashes,
          });
          const dependentHashes: string[] = [];
          for (const [hash] of prepared.sharedFromInFlight) {
            dependentHashes.push(hash);
            queuedDependentCount.set(
              hash,
              (queuedDependentCount.get(hash) ?? 0) + 1
            );
          }
          const keys = [...prepared.inputs.keys()];
          for (const key of keys) inFlightHashes.add(key);
          const promise = embedTextsWithRecovery(
            deps.embedPort,
            [...prepared.inputs.values()],
            { onSubmit }
          );
          inFlight.push({
            owners: pending,
            prepared,
            keys,
            dependentHashes,
            endCursor,
            promise,
          });
        }
      };

      await fillWindow();
      while (inFlight.length > 0) {
        const entry = inFlight.shift()!;
        const result = await entry.promise;
        for (const key of entry.keys) inFlightHashes.delete(key);

        if (!identityHolds()) {
          await Promise.allSettled(inFlight.map((item) => item.promise));
          inFlight.length = 0;
          inFlightHashes.clear();
          completedVectors.clear();
          queuedDependentCount.clear();
          total.errors += entry.owners.length;
          deps.onProgress?.(total.embedded, total.errors);
          if (!(await identityCurrent())) {
            identityLost = true;
            break;
          }
          // Reloaded identity: rewind cursor to end of the failed batch so
          // discarded in-flight pages are re-fetched cleanly and traversal
          // continues across the rest of the backlog.
          after = entry.endCursor;
          exhausted = false;
          await fillWindow();
          continue;
        }

        const vectors = new Map<string, Float32Array>();
        if (result.ok) {
          for (const [index, key] of entry.keys.entries()) {
            const vec = result.value.vectors[index];
            if (vec) {
              const typed = new Float32Array(vec);
              vectors.set(key, typed);
              if ((queuedDependentCount.get(key) ?? 0) > 0) {
                completedVectors.set(key, typed);
              }
            }
          }
        }
        // Attach vectors produced by earlier batches in the same window and
        // release ref-counts immediately so completedVectors stays bounded.
        for (const hash of entry.dependentHashes) {
          const shared = completedVectors.get(hash);
          if (shared && !vectors.has(hash)) {
            vectors.set(hash, shared);
          }
          const remaining = (queuedDependentCount.get(hash) ?? 1) - 1;
          if (remaining <= 0) {
            queuedDependentCount.delete(hash);
            completedVectors.delete(hash);
          } else {
            queuedDependentCount.set(hash, remaining);
          }
        }
        const outcome = await commitVariantBatch({
          store,
          owners: entry.prepared.owners,
          reusable: entry.prepared.reusable,
          vectors,
          identityStillCurrent,
        });
        await handleForegroundOutcome(entry.owners.length, outcome);
        await fillWindow();
      }
    } else if (canPipelineForeground) {
      // Double-buffered foreground native embedding: overlap SQLite commit of
      // page k-1 + prefetch/format of page k+1 with worker inference of page k.
      interface PreparedPage {
        owners: VectorOwnerInput[];
        prepared: PreparedVariantBatch;
        carriedVectors: Map<string, Float32Array>;
        endCursor: OwnerCursor;
      }

      const fetchPreparedPage = (
        inFlightHashes?: ReadonlySet<string>
      ): PreparedPage | null => {
        assertInferenceActive();
        const pending = variantBacklogPage(deps, store, batchSize, after);
        if (!pending.length) return null;
        const last = pending.at(-1)!;
        const endCursor: OwnerCursor = {
          documentId: last.documentId,
          seq: last.seq,
        };
        after = endCursor;
        const prepared = prepareVariantBatch({
          store,
          owners: pending,
          force: deps.force,
          inFlightHashes,
        });
        return {
          owners: pending,
          prepared,
          carriedVectors: new Map<string, Float32Array>(),
          endCursor,
        };
      };

      const mergeCarriedVectors = (
        page: PreparedPage,
        inferred: Map<string, Float32Array>
      ): Map<string, Float32Array> => {
        if (page.carriedVectors.size === 0) return inferred;
        for (const [hash, vec] of page.carriedVectors) {
          if (!inferred.has(hash)) inferred.set(hash, vec);
        }
        return inferred;
      };

      const handoffSharedVectors = (
        sourceVectors: ReadonlyMap<string, Float32Array>,
        targetPage: PreparedPage | null
      ): void => {
        if (!targetPage) return;
        for (const [hash, formatted] of targetPage.prepared
          .sharedFromInFlight) {
          const vec = sourceVectors.get(hash);
          if (vec) {
            // Carry the actual vector bytes instead of marking reusable before
            // SQLite commits page k (page k's producer owners might go stale).
            targetPage.carriedVectors.set(hash, vec);
          } else {
            targetPage.prepared.inputs.set(hash, formatted);
          }
        }
        targetPage.prepared.sharedFromInFlight.clear();
      };

      if (!(await identityCurrent())) {
        identityLost = true;
      } else {
        let currentPage = fetchPreparedPage();
        while (currentPage) {
          const keys = [...currentPage.prepared.inputs.keys()];
          const activeHashes = new Set(keys);
          const inferencePromise = embedTextsWithRecovery(
            deps.embedPort,
            [...currentPage.prepared.inputs.values()],
            { onSubmit }
          );

          // While child worker runs inference for page k, prefetch and format page k+1.
          const nextPage = fetchPreparedPage(activeHashes);

          const result = await inferencePromise;
          if (!identityHolds()) {
            total.errors += currentPage.owners.length;
            deps.onProgress?.(total.embedded, total.errors);
            if (!(await identityCurrent())) {
              identityLost = true;
              break;
            }
            // Reloaded identity: rewind cursor to end of failed page so
            // prefetched page k+1 is re-fetched cleanly with no skipped owners.
            after = currentPage.endCursor;
            currentPage = fetchPreparedPage();
            continue;
          }

          const vectors = new Map<string, Float32Array>();
          if (result.ok) {
            for (const [index, key] of keys.entries()) {
              const vec = result.value.vectors[index];
              if (vec) vectors.set(key, new Float32Array(vec));
            }
          }
          mergeCarriedVectors(currentPage, vectors);
          handoffSharedVectors(vectors, nextPage);

          // Launch page k+1's worker inference BEFORE committing page k to SQLite
          // so SQLite commit of page k overlaps with worker inference of page k+1!
          if (!nextPage) {
            const outcome = await commitVariantBatch({
              store,
              owners: currentPage.prepared.owners,
              reusable: currentPage.prepared.reusable,
              vectors,
              identityStillCurrent,
            });
            await handleForegroundOutcome(currentPage.owners.length, outcome);
            break;
          }

          // Commit page k and continue the loop with page k+1 already started.
          // When page k has retryOwners, finish page k's retry after page k+1's
          // inference completes so only one worker inference runs at a time.
          let pendingCommit: {
            ownersCount: number;
            prepared: PreparedVariantBatch;
            vectors: Map<string, Float32Array>;
          } | null = {
            ownersCount: currentPage.owners.length,
            prepared: currentPage.prepared,
            vectors,
          };
          currentPage = nextPage;

          while (currentPage) {
            const nextKeys = [...currentPage.prepared.inputs.keys()];
            const nextActiveHashes = new Set(nextKeys);
            const nextInference = embedTextsWithRecovery(
              deps.embedPort,
              [...currentPage.prepared.inputs.values()],
              { onSubmit }
            );
            // Yield one microtask so the IPC frame is flushed before the
            // synchronous SQLite commit runs on the parent thread.
            if (nextKeys.length > 0) {
              await Promise.resolve();
            }

            // Overlapped with worker inference of currentPage:
            // 1. Commit previous page to SQLite.
            let deferredRetries: VectorOwnerInput[] = [];
            if (pendingCommit) {
              const prevOutcome = await commitVariantBatch({
                store,
                owners: pendingCommit.prepared.owners,
                reusable: pendingCommit.prepared.reusable,
                vectors: pendingCommit.vectors,
                identityStillCurrent,
              });
              total.embedded += prevOutcome.embedded;
              total.errors += prevOutcome.errors;
              total.contentionErrors += prevOutcome.contentionErrors;
              deferredRetries = prevOutcome.retryOwners;
              if (!deferredRetries.length) {
                deps.onProgress?.(total.embedded, total.errors);
              }
              pendingCommit = null;
            }

            // 2. Prefetch & prepare page k+2 while worker still runs page k+1.
            const followingPage = fetchPreparedPage(nextActiveHashes);

            // Wait for currentPage inference to complete.
            const nextResult = await nextInference;
            if (deferredRetries.length) {
              await handleForegroundOutcome(deferredRetries.length, {
                embedded: 0,
                errors: 0,
                contentionErrors: 0,
                retryOwners: deferredRetries,
              });
            }

            if (!identityHolds()) {
              total.errors += currentPage.owners.length;
              deps.onProgress?.(total.embedded, total.errors);
              if (!(await identityCurrent())) {
                identityLost = true;
                currentPage = null;
                break;
              }
              after = currentPage.endCursor;
              currentPage = fetchPreparedPage();
              break;
            }

            const nextVectors = new Map<string, Float32Array>();
            if (nextResult.ok) {
              for (const [index, key] of nextKeys.entries()) {
                const vec = nextResult.value.vectors[index];
                if (vec) nextVectors.set(key, new Float32Array(vec));
              }
            }
            mergeCarriedVectors(currentPage, nextVectors);
            handoffSharedVectors(nextVectors, followingPage);

            if (followingPage) {
              pendingCommit = {
                ownersCount: currentPage.owners.length,
                prepared: currentPage.prepared,
                vectors: nextVectors,
              };
              currentPage = followingPage;
            } else {
              const lastOutcome = await commitVariantBatch({
                store,
                owners: currentPage.prepared.owners,
                reusable: currentPage.prepared.reusable,
                vectors: nextVectors,
                identityStillCurrent,
              });
              await handleForegroundOutcome(
                currentPage.owners.length,
                lastOutcome
              );
              currentPage = null;
            }
          }
          if (identityLost) break;
        }
      }
    } else {
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
          // Time can run out while this page is read. Owners this run failed
          // are still pending, so the same check as at a batch boundary decides
          // between a stopped run and a finished traversal.
          if (pagesStarted > 0) {
            const verdict = await stopAtLimit();
            if (verdict === "limit") return await stop();
            if (verdict === "incomplete") {
              identityLost = true;
              break;
            }
          }
          if (wrapped) break;
          wrapped = true;
          after = undefined;
          continue;
        }
        // Time can run out while the page is fetched: stop before inference,
        // keeping this page eligible for the next run (the cursor stays put).
        // Every run processes at least one page, even one that submits nothing
        // or follows a runtime verification that spent the budget, so bounded
        // runs always progress.
        if (pagesStarted > 0 && limitReached()) return await stop();
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
    }
    // A traversal that reached its end leaves nothing to resume.
    if (!identityLost) await saveResume(undefined);
    assertInferenceActive();
    // Retrieval authority was established by the first activation, and
    // search validates every owner at query time, so a later pass does not
    // re-prove index-wide coverage (O(index) on every run) while the vec0
    // mirror is known to be current. A dirty mirror is rebuilt whether or not
    // other collections are still pending, and the partition is re-activated
    // when coverage is complete. Databases without mirror tracking, or without
    // sqlite-vec, keep the full check below.
    if (identityStillCurrent() && store.hasActivated()) {
      const mirror = store.mirrorState();
      const v2Mirror = store.v2MirrorState();
      const needsV2Repair = v2Mirror === "dirty" || v2Mirror === "missing";
      if (mirror === "clean" && !needsV2Repair) {
        if (v2Mirror === "clean") {
          const checkTurn = await inWriteTurn(
            deps.acquireWriteTurn,
            async () => {
              try {
                store.ensureV2RecallSelfCheck();
                return undefined;
              } catch (cause) {
                return cause instanceof Error ? cause.message : String(cause);
              }
            }
          );
          if (checkTurn.deferred) return ok({ ...total, deferred: true });
        }
        assertInferenceActive();
        return ok(total);
      }
      if (mirror === "clean" && needsV2Repair) {
        const turn = await inWriteTurn(deps.acquireWriteTurn, async () => {
          try {
            store.syncV2Index();
            return undefined;
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        });
        if (turn.deferred) return ok({ ...total, deferred: true });
        if (turn.value !== undefined)
          return ok({ ...total, syncError: turn.value });
        assertInferenceActive();
        return ok(total);
      }
      if (mirror === "dirty") {
        const repairEpoch = store.epoch();
        const turn = await inWriteTurn(deps.acquireWriteTurn, async () => {
          try {
            store.syncIndex();
            if (identityStillCurrent() && !store.hasPending())
              store.activate(repairEpoch);
            return undefined;
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        });
        if (turn.deferred) return ok({ ...total, deferred: true });
        if (turn.value !== undefined)
          return ok({ ...total, syncError: turn.value });
        assertInferenceActive();
        return ok(total);
      }
    }
    // Capture the epoch before checking completeness; activate rechecks under write lock.
    const epoch = store.epoch();
    if (identityStillCurrent() && !store.hasPending()) {
      const turn = await inWriteTurn(deps.acquireWriteTurn, async () => {
        try {
          if (!store.isActive()) store.syncIndex();
          if (identityStillCurrent()) {
            store.activate(epoch);
            store.ensureV2RecallSelfCheck();
          }
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
