import { watch, type FSWatcher } from "node:fs";
import { join, normalize, sep } from "node:path";

import type { Collection } from "../config/types";
import type {
  CollectionSyncResult,
  SyncOptions,
  WalkConfig,
} from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";
import type { DocumentEvent, DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";

import {
  exclusionCoversSubtree,
  normalizeCollectionDirRelPath,
} from "../core/path-rules";
import {
  collectionToWalkConfig,
  defaultSyncService,
  listEligibleDirectChildren,
  listEligibleSubtreeFiles,
  matchesWalkPath,
  resolveVanishedPathDirectory,
} from "../ingestion";

export interface CollectionWatchState {
  expectedCollections: string[];
  activeCollections: string[];
  failedCollections: Array<{ collection: string; reason: string }>;
  queuedCollections: string[];
  syncingCollections: string[];
  lastEventAt: string | null;
  lastSyncAt: string | null;
}

/** Why a filesystem event could not name an eligible path directly. */
export type AmbiguousWatchEventReason = "ineligible-path" | "missing-filename";

/** Which half of a bounded reconciliation failed. */
export type ReconciliationStage = "enumerate" | "store" | "sync";

export interface CollectionWatchCallbacks {
  onSyncStart?: (event: { collection: string; relPaths: string[] }) => void;
  onSyncComplete?: (event: {
    collection: string;
    relPaths: string[];
    result: CollectionSyncResult;
  }) => void;
  onSyncError?: (event: {
    collection: string;
    relPaths: string[];
    error: unknown;
  }) => void;
  /** Fires after all watcher syncs and queued paths have settled. */
  onSettled?: () => void;
  /**
   * An event arrived that could not identify an eligible path on its own, so
   * it was treated as a hint about a changed directory (or dropped outright,
   * for a `null`/unusable filename). `directory` is the normalized
   * collection-relative directory the hint was attributed to - `""` is the
   * collection root - and `null` when no directory could be derived.
   *
   * Additive and optional: existing consumers compile unchanged.
   */
  onAmbiguousEvent?: (event: {
    collection: string;
    directory: string | null;
    reason: AmbiguousWatchEventReason;
  }) => void;
  /** A bounded reconciliation of one directory is about to run. */
  onReconcileStart?: (event: { collection: string; directory: string }) => void;
  /**
   * A directory reconciled successfully. `candidateCount` is what the disk and
   * indexed sides produced for this directory; `syncedCount` is how many of
   * those survived the live-rules recheck and reached the `syncPaths` batch.
   */
  onReconcileComplete?: (event: {
    collection: string;
    directory: string;
    candidateCount: number;
    syncedCount: number;
  }) => void;
  /** A reconciliation stage failed. Nothing is inferred from a failed stage. */
  onReconcileFailed?: (event: {
    collection: string;
    directory: string | null;
    stage: ReconciliationStage;
    cause: unknown;
  }) => void;
}

/**
 * The queued dirty-directory work for ONE affected directory.
 *
 * Work is keyed by affected directory - the directory portion of the reported
 * path - so repeated events inside one directory collapse into one unit of work
 * no matter how many distinct filenames they name.
 *
 * `hints` keeps the reported paths themselves as candidate directories, which
 * is what makes R12 work: a recursive delete reports only the bare directory
 * (`dir1`), and its indexed documents are direct children of THAT path, not of
 * its parent. Resolution order is unchanged - a hint resolves first, and the
 * affected directory is the fallback when the hint yields nothing.
 *
 * `hints` is deliberately UNBOUNDED. An earlier revision capped it, which was
 * the wrong lever: at queue time a dead temp name and a recursively deleted
 * directory are the same thing - a name that no longer exists - so a cap that
 * drops "probably a temp file" can drop the one hint that was a deletion, and
 * R12 fails outright with no signal. What made a cap tempting was the per-hint
 * COST, and that is now gone: the whole hint set is discriminated in ONE
 * batched store lookup per flush, and the disk is enumerated only for hints
 * that the indexed side proved are real directories. What remains is a Set of
 * short strings living for at most one window - and a window is bounded in TIME
 * rather than in entries: the debounce re-arms only up to `MAX_FLUSH_DELAY_MS`
 * from its first event, so sustained churn drains the set on that ceiling
 * instead of growing it for as long as the churn lasts. That bound is the right
 * lever precisely because it is content-blind: unlike a size cap it cannot
 * choose to drop the one hint that was a deletion.
 *
 * Only the root is stamped at queue time. Resolution is ALWAYS performed
 * against the current collection configuration, so a generation stamp would
 * change nothing about filters, patterns, or sync options; a changed ROOT is
 * the one drift that makes the queued area meaningless rather than stale.
 */
/**
 * One queued EXACT path, carrying what was observed when its event arrived.
 *
 * Both fields are decided ONCE, in the watch callback, and are never re-derived
 * at flush time. That is the whole point of the structure: the flush runs at
 * least one debounce window later, behind any sync already in flight, and after
 * an awaited classification, so a later wall clock describes a different moment
 * than the one the event happened in.
 */
/**
 * One observation of the filesystem, carrying the two DIFFERENT things a
 * watcher event needs to be judged by.
 *
 * `atMs` is a wall-clock reading and answers only diagnostic questions - what
 * `lastEventAt` publishes, and how long suppression history must be retained.
 * `seq` is this service's causal order: a strictly increasing counter drawn by
 * every event AND by every `suppress()` call, so "did this event happen before
 * that suppression window opened" has an exact answer.
 *
 * They are held apart because one `number` cannot do both jobs. Epoch
 * milliseconds are too coarse to order an event against a `suppress()` call
 * made in the same millisecond, and membership answered as `startMs <= atMs`
 * therefore let a window opened microseconds AFTER an event suppress it
 * retroactively - the precise defect interval membership was introduced to
 * remove, surviving at millisecond scale (R4). A monotonic counter has no such
 * boundary: it is incremented by the very calls whose order is in question.
 */
interface Observation {
  /** Position in this service's total causal order (events and `suppress()`). */
  seq: number;
  /** `Date.now()` when the observation was made. Diagnostics only. */
  atMs: number;
}

/** The later of two optional observations, by causal order. */
function laterObservation(
  a: Observation | null,
  b: Observation | null
): Observation | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return a.seq >= b.seq ? a : b;
}

interface PendingPathEntry {
  /**
   * The most recent observation for this path taken OUTSIDE its
   * application-write suppression window, or `null` if every event naming it
   * was suppressed.
   *
   * Recognizing suppression in the callback and then re-deciding it at flush
   * time against a fresh `Date.now()` is not the same rule: a 300 ms debounce,
   * a queued flush waiting on an in-flight sync, or a slow classification can
   * all outlast a short suppression window, and the surviving application write
   * then reached `syncPaths` after all - the exact feedback loop suppression
   * exists to prevent, and a REGRESSION against the receipt-time drop it
   * replaced. The disk is still consulted, but only for the one question it can
   * answer: did this path survive or vanish (R4).
   */
  unsuppressed: Observation | null;
  /**
   * The most recent SUPPRESSED observation for this path, or `null` if none was
   * suppressed.
   *
   * Held apart from `unsuppressed` rather than folded into one "latest
   * observation" because the two answer different questions and only one of
   * them can be published. A single `max()` timestamp beside an independent
   * `suppressed` flag described neither observation: an unsuppressed event at
   * `t1` followed by a suppressed one at `t2` kept the entry (correctly, on the
   * strength of `t1`) and then published `t2` - the timestamp of the
   * observation the callback deliberately dropped (R7). A suppressed
   * observation is promoted only when the work is retained BECAUSE the path
   * vanished, which is exactly the case where no unsuppressed observation
   * exists (see `eligibleObservationOf`).
   */
  suppressed: Observation | null;
}

/**
 * The observation that makes a queued exact path ELIGIBLE for the batch.
 *
 * An unsuppressed observation always wins: it is the event that earned the
 * path its place, whatever a later suppressed event said. A wholly suppressed
 * path is retained only when the disk proves it VANISHED, and then its
 * suppressed observation is the only one there is.
 */
function eligibleObservationOf(pending: PendingPathEntry): Observation {
  const eligible = pending.unsuppressed ?? pending.suppressed;
  // Every queued entry is created from at least one observation, so this is
  // unreachable; the neutral value keeps the type total rather than throwing
  // inside a flush.
  return eligible ?? { seq: -1, atMs: 0 };
}

/** Was every event naming this path taken inside its suppression window? */
function isFullySuppressed(pending: PendingPathEntry): boolean {
  return pending.unsuppressed === null;
}

/**
 * One window during which a path was a known application-originated write:
 * open at causal position `startSeq`, closed at wall-clock `endMs`.
 *
 * The two ends are deliberately measured in different units, because they
 * answer different questions. The START is what makes suppression answerable AT
 * EVENT TIME - an expiry alone, the shape this replaced, records no beginning
 * and no history, so `suppress()` called AFTER an event still compared as
 * "greater than" that earlier event's timestamp and retroactively suppressed
 * it, permanently. That comparison must be exact, so the start is recorded in
 * the causal order both events and `suppress()` calls draw from, not in
 * milliseconds that cannot separate them. The END is a genuine wall-clock
 * duration (`suppress(path, 5_000)`) and stays in milliseconds.
 *
 * Reconciliation candidates are the population that cannot avoid asking late:
 * they are unknown until the directory is enumerated, so their suppression
 * question is necessarily asked after the event that produced them (R4).
 */
interface SuppressionInterval {
  startSeq: number;
  endMs: number;
}

/**
 * Per-path suppression history is bounded twice over - by reclamation (see
 * `#reclaimSuppressionHistory`) and, for the pathological case where nothing
 * can be reclaimed, by this hard cap.
 *
 * Overflow merges the two OLDEST intervals into their SPAN, which can only
 * widen suppression over a gap in which the path was not in fact suppressed.
 * That is the fail-closed direction this module already takes everywhere else:
 * an unproven path stays suppressed rather than being re-synced.
 */
const MAX_SUPPRESSION_INTERVALS = 16;

/** Quiet period a collection must see before its queued work flushes. */
const FLUSH_DEBOUNCE_MS = 300;

/**
 * Hard ceiling on how long queued work may be held by the debounce, measured
 * from the FIRST event of the window.
 *
 * The debounce coalesces; it must not be able to starve. A process emitting a
 * unique name faster than `FLUSH_DEBOUNCE_MS` re-arms the timer forever, and
 * without a ceiling the eligible edits queued beside that churn are never
 * synced - not late, never - while the queues grow for as long as it lasts.
 *
 * `2000` is roughly seven debounce windows. It is chosen to be far longer than
 * any human-scale burst (a save, a formatter pass, a small checkout all settle
 * inside one window and still coalesce into exactly one batch, unchanged by
 * this ceiling), and short enough that the worst case a user can provoke is
 * two seconds of staleness rather than unbounded staleness. It also bounds
 * `DirtyDirectoryEntry.hints`, whose whole argument for being uncapped is that
 * it lives for one short window: under sustained churn the set now drains
 * every 2 s instead of growing for the duration of the churn. Under that same
 * churn the store cost stays amortized - one batched round trip per seam per
 * ceiling, not one per event.
 */
const MAX_FLUSH_DELAY_MS = 2000;

/**
 * Elapsed milliseconds from a source that only ever moves FORWARD.
 *
 * The ceiling above is a promise about how long queued work can wait, so it may
 * not be measured with `Date.now()`: a wall clock steps (NTP correction, a
 * manual change, a laptop resuming), and a backward step makes every event of a
 * churning window recompute a LARGER `deadline - now` and re-arm the full
 * debounce again - for as long as it takes the wall clock to catch up. The
 * "hard ceiling" would then be exactly as hard as the clock is well-behaved,
 * which is the property it exists to not depend on. Wall-clock readings stay
 * where they belong: `Observation.atMs`, `lastEventAt`, and the suppression
 * window ends, all of which are reported or compared against externally
 * supplied durations.
 *
 * This is deliberately NOT the monotonic source `Observation.seq` draws from,
 * even though both exist for the same class of bug. That one is a unit-less
 * causal counter answering "which of these two calls happened first"; this one
 * has to answer "how many milliseconds have passed", and a counter incremented
 * per event cannot. Folding them together would mean either giving the counter
 * a duration it does not have, or making a 2 s deadline depend on event
 * arrival - so they stay two sources with one lesson.
 */
function monotonicNowMs(): number {
  return performance.now();
}

/**
 * Observation witnesses retained per reconciliation KEY for the suppression
 * rule.
 *
 * The cap only bites when a continuous event stream keeps re-arming the
 * debounce timer for more than this many events against one key; overflow keeps
 * the EARLIEST witnesses, which can only make "suppressed at every contributing
 * observation" easier to satisfy - the same fail-closed direction as the
 * interval cap. `latestAtMs` is carried alongside the capped set and is never
 * dropped, so `lastEventAt` stays exact regardless.
 */
const MAX_DIRECTORY_OBSERVATIONS = 256;

/**
 * The witnesses for ONE reconciliation key, plus the latest moment that key was
 * observed.
 *
 * Both halves are needed and neither substitutes for the other. The SET is what
 * the suppression rule consults - a candidate is dropped only when it was
 * suppressed at EVERY witness - so it must not collapse to a maximum. The
 * `latestAtMs` is what `lastEventAt` may publish, and it must survive the
 * witness cap: derived from the capped set instead, a stream longer than
 * `MAX_DIRECTORY_OBSERVATIONS` published the moment of the LAST RETAINED
 * witness rather than the latest observation actually accepted (R7).
 */
interface ObservationSet {
  /** Capped suppression witnesses. Identity is `Observation.seq`. */
  witnesses: Set<Observation>;
  /** The latest observation accepted for this key, never dropped by the cap. */
  latestAtMs: number;
}

function newObservationSet(observation: Observation): ObservationSet {
  return { witnesses: new Set([observation]), latestAtMs: observation.atMs };
}

interface DirtyDirectoryEntry {
  /** `normalize(collection.path)` when the first event for this key arrived. */
  root: string;
  /**
   * EVERY contributing observation for this directory key.
   *
   * Per-key rather than per-collection because `lastEventAt` must distinguish
   * an ACCEPTED observation from a DROPPED one (R7), and a single
   * collection-wide timestamp cannot: with two directories in one window, a
   * later event that reconciles to nothing overwrote the earlier one, and the
   * first directory's real work then published the DROPPED event's timestamp.
   * The observations travel with the work, so only work that reaches the batch
   * can promote one.
   *
   * The set, not the maximum, is what the suppression rule needs. A resolved
   * candidate is dropped only when it was suppressed at EVERY observation that
   * asked for this directory - the same `a && b` rule an exact path gets from
   * `PendingPathEntry` - because a single coalesced `max()` silently discarded
   * the earlier observation at which the path was demonstrably NOT an
   * application write (R4).
   */
  observations: ObservationSet;
  /**
   * Reported paths under this directory, as candidate directories, each with
   * the observations that named THAT hint.
   *
   * Witnesses are per hint, not per entry, because the suppression rule is
   * asked per RECONCILIATION KEY and a hint is a key of its own. Sharing the
   * entry's whole witness set made an event naming sibling hint `b` count as
   * evidence about candidates under hint `a`: two suppressed `a` observations
   * with one unsuppressed `b` observation between them left `a`'s witness set
   * containing an instant at which `a/doc.md` was demonstrably not suppressed,
   * so GNO's own surviving write was fed back into `syncPaths` - exactly the
   * per-observation `a && b` rule this structure exists to enforce (R4).
   */
  hints: Map<string, ObservationSet>;
  /**
   * This directory was OBSERVED missing on disk when the event was classified,
   * so its whole indexed subtree is implicated - not just its direct children.
   *
   * Carried on the queue rather than re-derived at enumeration time on purpose.
   * Between classification and enumeration the directory can be RECREATED (an
   * editor that deletes and rewrites a tree, a checkout, a restore), and a
   * second filesystem observation would then quietly narrow a subtree removal
   * back to direct children, stranding everything nested below it. The
   * classification is the intent; the later enumeration only supplies the disk
   * side of the union. Nothing unsafe follows from keeping it: every candidate
   * still goes through `syncPaths`, which stats each path and reactivates the
   * ones that came back.
   */
  subtree: boolean;
}

/**
 * Everything reconciling ONE directory needs, resolved by the flush.
 *
 * Grouped rather than passed positionally because these fields are invariants
 * of a single piece of work: `observations` and `observedAtMs` are the two
 * halves of the same `ObservationSet`, and `subtreeIntent` belongs to
 * `directory`. Threaded as seven positional arguments they were easy to split
 * accidentally.
 */
interface ReconciliationWork {
  directory: string;
  /** Pre-resolved active indexed direct children for `directory`. */
  indexed: StoreResult<string[]>;
  descendantsFor: (directory: string) => Promise<StoreResult<string[]> | null>;
  /** The removal was established at classification time, before enumeration. */
  subtreeIntent: boolean;
  /** Every observation that asked for this directory (the suppression rule). */
  observations: ReadonlySet<Observation>;
  /**
   * The latest observation accepted for this directory (what `lastEventAt` may
   * publish) - carried from `ObservationSet.latestAtMs`, NOT re-derived from
   * the capped witness set.
   */
  observedAtMs: number;
}

/** Outcome of reconciling one directory. */
interface DirectoryReconciliation {
  directory: string;
  candidates: string[];
  /**
   * The observation time of the queued work that asked for this
   * reconciliation. Promoted to `lastEventAt` only if this reconciliation
   * actually contributed a path to the final batch.
   */
  observedAtMs: number;
  /**
   * The disk enumeration itself failed (unreadable directory). Distinct from a
   * store failure: an unreadable directory must not be re-interpreted as its
   * parent's problem, while a store failure still allows the parent fallback
   * because no deactivation is ever inferred from a failed store query.
   */
  enumerationFailed: boolean;
  /**
   * `#reconcileDirectory` ran for this directory, so `onReconcileStart` was
   * emitted and it owes EXACTLY ONE terminal outcome (R7). A directory the
   * current rules reject is never started and owes nothing.
   */
  started: boolean;
  /**
   * A terminal `onReconcileFailed` was already emitted for this directory
   * (enumerate or store stage). It must not also be reported as completed, and
   * a later sync-stage failure must not report it twice.
   */
  failureReported: boolean;
}

/**
 * Record one observation against an observation set.
 *
 * `latestAtMs` always advances; the witness set advances only while it has
 * room (see `MAX_DIRECTORY_OBSERVATIONS`).
 */
function recordObservation(
  set: ObservationSet,
  observation: Observation
): void {
  set.latestAtMs = Math.max(set.latestAtMs, observation.atMs);
  if (set.witnesses.size < MAX_DIRECTORY_OBSERVATIONS) {
    set.witnesses.add(observation);
  }
}

/** Fold every witness of `source` into `target`, under the same cap. */
function mergeObservations(target: ObservationSet, source: ObservationSet) {
  target.latestAtMs = Math.max(target.latestAtMs, source.latestAtMs);
  for (const witness of source.witnesses) {
    if (target.witnesses.size >= MAX_DIRECTORY_OBSERVATIONS) {
      break;
    }
    target.witnesses.add(witness);
  }
}

/** The earliest observation held anywhere in an observation set. */
function oldestObservationMsOf(set: ObservationSet): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const witness of set.witnesses) {
    if (witness.atMs < oldest) {
      oldest = witness.atMs;
    }
  }
  return oldest;
}

/**
 * The earliest observation in a batch a flush has just drained.
 *
 * `Date.now()` when the batch carries none, which is the correct neutral value:
 * an empty batch can consult nothing older than the present.
 */
function oldestDrainedObservationMs(
  exactPaths: ReadonlyMap<string, PendingPathEntry>,
  dirtyEntries: ReadonlyArray<[string, DirtyDirectoryEntry]>
): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const pending of exactPaths.values()) {
    for (const observation of [pending.unsuppressed, pending.suppressed]) {
      if (observation !== null && observation.atMs < oldest) {
        oldest = observation.atMs;
      }
    }
  }
  for (const [, entry] of dirtyEntries) {
    oldest = Math.min(oldest, oldestObservationMsOf(entry.observations));
    for (const hintObservations of entry.hints.values()) {
      oldest = Math.min(oldest, oldestObservationMsOf(hintObservations));
    }
  }
  return Number.isFinite(oldest) ? oldest : Date.now();
}

/** The directory portion of a normalized collection-relative path. */
function parentDirectoryOf(relPath: string): string {
  const lastSlash = relPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : relPath.slice(0, lastSlash);
}

interface CollectionWatchServiceOptions {
  collections: Collection[];
  store: SqliteAdapter;
  scheduler: EmbedScheduler | null;
  eventBus?: DocumentEventBus | null;
  callbacks?: CollectionWatchCallbacks;
  syncOptions?: SyncOptions;
  watchFactory?: typeof watch;
  /**
   * Seam for the flush-time classification `stat` of a reported exact path,
   * defaulting to the real filesystem implementation. Injected for the same
   * reason as `watchFactory`: the classification is an `await` inside the
   * flush, and drift behavior in that window is only testable if a test can
   * act at exactly that point.
   */
  resolveVanishedPath?: typeof resolveVanishedPathDirectory;
}

function watcherCollectionFingerprint(
  collection: Collection,
  syncOptions: SyncOptions
): string {
  return JSON.stringify({
    path: normalize(collection.path),
    pattern: collection.pattern,
    include: collection.include,
    exclude: collection.exclude,
    languageHint: collection.languageHint ?? null,
    recordAdapters: collection.recordAdapters ?? null,
    limits: syncOptions.limits ?? null,
    concurrency: syncOptions.concurrency ?? null,
    contentTypeRules: syncOptions.contentTypeRules ?? null,
    contentTypeRulesFingerprint:
      syncOptions.contentTypeRulesFingerprint ?? null,
    projectTypedEdges: syncOptions.projectTypedEdges ?? null,
  });
}

function changedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  if (result.files) {
    return result.files
      .filter((file) => file.status === "added" || file.status === "updated")
      .map((file) => file.relPath);
  }
  return result.filesAdded + result.filesUpdated + result.filesMarkedInactive >
    0
    ? fallbackPaths
    : [];
}

/**
 * Which contributed paths a resolved sync actually failed on.
 *
 * `files` is the authoritative per-path record and is what `syncPaths` always
 * returns; `errors` carries the typed-edge projection failures, which name a
 * `relPath` too. When a result reports failures with NO per-path detail
 * (`files` omitted, `filesErrored > 0`), the failure cannot be attributed, so
 * the caller fails closed and treats every contributing directory as failed
 * rather than claiming success it cannot evidence.
 *
 * The presence of `files` is NOT on its own evidence that every reported
 * failure is attributable. `syncPaths` reports collection-level failures under
 * synthetic relPaths that name no file at all - `"(typed edge backfill)"`,
 * `"(typed edge projection)"` - and the typed-edge projection can also fail
 * against a BACKLINK document that was never in this batch. None of those
 * matches a reconciliation candidate, so treating them as attributable let
 * every contributing directory report a clean completion while the sync had in
 * fact failed at the collection level. Any error path the batch does not OWN is
 * therefore global: attribution collapses and every contributing directory
 * fails closed, which is the same conservative rule already applied when
 * `files` is missing.
 *
 * The UNOWNED failures are returned alongside that verdict, because the
 * fail-closed OUTCOME and the reported CAUSE are different obligations. Naming
 * the contributed paths in the cause of an unattributable failure asserts
 * something the result does not support - those paths may well have synced
 * fine, and the real failure was `"(typed edge backfill)"` or a backlink
 * document that was never in this batch. A diagnostic that points at the wrong
 * paths is a production-diagnostics defect in its own right (R7).
 */
interface SyncErrorAttribution {
  paths: ReadonlySet<string>;
  attributable: boolean;
  /** Reported failures that no batched path owns - what collapsed attribution. */
  unowned: Array<{ relPath: string; message?: string }>;
  /** Failures reported with NO per-path detail at all (`files` omitted). */
  undetailedCount: number;
}

function syncErrorAttribution(
  result: CollectionSyncResult,
  batched: ReadonlySet<string>
): SyncErrorAttribution {
  const paths = new Set<string>();
  const unowned: Array<{ relPath: string; message?: string }> = [];
  const record = (relPath: string, message?: string): void => {
    paths.add(relPath);
    if (!batched.has(relPath)) {
      unowned.push(message === undefined ? { relPath } : { relPath, message });
    }
  };
  for (const error of result.errors) {
    record(error.relPath, error.message);
  }
  if (result.files) {
    for (const file of result.files) {
      if (file.status === "error") {
        record(file.relPath);
      }
    }
    return {
      paths,
      attributable: unowned.length === 0,
      unowned,
      undetailedCount: 0,
    };
  }
  const undetailedCount = result.filesErrored;
  return {
    paths,
    attributable: undetailedCount === 0 && unowned.length === 0,
    unowned,
    undetailedCount,
  };
}

/**
 * How many values a cause summary names before it truncates.
 *
 * A reader diagnosing a collection-level failure needs the SHAPE of it and a
 * couple of examples; the full list is neither readable in a log line nor
 * affordable to build. Typed-edge projection can report several failures per
 * document, so an unbounded list scaled with the failure it was describing.
 */
const MAX_DESCRIBED_FAILURES = 3;

/**
 * How long any ONE named FIELD may be before it is elided.
 *
 * The count/sample bound alone still lets a single pathological value - a deep
 * path, or a store error that echoes a whole query back - carry an unbounded
 * diagnostic. Both halves of a cause draw their values from the same untrusted
 * places, so every field gets its own copy of this ceiling: a fragment that
 * names both a path and a message reserves the budget twice rather than sharing
 * one, which keeps either field from crowding the other out.
 *
 * Exported so tests can assert against the real budget instead of a duplicate
 * that can drift away from it.
 */
export const MAX_DESCRIBED_VALUE_LENGTH = 200;

/**
 * Cut ONE untrusted value down to its own budget.
 *
 * Called on the RAW value, never on an interpolated string: a store error that
 * echoes a multi-megabyte query back must never be materialized inside a larger
 * string first and sliced afterwards. Truncating after interpolation bounds only
 * the RESULT, while the intermediate still scales with the failure - which is
 * the amplification the bound exists to stop, arriving during exactly the
 * cascading store failure the cause is describing (R7/R9).
 */
function boundValue(value: string): string {
  return value.length > MAX_DESCRIBED_VALUE_LENGTH
    ? `${value.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...`
    : value;
}

/**
 * Join already-bounded fragments and state exactly how many were elided.
 *
 * Takes fragments rather than values so no caller can hand it something
 * unbounded: every composition step downstream of here is constant-size.
 */
function joinBoundedSample(total: number, fragments: string[]): string {
  const truncated = total - fragments.length;
  const suffix = truncated > 0 ? ` (+${truncated} more)` : "";
  return `${fragments.join("; ")}${suffix}`;
}

/**
 * Bounded sample of relative paths: at most `MAX_DESCRIBED_FAILURES` of them,
 * each cut to `MAX_DESCRIBED_VALUE_LENGTH` before it is composed, plus an exact
 * count of the remainder.
 *
 * Slicing the sample first means a result with thousands of failed paths never
 * touches more than three of them.
 */
function describeBoundedPaths(relPaths: readonly string[]): string {
  return joinBoundedSample(
    relPaths.length,
    relPaths.slice(0, MAX_DESCRIBED_FAILURES).map(boundValue)
  );
}

/**
 * Bounded sample of failures, where the path and the message are DISTINCT
 * untrusted fields and each gets its own reserved budget.
 *
 * A single generic renderer could not do this: it had to produce the whole
 * `path: message` string before anything could be truncated, so the work was
 * unbounded even though the output was not. Reserving a per-field budget also
 * keeps a pathological path from crowding the message out of the diagnostic
 * entirely - both fields survive, both bounded.
 */
function describeBoundedFailures(
  failures: readonly { relPath: string; message?: string }[]
): string {
  return joinBoundedSample(
    failures.length,
    failures
      .slice(0, MAX_DESCRIBED_FAILURES)
      .map((failure) =>
        failure.message === undefined
          ? boundValue(failure.relPath)
          : `${boundValue(failure.relPath)}: ${boundValue(failure.message)}`
      )
  );
}

/**
 * How to describe a collection-level failure that no batched path owns.
 *
 * Deliberately names the ERRORS rather than the contributed paths: the whole
 * point of the unattributable branch is that the sync gave no evidence about
 * which contributed path, if any, failed.
 *
 * Built ONCE per sync result, never per directory. The summary describes the
 * RESULT, which every contributing directory shares, so formatting it inside
 * the per-directory loop did `O(directories x errors)` string construction for
 * one constant string - and did it even when no diagnostic observer was
 * installed to read it. A broad projection failure across a large
 * reconciliation is already a bad downstream failure; the diagnostic must not
 * amplify it (R7/R9).
 */
function unattributableCauseDetail(attribution: SyncErrorAttribution): string {
  if (attribution.unowned.length > 0) {
    const described = describeBoundedFailures(attribution.unowned);
    return `${attribution.unowned.length} collection-level failure(s) owned by no batched path: ${described}`;
  }
  return `${attribution.undetailedCount} failure(s) reported with no per-path detail`;
}

export class CollectionWatchService {
  #collections: Collection[];
  readonly #store: SqliteAdapter;
  readonly #scheduler: EmbedScheduler | null;
  readonly #eventBus: DocumentEventBus | null;
  readonly #callbacks: CollectionWatchCallbacks | null;
  #syncOptions: SyncOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #watchRoots = new Map<string, string>();
  readonly #collectionGenerations = new Map<string, number>();
  readonly #collectionFingerprints = new Map<string, string>();
  readonly #pendingByCollection = new Map<
    string,
    Map<string, PendingPathEntry>
  >();
  readonly #dirtyByCollection = new Map<
    string,
    Map<string, DirtyDirectoryEntry>
  >();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * MONOTONIC moment the CURRENT window must flush by, per collection, set when
   * the window's first event is queued and cleared when it flushes. Comparable
   * only with `monotonicNowMs()` - never with a wall-clock reading.
   *
   * Deliberately absent from `getState()`: it is a scheduling bound with no
   * observable shape of its own - every effect it has is already visible as a
   * batch arriving - and the public status schema does not change for it.
   */
  readonly #flushDeadlines = new Map<string, number>();
  readonly #syncing = new Set<string>();
  readonly #inFlightSyncs = new Set<Promise<void>>();
  /**
   * Suppression HISTORY per path - starts and ends, not a bare expiry.
   *
   * Reclaimed opportunistically against the oldest observation that could still
   * consult it (see `#reclaimSuppressionHistory`), which bounds it at one
   * retained entry per suppressed path.
   */
  readonly #suppressedPaths = new Map<string, SuppressionInterval[]>();
  /**
   * A conservative LOWER BOUND on the earliest `endMs` still stored, used as an
   * O(1) guard on the reclamation scan.
   *
   * Every write of an `endMs` lowers it, including the write that SHORTENS an
   * open interval (`suppress(path, 0)` closes a window early). Tracking only
   * the opens left it too LARGE after a shortening, and the guard then skipped
   * a scan that was in fact due - retaining a closed window until its ORIGINAL
   * expiry. Too small is the safe direction: it costs a wasted scan that
   * recomputes the exact floor, and can never skip a reclamation that was due.
   */
  #suppressionFloorEndMs = Number.POSITIVE_INFINITY;
  /**
   * The next position in this service's causal order.
   *
   * Drawn by every observation AND by every `suppress()` call, which is what
   * makes "did this event happen before that window opened" answerable without
   * relying on millisecond resolution (see `Observation`).
   */
  #nextSequence = 0;
  /**
   * Observation floors of flushes that have already DRAINED their queues.
   *
   * A drained flush still holds observations that will consult suppression
   * history - the classification and enumeration awaits sit between the drain
   * and the candidate filter - so reclamation must see them. Boxed so the
   * `finally` that removes one can find it by identity.
   */
  readonly #inFlightObservationFloors = new Set<{ floorMs: number }>();
  readonly #watchFactory: typeof watch;
  readonly #resolveVanishedPath: typeof resolveVanishedPathDirectory;
  readonly #failedCollections = new Map<string, string>();
  #nextCollectionGeneration = 0;
  #disposed = false;
  /**
   * Held as epoch milliseconds, formatted only when state is reported: every
   * observation this class compares or promotes is an event-time reading, and
   * comparing them as numbers keeps that arithmetic away from string ordering.
   */
  #lastEventAtMs: number | null = null;
  #lastSyncAt: string | null = null;

  constructor(options: CollectionWatchServiceOptions) {
    this.#collections = options.collections;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#eventBus = options.eventBus ?? null;
    this.#callbacks = options.callbacks ?? null;
    this.#syncOptions = options.syncOptions ?? {};
    this.#watchFactory = options.watchFactory ?? watch;
    this.#resolveVanishedPath =
      options.resolveVanishedPath ?? resolveVanishedPathDirectory;
  }

  start(): void {
    if (this.#disposed) {
      return;
    }
    this.updateCollections(this.#collections);
  }

  updateCollections(
    collections: Collection[],
    syncOptions?: SyncOptions
  ): void {
    if (this.#disposed) {
      return;
    }
    if (syncOptions) {
      this.#syncOptions = syncOptions;
    }
    const nextByName = new Map(
      collections.map((collection) => [collection.name, collection])
    );

    for (const [collectionName, watcher] of this.#watchers) {
      const nextCollection = nextByName.get(collectionName);
      const nextRoot = nextCollection
        ? normalize(nextCollection.path)
        : undefined;
      if (
        nextRoot === undefined ||
        nextRoot !== this.#watchRoots.get(collectionName)
      ) {
        watcher.close();
        this.#watchers.delete(collectionName);
        this.#watchRoots.delete(collectionName);
        this.#failedCollections.delete(collectionName);
        this.#pendingByCollection.delete(collectionName);
        // A removed collection or a moved root must never flush queued
        // reconciliation work against the new configuration (R6).
        this.#dirtyByCollection.delete(collectionName);
        const timer = this.#timers.get(collectionName);
        if (timer) {
          clearTimeout(timer);
          this.#timers.delete(collectionName);
        }
        // The queued work this deadline was holding a ceiling over has just
        // been discarded; the next window starts from its own first event.
        this.#flushDeadlines.delete(collectionName);
      }
    }

    for (const collectionName of this.#collectionFingerprints.keys()) {
      if (!nextByName.has(collectionName)) {
        this.#collectionFingerprints.delete(collectionName);
        this.#collectionGenerations.set(
          collectionName,
          ++this.#nextCollectionGeneration
        );
      }
    }

    this.#collections = collections;
    for (const collection of collections) {
      const fingerprint = watcherCollectionFingerprint(
        collection,
        this.#syncOptions
      );
      if (this.#collectionFingerprints.get(collection.name) !== fingerprint) {
        this.#collectionFingerprints.set(collection.name, fingerprint);
        this.#collectionGenerations.set(
          collection.name,
          ++this.#nextCollectionGeneration
        );
      }
    }

    for (const collection of this.#collections) {
      if (this.#watchers.has(collection.name)) {
        continue;
      }
      try {
        const watchedRoot = normalize(collection.path);
        const watcher = this.#watchFactory(
          collection.path,
          { recursive: true },
          (_eventType, filename) => {
            if (this.#disposed) return;
            // A `null`/empty filename (Bun queue overflow, oven-sh/bun#33110)
            // carries no directory hint at all. It is dropped without recovery,
            // but it must be visible and it must never throw (R9).
            if (!filename) {
              this.#notifyAmbiguous(collection.name, null, "missing-filename");
              return;
            }
            const relPath = filename.toString().replaceAll("\\", "/");
            const currentCollection = this.#collections.find(
              (entry) => entry.name === collection.name
            );
            if (
              !currentCollection ||
              normalize(currentCollection.path) !== watchedRoot
            ) {
              return;
            }
            const observation = this.#observe();
            if (
              matchesWalkPath(
                relPath,
                collectionToWalkConfig(currentCollection, 0)
              )
            ) {
              // Exact-path fast path: no directory work.
              //
              // Suppression exists so GNO's own writes do not feed back into
              // the watcher as if they were external changes. It must NOT also
              // swallow DELETION evidence: a suppressed path that has vanished
              // from disk is not an application write - the app wrote it, it is
              // gone now, and on Bun 1.3.14 that single arbitrary child may be
              // the only report a recursive directory delete ever makes.
              // Dropping it here left every document beneath the removed
              // directory active and searchable forever.
              //
              // So the event is queued for CLASSIFICATION either way, and the
              // sync-side guarantee is kept where the disk can actually be
              // consulted: `#widenVanishedExactPaths` drops a suppressed path
              // that still EXISTS before it can reach `syncPaths`.
              //
              // What is decided HERE, once, is whether the event happened
              // inside the suppression window - the fact the flush would
              // otherwise have to re-derive from a clock that has since moved
              // (see `PendingPathEntry`).
              const suppressed = this.#isSuppressedAt(
                join(watchedRoot, relPath),
                observation
              );
              if (!suppressed) {
                this.#promoteObservation(observation.atMs);
              }
              // A suppressed path's observation stays unpromoted until the same
              // flush proves it was a real change (a vanished one) rather than
              // the application's own surviving write.
              this.#queueChange(collection.name, relPath, {
                unsuppressed: suppressed ? null : observation,
                suppressed: suppressed ? observation : null,
              });
              return;
            }
            this.#queueDirtyDirectory(
              currentCollection,
              watchedRoot,
              relPath,
              observation
            );
          }
        );
        this.#watchers.set(collection.name, watcher);
        this.#watchRoots.set(collection.name, watchedRoot);
        this.#failedCollections.delete(collection.name);
      } catch (error) {
        this.#failedCollections.set(
          collection.name,
          error instanceof Error ? error.message : "watch unavailable"
        );
      }
    }
  }

  /** Draw the next observation: a causal position and a wall-clock reading. */
  #observe(): Observation {
    return { seq: this.#nextSequence++, atMs: Date.now() };
  }

  /**
   * Mark a path as an application-originated write until `ms` from now.
   *
   * The point-in-time semantics are exactly what a single stored expiry gave:
   * calling this while a window is still OPEN moves that window's end (so
   * `suppress(path, 0)` ends it now), and calling it after the previous window
   * closed opens a NEW one. What is added is the window's START, so the
   * question "was this path suppressed when that event arrived" can be answered
   * for an event that arrived BEFORE this call - previously it was answered
   * "yes", retroactively and permanently (R4).
   *
   * The start is drawn from the same monotonic counter every observation draws
   * from, so that answer holds at ANY resolution: an event seen in the same
   * millisecond as this call, but before it, still has the lower sequence and
   * is still not suppressed. Recording the start as `Date.now()` left exactly
   * that boundary answered the old, retroactive way.
   */
  suppress(absPath: string, ms = 5_000): void {
    const key = normalize(absPath);
    const { seq: startSeq, atMs: startMs } = this.#observe();
    const endMs = startMs + ms;
    // Lowered for EVERY stored end, including the one that shortens an open
    // window: `suppress(path, 0)` closes a window now, and a floor that still
    // named the original expiry would let the O(1) guard skip the very scan
    // that reclaims it.
    this.#suppressionFloorEndMs = Math.min(this.#suppressionFloorEndMs, endMs);
    const intervals = this.#suppressedPaths.get(key);
    if (!intervals) {
      this.#suppressedPaths.set(key, [{ startSeq, endMs }]);
      this.#reclaimSuppressionHistory();
      return;
    }
    const open = intervals.at(-1);
    if (open && open.endMs > startMs) {
      // Still inside the previous window: one continuous suppression.
      open.endMs = endMs;
    } else {
      intervals.push({ startSeq, endMs });
      while (intervals.length > MAX_SUPPRESSION_INTERVALS) {
        // Merge the two oldest into their span - conservative by construction.
        const [oldest, next] = intervals as [
          SuppressionInterval,
          SuppressionInterval,
        ];
        oldest.endMs = next.endMs;
        intervals.splice(1, 1);
      }
    }
    this.#reclaimSuppressionHistory();
  }

  /**
   * Was this absolute path inside an application-write window AT `observation`?
   *
   * Always asked about an OBSERVATION, never about "now". The window is short
   * (5 s by default) and the flush is at minimum a debounce window later, so
   * evaluating it against a fresh clock silently answers a different question
   * than the one the event asked.
   *
   * Answered against interval MEMBERSHIP rather than "the current expiry is
   * later than the observation". The two differ in both directions and both
   * were wrong: a window opened AFTER the event swallowed it retroactively, and
   * a window that opened before the event and has since been superseded kept
   * swallowing it forever.
   *
   * Each end of the window is compared in its own unit. The START is causal, so
   * an event that preceded `suppress()` is outside the window however close in
   * time the two were; the END is a wall-clock duration, so an event that
   * arrived after the window lapsed is outside it too.
   */
  #isSuppressedAt(absPath: string, observation: Observation): boolean {
    const intervals = this.#suppressedPaths.get(normalize(absPath));
    if (!intervals) {
      return false;
    }
    return intervals.some(
      (interval) =>
        interval.startSeq <= observation.seq &&
        observation.atMs < interval.endMs
    );
  }

  /**
   * Was this path suppressed at EVERY observation that asked for the work?
   *
   * The resolved-candidate counterpart of the `a && b` merge rule exact paths
   * get in `#queueChange`: one observation outside the window is proof that the
   * application's own write cannot account for every event, so the candidate
   * must still be synced. An empty witness set claims nothing.
   */
  #isSuppressedAtEvery(
    absPath: string,
    observations: ReadonlySet<Observation>
  ): boolean {
    if (observations.size === 0) {
      return false;
    }
    for (const observation of observations) {
      if (!this.#isSuppressedAt(absPath, observation)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Drop suppression intervals no queued observation can still consult.
   *
   * The reclamation floor is the OLDEST live observation - across the pending
   * queues, the dirty queues, and every flush that has drained its queues but
   * not yet finished (`#inFlightObservationFloors`). An interval that ended at
   * or before that floor cannot contain any question still to be asked: every
   * remaining question is about an instant at or after the floor, and future
   * events are later still. With no live observation at all the floor is now,
   * because the earliest observation any future event can carry is now.
   *
   * An interval is therefore retained until the LATER of its own end and the
   * oldest observation that could still consult it - at most one debounce
   * window plus the flush it feeds beyond the window's own lifetime - and is
   * then dropped.
   *
   * This is OPPORTUNISTIC: it runs from `suppress()` and from every flush's
   * `finally`, and nowhere else. So the honest bound is at most ONE retained
   * entry per suppressed path, reclaimed the next time either of those runs -
   * a normal 5 s window is still open when its 300 ms flush finishes, so that
   * flush's final reclamation correctly retains it, and on an idle service it
   * stays until the next `suppress()` or flush. That is exactly the bound the
   * single-expiry map this replaced already had, so nothing here regresses it;
   * only the shape of what is retained changed. There is deliberately no
   * background wake-up: a timer armed against a window end has to be re-armed
   * from inside its own callback, has to be cancelled when live observations
   * move the floor it cannot move itself, and gets its delay silently rounded
   * to 1 ms by Bun above `2**31-1` - three ways to leak or spin, bought for a
   * memory bound the daemon already met.
   */
  #reclaimSuppressionHistory(): void {
    if (this.#suppressedPaths.size === 0) {
      return;
    }
    // O(1) guard: nothing has ended yet, so nothing is reclaimable whatever
    // the floor turns out to be (the floor is never later than now).
    const nowMs = Date.now();
    if (this.#suppressionFloorEndMs > nowMs) {
      return;
    }
    const cutoffMs = this.#oldestLiveObservationMs() ?? nowMs;
    let floorEndMs = Number.POSITIVE_INFINITY;
    for (const [key, intervals] of this.#suppressedPaths) {
      const kept = intervals.filter((interval) => interval.endMs > cutoffMs);
      if (kept.length === 0) {
        this.#suppressedPaths.delete(key);
        continue;
      }
      if (kept.length !== intervals.length) {
        this.#suppressedPaths.set(key, kept);
      }
      for (const interval of kept) {
        floorEndMs = Math.min(floorEndMs, interval.endMs);
      }
    }
    this.#suppressionFloorEndMs = floorEndMs;
  }

  /** The earliest observation any queued or in-flight work still carries. */
  #oldestLiveObservationMs(): number | null {
    let oldest: number | null = null;
    // An empty witness set answers `Infinity` and must not become the floor.
    const consider = (atMs: number): void => {
      if (Number.isFinite(atMs) && (oldest === null || atMs < oldest)) {
        oldest = atMs;
      }
    };
    for (const pending of this.#pendingByCollection.values()) {
      for (const entry of pending.values()) {
        if (entry.unsuppressed !== null) {
          consider(entry.unsuppressed.atMs);
        }
        if (entry.suppressed !== null) {
          consider(entry.suppressed.atMs);
        }
      }
    }
    for (const dirty of this.#dirtyByCollection.values()) {
      for (const entry of dirty.values()) {
        consider(oldestObservationMsOf(entry.observations));
        for (const hintObservations of entry.hints.values()) {
          consider(oldestObservationMsOf(hintObservations));
        }
      }
    }
    for (const held of this.#inFlightObservationFloors) {
      consider(held.floorMs);
    }
    return oldest;
  }

  /**
   * The single sync-side suppression rule, in one place.
   *
   * Suppression exists to stop GNO's own writes from feeding back into the
   * watcher as if they were external changes. It suppresses SYNCING an
   * application write that STILL EXISTS - never CLASSIFICATION of one that has
   * VANISHED. A suppressed path that is gone from disk is not an application
   * write in flight: the app wrote it, it is gone now, and dropping it here
   * leaves that document active and searchable until a full `gno update`.
   *
   * Only the disk can tell those apart, which is why this is async and lives on
   * the flush side rather than in the watcher callback.
   *
   * Fails CLOSED: only a path PROVEN removed escapes suppression. An
   * unreadable path (`EACCES`, `EIO`, a hung mount, a path that will not even
   * normalize) stays suppressed rather than being resynced on the strength of a
   * failed stat - the same rule `#widenVanishedExactPaths` applies to exact
   * paths.
   *
   * The suppression half of the decision is taken against the OBSERVATIONS
   * that asked for this work - the instants the events that produced this
   * candidate were seen - so neither a window that has since expired nor one
   * opened after the fact can change the answer. Only the survived-vs-vanished
   * half is asked of the disk.
   */
  async #isSuppressedSurvivor(
    root: string,
    relPath: string,
    observations: ReadonlySet<Observation>
  ): Promise<boolean> {
    if (!this.#isSuppressedAtEvery(join(root, relPath), observations)) {
      return false;
    }
    const outcome = await this.#resolveVanishedPath(relPath, root);
    return outcome.status !== "removed";
  }

  /**
   * Drop the candidates that are suppressed AND still present, keeping the
   * suppressed-but-vanished ones so they reach `syncPaths` and deactivate.
   *
   * The disk is consulted only for paths that are actually suppressed, so the
   * ordinary reconciliation - where nothing is suppressed - costs no extra
   * stats at all.
   */
  async #dropSuppressedSurvivors(
    root: string,
    relPaths: string[],
    observations: ReadonlySet<Observation>
  ): Promise<string[]> {
    if (
      !relPaths.some((relPath) =>
        this.#isSuppressedAtEvery(join(root, relPath), observations)
      )
    ) {
      return relPaths;
    }
    const kept: string[] = [];
    for (const relPath of relPaths) {
      if (!(await this.#isSuppressedSurvivor(root, relPath, observations))) {
        kept.push(relPath);
      }
    }
    return kept;
  }

  /**
   * Publish one observation as the watcher's last observed change.
   *
   * The OBSERVATION time is published, not the flush time - `lastEventAt`
   * answers "when did the filesystem last change", and the debounce window
   * must not show up as latency in it.
   *
   * Two kinds of event reach the queues without being known to be real changes
   * yet, so their observations are held on the queued work and only reach here
   * once that work has produced a batch:
   *
   * - an AMBIGUOUS event, whose reported name is ineligible. `note.md.tmp` (a
   *   real atomic save reported under its temp name) and `cover.png` (a file
   *   the collection would never index) are indistinguishable at receipt -
   *   filesystem-free rules cannot tell them apart, which is exactly why the
   *   reconciliation route exists.
   * - a SUPPRESSED exact path, which is an application write unless it turns
   *   out to have vanished.
   *
   * That is what distinguishes a dropped event (excluded, or ineligible with
   * nothing to reconcile) from an accepted one - and it only works because
   * every observation travels with the SPECIFIC path or directory it was made
   * for. A single per-collection timestamp cannot answer this: two directories
   * in one window share it, so a later event that reconciled to nothing was
   * published on the strength of the earlier directory's work.
   */
  #promoteObservation(observedAtMs: number): void {
    if (this.#lastEventAtMs === null || observedAtMs > this.#lastEventAtMs) {
      this.#lastEventAtMs = observedAtMs;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#timers.clear();
    this.#flushDeadlines.clear();
    this.#watchers.clear();
    this.#watchRoots.clear();
    this.#collectionGenerations.clear();
    this.#collectionFingerprints.clear();
    this.#collections = [];
    this.#pendingByCollection.clear();
    this.#dirtyByCollection.clear();
    await Promise.allSettled(this.#inFlightSyncs);
    this.#syncing.clear();
  }

  /**
   * How many paths still carry retained suppression history.
   *
   * The retention BOUND is a memory property with no behavioral shadow - a
   * reclaimed interval and a lapsed one answer every suppression question
   * identically - so it is unobservable through `getState()` or through any
   * sync. This narrow counter is the seam that lets the bound be asserted
   * rather than merely claimed: at most one retained entry per suppressed path,
   * reclaimed opportunistically on the next `suppress()` or flush end. It is
   * deliberately NOT part of reported watcher state and adds nothing to the
   * public status schema.
   */
  get retainedSuppressionPathCount(): number {
    return this.#suppressedPaths.size;
  }

  getState(): CollectionWatchState {
    return {
      expectedCollections: this.#collections.map(
        (collection) => collection.name
      ),
      activeCollections: [...this.#watchers.keys()],
      failedCollections: [...this.#failedCollections.entries()].map(
        ([collection, reason]) => ({ collection, reason })
      ),
      queuedCollections: [
        ...new Set([
          ...[...this.#pendingByCollection.entries()]
            .filter(([, relPaths]) => relPaths.size > 0)
            .map(([collectionName]) => collectionName),
          ...[...this.#dirtyByCollection.entries()]
            .filter(([, directories]) => directories.size > 0)
            .map(([collectionName]) => collectionName),
        ]),
      ],
      syncingCollections: [...this.#syncing],
      lastEventAt:
        this.#lastEventAtMs === null
          ? null
          : new Date(this.#lastEventAtMs).toISOString(),
      lastSyncAt: this.#lastSyncAt,
    };
  }

  #queueChange(
    collectionName: string,
    relPath: string,
    observation: PendingPathEntry
  ): void {
    if (this.#disposed) {
      return;
    }
    const pending =
      this.#pendingByCollection.get(collectionName) ??
      new Map<string, PendingPathEntry>();
    const existing = pending.get(relPath);
    // Each KIND of observation keeps its own latest timestamp, so the entry
    // never describes one observation with another's clock reading. A path
    // observed at least once OUTSIDE its suppression window is an external
    // change - the application's write cannot account for every event naming
    // it, so it must still be synced, and it is THAT observation the batch
    // publishes (R7).
    pending.set(
      relPath,
      existing
        ? {
            unsuppressed: laterObservation(
              existing.unsuppressed,
              observation.unsuppressed
            ),
            suppressed: laterObservation(
              existing.suppressed,
              observation.suppressed
            ),
          }
        : observation
    );
    this.#pendingByCollection.set(collectionName, pending);
    this.#armFlushTimer(collectionName);
  }

  /**
   * Run a diagnostic observer so it can never influence control flow (R9).
   *
   * `onAmbiguousEvent` fires synchronously inside the `fs.watch` callback,
   * before any work is queued. A throwing consumer would otherwise propagate
   * out of the watcher callback AND - on the ineligible-path branch - stop the
   * reconciliation from ever being queued. Diagnostics are observations; a
   * broken observer is not the watcher's problem.
   */
  #notifyDiagnostic(run: () => void): void {
    try {
      run();
    } catch {
      // Intentionally swallowed: see the doc comment above.
      return;
    }
  }

  #notifyAmbiguous(
    collectionName: string,
    directory: string | null,
    reason: AmbiguousWatchEventReason
  ): void {
    this.#notifyDiagnostic(() =>
      this.#callbacks?.onAmbiguousEvent?.({
        collection: collectionName,
        directory,
        reason,
      })
    );
  }

  /**
   * Queue the dirty-directory work implied by an ambiguous event.
   *
   * Work is keyed by the AFFECTED DIRECTORY, and the reported path is retained
   * as a bounded directory hint under that key, because measurement (fn-114
   * task .1, Bun 1.3.11 on Linux) showed neither alone is sufficient:
   *
   * - an atomic save through a plain temp name reports ONLY the temp source
   *   (`note.md.tmp`), so the real file is a SIBLING - the directory is needed;
   * - a recursive directory delete reports ONLY the bare directory (`dir1`)
   *   with no child events, and its indexed documents are direct children of
   *   that directory - the reported path ITSELF is needed (R12).
   *
   * The reported path cannot be stat-ed in the deletion case (it is already
   * gone), so it is recorded as a hint and resolved at flush time: a hint that
   * is not a directory enumerates as `missing` and reconciles against the
   * indexed side only, which is exactly the deletion behavior.
   *
   * Keying by directory is what bounds the WORK. 25 events naming 25 distinct
   * temp files in one directory queue 25 hints, but those 25 hints cost one
   * batched store lookup and zero directory enumerations at flush time (see
   * `#reconcileDirtyDirectories`); only the one affected directory is
   * enumerated. Retaining every hint is what keeps a deleted directory - which
   * is indistinguishable from a dead temp name until the indexed side is
   * consulted - from being silently discarded.
   */
  #queueDirtyDirectory(
    collection: Collection,
    watchedRoot: string,
    relPath: string,
    observation: Observation
  ): void {
    if (this.#disposed) {
      return;
    }
    const reported = normalizeCollectionDirRelPath(relPath);
    this.#notifyAmbiguous(
      collection.name,
      reported === null ? null : parentDirectoryOf(reported),
      "ineligible-path"
    );
    if (reported === null) {
      // Escapes the collection root - refuse it rather than reconcile blind.
      return;
    }
    const directory = parentDirectoryOf(reported);
    const reportedIsReconcilable = this.#isReconcilableDirectory(
      reported,
      collection
    );
    if (
      !reportedIsReconcilable &&
      !this.#isReconcilableDirectory(directory, collection)
    ) {
      return;
    }

    const dirty =
      this.#dirtyByCollection.get(collection.name) ??
      new Map<string, DirtyDirectoryEntry>();
    let entry = dirty.get(directory);
    if (!entry || entry.root !== watchedRoot) {
      // A root change mid-window invalidates whatever was queued for this key.
      // `subtree` starts false: an ineligible reported path is not evidence
      // that its PARENT directory went anywhere, and the hint machinery below
      // is what discovers a removed directory on this route.
      entry = {
        root: watchedRoot,
        observations: newObservationSet(observation),
        hints: new Map(),
        subtree: false,
      };
      dirty.set(directory, entry);
    } else {
      // The event was ACCEPTED for reconciliation, so it is a real observation
      // of THIS directory - but not yet demonstrably a real change (see
      // `#promoteObservation`). Every path that returned above was DROPPED and
      // still contributes no timestamp at all, to this key or any other.
      recordObservation(entry.observations, observation);
    }
    // An excluded or dot-prefixed reported path is not retained: a full sync
    // would never walk it either, so it is covered by the directory alone.
    // The observation is recorded against the HINT as well as the directory,
    // because the hint is a reconciliation key in its own right and only the
    // events that actually named it are evidence about its candidates.
    this.#addDirectoryHint(entry, collection, reported, observation);
    this.#dirtyByCollection.set(collection.name, dirty);
    this.#armFlushTimer(collection.name);
  }

  /**
   * Cheap queue/flush-time noise filter. Authoritative eligibility still runs
   * per candidate path through `matchesWalkPath`; this only avoids doing
   * filesystem and store work for directories a full `gno update` would never
   * walk INTO AT ALL - dot-prefixed, or excluded by a rule that also covers
   * everything beneath them.
   *
   * The exclusion question asked here is `exclusionCoversSubtree`, NOT the
   * file-level `matchesCollectionExclusion`. A directory whose own NAME matches
   * an exclusion may still hold walkable descendants: with `exclude: ["*.md"]`
   * the walker indexes `foo.md/child.txt`, so pruning the directory `foo.md`
   * here is stricter than the walk. That extra strictness loses documents - a
   * recursive delete of `foo.md/` reports the bare directory (or one arbitrary
   * child), and a pruned directory cannot be reconciled, so `child.txt` stays
   * active and searchable with nothing on disk behind it.
   *
   * Patterns that DO cover their subtree (`node_modules`, `.git`,
   * `node_modules/**`) still prune exactly as before, so the bound on work for
   * excluded-tree noise is unchanged.
   */
  #isReconcilableDirectory(directory: string, collection: Collection): boolean {
    if (directory === "") {
      return true;
    }
    if (directory.split("/").some((segment) => segment.startsWith("."))) {
      return false;
    }
    return !exclusionCoversSubtree(directory, collection.exclude);
  }

  /**
   * Re-arm the debounce, but never past this window's deadline.
   *
   * A pure debounce delays work; it must never PREVENT it. An editor or build
   * process emitting unique ineligible temp names faster than the window
   * cancels and restarts the only timer on every event, so the flush never
   * fires: eligible changes queued alongside that churn stay unindexed for as
   * long as it lasts, and the queues (including `DirtyDirectoryEntry.hints`)
   * grow the whole time. The ceiling is what makes the debounce a delay again.
   */
  #armFlushTimer(collectionName: string): void {
    const existingTimer = this.#timers.get(collectionName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const now = monotonicNowMs();
    let deadline = this.#flushDeadlines.get(collectionName);
    if (deadline === undefined) {
      // Anchored at the FIRST queued event of this window, so the bound is on
      // how long queued work can wait - not on how long churn has been running.
      deadline = now + MAX_FLUSH_DELAY_MS;
      this.#flushDeadlines.set(collectionName, deadline);
    }
    const delay = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, deadline - now));
    this.#timers.set(
      collectionName,
      setTimeout(() => {
        this.#startFlush(collectionName);
      }, delay)
    );
  }

  #startFlush(collectionName: string): void {
    // The window ends here whatever the flush then decides. Clearing it later -
    // only once the queues are genuinely drained - would leave an expired
    // deadline behind a flush that returned early (a sync already in flight),
    // and every subsequent event would then arm a zero-delay timer and spin.
    this.#flushDeadlines.delete(collectionName);
    if (this.#disposed) {
      return;
    }
    const sync = this.#flushCollection(collectionName);
    this.#inFlightSyncs.add(sync);
    void sync
      .finally(() => {
        this.#inFlightSyncs.delete(sync);
      })
      .catch(() => undefined);
  }

  async #flushCollection(collectionName: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const pending = this.#pendingByCollection.get(collectionName);
    const dirty = this.#dirtyByCollection.get(collectionName);
    if ((pending?.size ?? 0) === 0 && (dirty?.size ?? 0) === 0) {
      return;
    }
    if (this.#syncing.has(collectionName)) {
      return;
    }

    const collection = this.#collections.find(
      (entry) => entry.name === collectionName
    );
    if (!collection) {
      this.#pendingByCollection.delete(collectionName);
      this.#dirtyByCollection.delete(collectionName);
      return;
    }

    // Every observation this window made travels with the path or directory it
    // was made for, so a batch that is later dropped takes its unpromoted
    // observations with it rather than leaking into the next window.
    let exactPaths = pending
      ? new Map<string, PendingPathEntry>(pending)
      : new Map<string, PendingPathEntry>();
    let dirtyEntries = dirty ? [...dirty.entries()] : [];
    let syncGeneration = this.#collectionGenerations.get(collectionName) ?? 0;
    this.#pendingByCollection.set(
      collectionName,
      new Map<string, PendingPathEntry>()
    );
    this.#dirtyByCollection.set(
      collectionName,
      new Map<string, DirtyDirectoryEntry>()
    );

    // Claim the collection before the (async) reconciliation so a concurrent
    // debounce flush cannot start work against the same queues mid-await.
    this.#syncing.add(collectionName);
    // The queues have been drained, so the observations now in hand are
    // invisible to `#oldestLiveObservationMs` unless this flush holds their
    // floor. Suppression history must outlive them: the candidate filter runs
    // after the classification and enumeration awaits below.
    const observationFloor = {
      floorMs: oldestDrainedObservationMs(exactPaths, dirtyEntries),
    };
    this.#inFlightObservationFloors.add(observationFloor);
    let relPaths: string[] = [];
    let replacements = new Map<string, ObservationSet>();
    let reconciliations: DirectoryReconciliation[] = [];
    // Started reconciliations that still owe their single terminal outcome.
    let outstanding: DirectoryReconciliation[] = [];

    /**
     * R6 - the ONE resume point every pre-sync await funnels through.
     *
     * Everything between draining the queues and handing paths to `syncPaths`
     * was resolved against the configuration captured in `collection` and
     * `syncGeneration`. Every `await` in that region is a window in which
     * `updateCollections` can remove the collection, move its root, or change
     * its rules, so the work in hand can describe a configuration that no
     * longer exists.
     *
     * This deliberately runs UNCONDITIONALLY after each such await instead of
     * inside whichever branch happens to own the current one. The earlier
     * revision guarded only the enumeration branch; adding the classification
     * await (`#widenVanishedExactPaths`) then silently reopened exactly the
     * same hole for a batch of exact paths with no dirty directories, because
     * that batch never enters the enumeration branch at all. The rule is
     * therefore mechanical, not situational: an `await` added below MUST be
     * followed immediately by `resumeAfterAwait()`, and no branch condition may
     * stand between them.
     *
     * Dropping the resolved work on drift is safe because the recovery loop at
     * the end of the flush runs a full `syncCollection` against the CURRENT
     * configuration, which is a superset of anything bounded that was dropped
     * (R6) - reconciliation adds no second compensating pass.
     */
    const resumeAfterAwait = (): "continue" | "abort" => {
      if (this.#disposed) {
        return "abort";
      }
      const liveCollection = this.#collections.find(
        (entry) => entry.name === collectionName
      );
      const liveGeneration =
        this.#collectionGenerations.get(collectionName) ?? 0;
      if (liveCollection) {
        const rootChanged =
          normalize(liveCollection.path) !== normalize(collection.path);
        if (!(rootChanged || liveGeneration !== syncGeneration)) {
          return "continue";
        }
      }
      // Any drift invalidates the whole in-hand batch - bounded candidates and
      // the exact paths drained from the same window alike. They are synced
      // against neither the old nor the new configuration.
      this.#completeReconciliations(collection.name, outstanding, new Set());
      outstanding = [];
      reconciliations = [];
      dirtyEntries = [];
      exactPaths = new Map();
      replacements = new Map();
      if (!liveCollection) {
        // The collection is gone: there is nothing left to recover against, so
        // the queues are discarded rather than reflushed.
        this.#pendingByCollection.delete(collectionName);
        this.#dirtyByCollection.delete(collectionName);
        return "abort";
      }
      return "continue";
    };

    try {
      if (exactPaths.size > 0) {
        const widened = await this.#widenVanishedExactPaths(
          collection,
          exactPaths,
          dirtyEntries
        );
        dirtyEntries = widened.dirtyEntries;
        // Suppressed paths that are still on disk are dropped HERE, after
        // classification: they were queued only so a vanished one could not be
        // lost, and an application write that still exists must not be resynced.
        // Both assignments land BEFORE the resume check so a drift-dropped
        // batch stays dropped - `resumeAfterAwait` clears them.
        exactPaths = widened.exactPaths;
        replacements = widened.replacements;
        if (resumeAfterAwait() === "abort") {
          return;
        }
      }

      // Replacement candidates are reconciliation work in their own right - a
      // window whose only event was the file that replaced an indexed
      // directory has no dirty entry at all - so they open the same stage.
      if (dirtyEntries.length > 0 || replacements.size > 0) {
        reconciliations = await this.#reconcileDirtyDirectories(
          collection,
          dirtyEntries,
          replacements
        );
        // Assigned BEFORE the resume check so a drift-dropped batch still
        // settles the terminal outcome every started reconciliation owes (R7).
        outstanding = reconciliations;
        if (resumeAfterAwait() === "abort") {
          return;
        }
      }

      // Reconciliation candidates rejoin the ordinary path flow here, BEFORE
      // the live-rules recheck, so they are filtered exactly like exact paths.
      relPaths = [
        ...new Set([
          ...exactPaths.keys(),
          ...reconciliations.flatMap((entry) => entry.candidates),
        ]),
      ].filter((relPath) =>
        matchesWalkPath(relPath, collectionToWalkConfig(collection, 0))
      );
      const batched = new Set(relPaths);
      // The batch is the proof, and it is proof only for the work that is
      // actually IN it. Each surviving exact path publishes its own
      // observation, and each reconciliation publishes its directory's - so an
      // event whose reconciliation yielded nothing advances nothing, even when
      // an unrelated directory in the same window produced plenty. Anything not
      // batched leaves `lastEventAt` untouched: that is the dropped case, and
      // its observation is discarded with the drained queue.
      for (const [relPath, observation] of exactPaths) {
        if (batched.has(relPath)) {
          // The ELIGIBLE observation, never simply the latest one: a path kept
          // on the strength of an unsuppressed event at `t1` must not publish a
          // later suppressed event at `t2` that the callback dropped (R7).
          this.#promoteObservation(eligibleObservationOf(observation).atMs);
        }
      }
      for (const entry of reconciliations) {
        if (entry.candidates.some((relPath) => batched.has(relPath))) {
          this.#promoteObservation(entry.observedAtMs);
        }
      }
      // A reconciliation that put nothing into the batch cannot be affected by
      // the sync stage, so its outcome is already known: report the successful
      // no-op now (a zero-candidate reconciliation IS a success and must not
      // vanish). Everything that DID contribute waits for the shared sync, so a
      // sync failure is never preceded by a completion for the same directory.
      const contributing: DirectoryReconciliation[] = [];
      const settledNow: DirectoryReconciliation[] = [];
      for (const entry of outstanding) {
        if (entry.candidates.some((relPath) => batched.has(relPath))) {
          contributing.push(entry);
        } else {
          settledNow.push(entry);
        }
      }
      this.#completeReconciliations(collection.name, settledNow, batched);
      outstanding = contributing;

      let completionCollection = collection;
      let completionPaths: string[] = [];
      if (relPaths.length === 0) {
        // An empty batch is NOT automatically "nothing to do": the enumeration
        // above is async, so the configuration may have changed while it ran,
        // and the old rules can legitimately yield nothing under the new ones
        // (`*.md` -> `*.txt`). Falling straight through to `return` here would
        // skip the generation-drift recovery below and leave newly eligible
        // files undiscovered. Only an UNDRIFTED empty batch is a no-op.
        if (
          (this.#collectionGenerations.get(collectionName) ?? 0) ===
          syncGeneration
        ) {
          // `finally` announces settling; nothing to sync.
          return;
        }
      } else {
        this.#callbacks?.onSyncStart?.({
          collection: collection.name,
          relPaths,
        });
        const result = await defaultSyncService.syncPaths(
          collection,
          this.#store,
          relPaths,
          {
            ...this.#syncOptions,
            runUpdateCmd: false,
          }
        );
        if (this.#disposed) {
          return;
        }
        this.#callbacks?.onSyncComplete?.({
          collection: collection.name,
          relPaths,
          result,
        });
        // The shared sync RESOLVED, which is not the same as "every contributed
        // path succeeded": `syncPaths` reports ordinary per-file failures
        // (EACCES, a converter error, a failed `markInactive`) in its result
        // rather than by throwing. Each contributing directory is settled
        // against that result, so a directory whose own paths errored reports
        // a sync-stage FAILURE instead of a completion (R7). Reported here
        // rather than before the sync so a later throw cannot produce both
        // "completed" and "failed" for the same reconciliation.
        this.#settleReconciliationsAfterSync(
          collection.name,
          outstanding,
          batched,
          result
        );
        outstanding = [];
        completionPaths = changedPaths(result, relPaths);
      }

      while (true) {
        const currentCollection = this.#collections.find(
          (entry) => entry.name === collectionName
        );
        if (!currentCollection) {
          break;
        }
        const currentGeneration =
          this.#collectionGenerations.get(collectionName) ?? 0;
        if (currentGeneration === syncGeneration) {
          const currentRelPaths =
            normalize(currentCollection.path) ===
            normalize(completionCollection.path)
              ? completionPaths.filter((relPath) =>
                  matchesWalkPath(
                    relPath,
                    collectionToWalkConfig(currentCollection, 0)
                  )
                )
              : [];
          if (currentRelPaths.length > 0) {
            this.#afterSync(currentCollection, currentRelPaths);
          }
          break;
        }

        const recoveryResult = await defaultSyncService.syncCollection(
          currentCollection,
          this.#store,
          {
            ...this.#syncOptions,
            runUpdateCmd: false,
          }
        );
        if (this.#disposed) {
          return;
        }
        completionCollection = currentCollection;
        completionPaths = changedPaths(recoveryResult);
        syncGeneration = currentGeneration;
        this.#callbacks?.onSyncComplete?.({
          collection: currentCollection.name,
          relPaths: completionPaths,
          result: recoveryResult,
        });
      }
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      this.#callbacks?.onSyncError?.({
        collection: collection.name,
        relPaths,
        error,
      });
      // Only directories that actually reached the failed sync are reported
      // against it, and only if they do not already own a terminal outcome.
      for (const entry of outstanding) {
        if (entry.failureReported) {
          continue;
        }
        this.#notifyDiagnostic(() =>
          this.#callbacks?.onReconcileFailed?.({
            collection: collection.name,
            directory: entry.directory,
            stage: "sync",
            cause: error,
          })
        );
      }
      throw error;
    } finally {
      this.#syncing.delete(collectionName);
      // This flush's observations can no longer consult suppression history,
      // so the intervals they were holding open become reclaimable here.
      this.#inFlightObservationFloors.delete(observationFloor);
      this.#reclaimSuppressionHistory();
      if (!this.#disposed) {
        const remainingPaths = this.#pendingByCollection.get(collectionName);
        const remainingDirs = this.#dirtyByCollection.get(collectionName);
        if ((remainingPaths?.size ?? 0) > 0 || (remainingDirs?.size ?? 0) > 0) {
          this.#startFlush(collectionName);
        } else {
          this.#notifySettledIfIdle();
        }
      }
    }
  }

  /**
   * Emit the single completion each started reconciliation owes (R7).
   *
   * Every directory that emitted `onReconcileStart` must reach exactly ONE
   * terminal outcome - completion or failure, never both and never neither:
   *
   * - a directory that already reported a failed stage is skipped here, so a
   *   fail-closed enumeration or an unanswered store query is not also claimed
   *   as a success;
   * - a successful reconciliation that produced nothing IS reported, with zero
   *   counts. Dropping it (as an earlier revision did, by filtering empty
   *   outcomes away) left `onReconcileStart` with no answer at all, which is
   *   precisely the diagnostic ambiguity R7 exists to prevent.
   *
   * Disposal remains the one documented exception: no callback fires after
   * `dispose()`, for reconciliation as for every other watcher event.
   */
  /**
   * Settle every contributing reconciliation against the RESULT of a sync that
   * resolved without throwing.
   *
   * `syncPaths` reports ordinary per-file failures in its result instead of
   * rejecting, so "the promise resolved" is not evidence that the contributed
   * paths were indexed. Reporting completion unconditionally made a directory
   * whose documents are now stale indistinguishable in the daemon log from one
   * that reconciled cleanly - exactly the ambiguity R7 exists to remove.
   *
   * Attribution is PER DIRECTORY, not per batch: several directories share one
   * `syncPaths` call, and one directory's `EACCES` says nothing about another's
   * paths. A directory fails only when a path IT contributed errored; its
   * neighbours in the same batch still complete normally. That split holds only
   * while every reported failure BELONGS to a batched path - a
   * collection-level failure (`"(typed edge backfill)"`, a projection error
   * against an out-of-batch backlink document) belongs to none of them, and
   * `syncErrorAttribution` then reports the whole result unattributable so
   * every contributing directory fails closed instead of reporting a
   * completion the sync does not support. The exactly-one
   * terminal outcome invariant is preserved by marking `failureReported` before
   * emitting, and by routing the survivors through `#completeReconciliations`.
   */
  #settleReconciliationsAfterSync(
    collectionName: string,
    entries: DirectoryReconciliation[],
    batched: ReadonlySet<string>,
    result: CollectionSyncResult
  ): void {
    const attribution = syncErrorAttribution(result, batched);
    const completed: DirectoryReconciliation[] = [];
    // ONE bounded summary for the whole result, built at most once - and only
    // when something is listening. The cause describes the SYNC, not any one
    // directory, so formatting it per directory scaled the work with
    // `directories x errors` for a constant string, and did so even with no
    // observer installed to read it. A broad projection failure across a large
    // reconciliation is exactly when that amplification would land (R7/R9).
    const hasFailureObserver = this.#callbacks?.onReconcileFailed !== undefined;
    const unattributableDetail =
      hasFailureObserver && !attribution.attributable
        ? unattributableCauseDetail(attribution)
        : "";
    for (const entry of entries) {
      if (entry.failureReported) {
        continue;
      }
      const contributed = entry.candidates.filter((relPath) =>
        batched.has(relPath)
      );
      // A directory that contributed nothing cannot be implicated by anything
      // the sync reported, attributable or not.
      if (contributed.length === 0) {
        completed.push(entry);
        continue;
      }
      const failedPaths = contributed.filter((relPath) =>
        attribution.paths.has(relPath)
      );
      if (attribution.attributable && failedPaths.length === 0) {
        completed.push(entry);
        continue;
      }
      entry.failureReported = true;
      // The fail-closed OUTCOME is unconditional; only its DESCRIPTION depends
      // on someone being there to read it.
      if (!hasFailureObserver) {
        continue;
      }
      // Fail closed EITHER WAY, but never claim more than the result supports.
      // Naming the contributed paths as the failure of an UNATTRIBUTABLE result
      // asserts that they failed, when the sync in fact failed at the
      // COLLECTION level and reported nothing about them (R7/R9).
      // BOTH halves of the cause are bounded, each by the formatter for the
      // fields it names, and always BEFORE composition. The unowned
      // SAMPLE was bounded first, but the contributed failed paths beside it
      // were not - and one unowned failure alongside thousands of contributed
      // ones still built a per-directory diagnostic that scaled with the
      // failure, which is precisely the amplification the bound exists to stop
      // (R7/R9). The COUNTS are always exact; only the listing is sampled.
      const alsoFailed =
        failedPaths.length > 0
          ? `${failedPaths.length} contributed path(s) also reported failed (${describeBoundedPaths(failedPaths)}); `
          : "";
      // The directory is an untrusted path field like any other, so it gets its
      // own budget BEFORE composition - once, shared by both branches. A
      // legitimately deep directory, or a pathological watcher-supplied name,
      // would otherwise be interpolated whole and rebuild the very unbounded
      // intermediate the per-field bound exists to stop (R7/R9).
      const boundedDirectory = boundValue(entry.directory);
      const cause = new Error(
        attribution.attributable
          ? `sync reported ${failedPaths.length} failed path(s) for directory "${boundedDirectory}": ${describeBoundedPaths(failedPaths)}`
          : `sync failed at the collection level, so per-directory attribution was impossible; directory "${boundedDirectory}" fails closed over ${contributed.length} contributed path(s): ${alsoFailed}${unattributableDetail}`
      );
      this.#notifyDiagnostic(() =>
        this.#callbacks?.onReconcileFailed?.({
          collection: collectionName,
          directory: entry.directory,
          stage: "sync",
          cause,
        })
      );
    }
    this.#completeReconciliations(collectionName, completed, batched);
  }

  #completeReconciliations(
    collectionName: string,
    entries: DirectoryReconciliation[],
    batched: ReadonlySet<string>
  ): void {
    for (const entry of entries) {
      if (entry.failureReported) {
        continue;
      }
      this.#notifyDiagnostic(() =>
        this.#callbacks?.onReconcileComplete?.({
          collection: collectionName,
          directory: entry.directory,
          candidateCount: entry.candidates.length,
          syncedCount: entry.candidates.filter((relPath) =>
            batched.has(relPath)
          ).length,
        })
      );
    }
  }

  /**
   * Widen the exact-path batch wherever the DISK says the event was not a
   * complete report.
   *
   * The original design read an event naming an eligible path as authoritative.
   * That is provably wrong for deletions. Measured on Bun 1.3.14 (Linux, ext4,
   * real inotify), a recursive delete of `dir1/` holding `a.md` and `b.md`
   * reports ONE ARBITRARY child - `dir1/b.md` on hardware, `dir1/a.md` in a
   * container - and nothing else. That path is eligible, so it took the
   * exact-path fast path, no reconciliation ran, and every unnamed sibling
   * stayed active forever. Bun 1.3.11 reported the bare directory instead. The
   * event SHAPE is not stable across Bun patch releases, so it cannot be the
   * thing correctness rests on.
   *
   * The disk is. A path that still exists named a real, complete change - the
   * live-edit hot path stays exactly as narrow as before, at the cost of one
   * `stat` per pending path. A path that has VANISHED is treated as one sample
   * of a larger removal: its shallowest removed ancestor (or its surviving
   * parent directory, when only the file went) is queued as dirty, and the
   * ordinary bounded reconciliation takes it from there.
   *
   * Where the DIRECTORY-VS-FILE decision is made
   * --------------------------------------------
   * An eligible reported name is NOT evidence that the thing it named was a
   * file. `archive.md` is a legal DIRECTORY name, and a `*.md` collection
   * pattern matches it exactly as it matches a document, so an event naming
   * the bare `archive.md` takes the exact-path route while `archive.md/child.md`
   * lives beneath it. `matchesWalkPath` is deliberately filesystem-free and
   * cannot tell the two apart, and once the path has vanished neither can the
   * disk. Collapsing it to its surviving parent on the strength of the NAME
   * left every document under `archive.md/` active and searchable forever -
   * the same silent staleness this whole path exists to remove.
   *
   * So the name decides nothing here. A vanished path whose parent SURVIVED is
   * queued as a directory HINT under that parent, and the decision is deferred
   * to the one place that can actually make it: the indexed-descendant
   * discriminator in `#reconcileDirtyDirectories`. A hint with active indexed
   * descendants was a directory and is reconciled as a removed subtree; a hint
   * with none was an ordinary file and collapses to the surviving parent,
   * exactly as before. This costs no per-path store query - the hint joins the
   * flush's single batched descendant lookup, which is the same seam the
   * ineligible-event route has always used.
   *
   * Nothing is dropped: the exact paths stay in the batch either way, so a
   * plain single-file delete still deactivates exactly that file through the
   * existing `syncPaths` ENOENT branch.
   *
   * The REPLACEMENT direction of the same question
   * ----------------------------------------------
   * A path that still exists is not automatically the same KIND of thing the
   * index has under that name. `archive.md/` holding `archive.md/child.md`
   * can be removed and a regular FILE `archive.md` written in its place inside
   * one debounce window: the disk answers `present`, the exact path syncs the
   * new file, and every document indexed under the old directory stays active
   * and searchable indefinitely - the same silent staleness a vanished
   * file-NAMED directory produced, reached from the other side. (A directory
   * replaced by a SYMLINK is already covered: the walker cannot reach through
   * it, so it classifies as gone.)
   *
   * A visible NON-DIRECTORY leaf is therefore retained as a REPLACEMENT
   * CANDIDATE, and - exactly like a hint - the indexed side decides. It is
   * deliberately a weaker thing than a hint: a hint that resolves to nothing
   * falls back to reconciling its DIRECTORY, which for a surviving file would
   * enumerate the parent of every live edit. A replacement candidate that
   * resolves to nothing resolves to NOTHING: the path stays on the ordinary
   * exact-path flow, no directory is enumerated, and no reconciliation starts.
   * It costs no query of its own either - the candidates of a whole window
   * join the flush's single batched descendant lookup, the same seam the hints
   * use (R5).
   *
   * This is also the one place that can finish the SUPPRESSION decision, which
   * is why it returns the exact paths as well as the queue. Suppression must
   * keep an application's own write from being resynced, but it must not
   * discard the evidence that the path is GONE - and only the disk can tell
   * those apart, so the watcher callback defers to here. A suppressed path that
   * vanished stays in the batch (it is a deletion, not an application write,
   * and it may be the sole report of a removed subtree); a suppressed path that
   * still exists - or that could not be resolved at all - is dropped from the
   * returned paths, unchanged in effect from the old callback-side skip.
   */
  async #widenVanishedExactPaths(
    collection: Collection,
    exactPaths: Map<string, PendingPathEntry>,
    dirtyEntries: Array<[string, DirtyDirectoryEntry]>
  ): Promise<{
    dirtyEntries: Array<[string, DirtyDirectoryEntry]>;
    exactPaths: Map<string, PendingPathEntry>;
    replacements: Map<string, ObservationSet>;
  }> {
    const root = normalize(collection.path);
    const byDirectory = new Map(dirtyEntries);
    const suppressedSurvivors = new Set<string>();
    const replacements = new Map<string, ObservationSet>();
    for (const [relPath, pending] of exactPaths) {
      if (this.#disposed) {
        break;
      }
      const outcome = await this.#resolveVanishedPath(relPath, root);
      if (outcome.status !== "removed") {
        // `present` is the hot path; `error` fails closed - an unreadable disk
        // is never read as "the file is gone", and a suppressed path is kept
        // suppressed rather than resynced on the strength of a failed stat.
        //
        // The suppression half of that decision is the one taken WHEN THE EVENT
        // ARRIVED. Re-asking `#isSuppressed` here compared the window against
        // whatever the clock said by the time the flush ran - after the 300 ms
        // debounce, after any sync this flush queued behind, after the awaited
        // classification above - so a window that expired in between let the
        // application's own surviving write through to `syncPaths`, which the
        // receipt-time drop this route replaced had always prevented.
        if (isFullySuppressed(pending)) {
          suppressedSurvivors.add(relPath);
        }
        if (outcome.status === "present" && !outcome.isDirectory) {
          // Something that is not a directory stands at a path the index may
          // hold a whole subtree under. Retained for the batched discriminator;
          // see the REPLACEMENT direction above. Suppression is deliberately
          // not consulted: an application write that replaced a directory has
          // still stranded that directory's documents, and the candidates this
          // produces are vanished paths, which suppression never withholds.
          this.#addReplacementCandidate(
            replacements,
            collection,
            relPath,
            eligibleObservationOf(pending)
          );
        }
        continue;
      }
      // The widened area inherits the vanished path's ELIGIBLE observation -
      // the one that earned it its place in the batch - so whatever it goes on
      // to deactivate publishes that moment rather than the moment of a later
      // event the callback dropped, or the moment some other event in the
      // window was seen.
      const observation = eligibleObservationOf(pending);
      let entry = byDirectory.get(outcome.directory);
      if (entry) {
        // The classification is recorded on the queue, never re-derived later:
        // one removed-directory sample in this window is enough, and a second
        // path that only says "my parent survived" must not clear it.
        entry.subtree ||= outcome.directoryRemoved;
        recordObservation(entry.observations, observation);
      } else {
        entry = {
          root,
          observations: newObservationSet(observation),
          hints: new Map<string, ObservationSet>(),
          subtree: outcome.directoryRemoved,
        };
        byDirectory.set(outcome.directory, entry);
      }
      if (!outcome.directoryRemoved) {
        // The vanished path's own parent survived, so the path itself is the
        // shallowest thing known to be gone - and it may be a directory whose
        // name merely looks like a file. Retain it as a hint so the indexed
        // side, not the name, decides which it was. When the ancestor walk
        // already OBSERVED a removed directory (`directoryRemoved`), that
        // directory is the queued area and the discriminator is not needed.
        this.#addDirectoryHint(entry, collection, relPath, observation);
      }
    }
    if (suppressedSurvivors.size > 0) {
      for (const relPath of suppressedSurvivors) {
        exactPaths.delete(relPath);
      }
    }
    return { dirtyEntries: [...byDirectory], exactPaths, replacements };
  }

  /**
   * Retain a still-present path as a candidate REPLACED DIRECTORY.
   *
   * The same reconcilability filter a hint gets, for the same reason: a path
   * the current rules would never walk into cannot have walkable documents
   * indexed beneath it, so asking about it would only widen the flush's
   * batched lookup for nothing.
   *
   * The observation is the one that made the path ELIGIBLE, so whatever this
   * candidate goes on to deactivate answers the suppression rule against the
   * events that named IT - never against another key's witnesses (R4).
   */
  #addReplacementCandidate(
    replacements: Map<string, ObservationSet>,
    collection: Collection,
    relPath: string,
    observation: Observation
  ): void {
    const reported = normalizeCollectionDirRelPath(relPath);
    if (
      reported === null ||
      reported === "" ||
      !this.#isReconcilableDirectory(reported, collection)
    ) {
      return;
    }
    const existing = replacements.get(reported);
    if (existing) {
      recordObservation(existing, observation);
      return;
    }
    replacements.set(reported, newObservationSet(observation));
  }

  /**
   * Retain a reported path as a candidate removed directory under its queued
   * entry. Shared by both routes into the dirty queue so a hint means exactly
   * the same thing however the event arrived.
   *
   * A path the current rules would never walk is not retained: a full
   * `gno update` would not descend into it either, so the directory alone
   * covers it and the flush's batched lookups are not widened for it.
   *
   * The observation that produced the hint is recorded AGAINST THAT HINT. A
   * hint is reconciled as a key of its own, so the suppression rule for its
   * candidates must be answered from the events that named IT - not from every
   * event that happened to reach the same parent directory (R4).
   */
  #addDirectoryHint(
    entry: DirtyDirectoryEntry,
    collection: Collection,
    relPath: string,
    observation: Observation
  ): void {
    const reported = normalizeCollectionDirRelPath(relPath);
    if (
      reported === null ||
      reported === "" ||
      !this.#isReconcilableDirectory(reported, collection)
    ) {
      return;
    }
    const existing = entry.hints.get(reported);
    if (existing) {
      recordObservation(existing, observation);
      return;
    }
    entry.hints.set(reported, newObservationSet(observation));
  }

  /**
   * Resolve queued dirty directories into concrete candidate relative paths.
   *
   * The discriminator, and why it is batched
   * ----------------------------------------
   * A retained hint is a reported path that no longer names an eligible file.
   * On disk it is indistinguishable from any other vanished name, but the two
   * cases it can be demand opposite work:
   *
   * - a dead temp source (`note.md.tmp`) - the real change is a SIBLING, so the
   *   affected DIRECTORY is what must be reconciled;
   * - a recursively deleted directory (`dir1`) - its indexed documents are
   *   direct children of the hint itself, and reconciling the parent can never
   *   reach them (R12).
   *
   * The INDEXED side is what tells them apart: a deleted directory has active
   * indexed children, a dead temp file does not. That question is asked for
   * EVERY hint of this flush in ONE batched store lookup, so unique-temp-name
   * churn costs one query for the window instead of one per filename. Only
   * hints the store proved are real indexed directories are then enumerated on
   * disk, so the enumeration count tracks affected directories rather than
   * event count.
   *
   * A hint with no active indexed children is read as "a file changed here" and
   * falls back to the affected directory - exactly as before. Note what is NOT
   * done: such a hint is not speculatively enumerated on the chance that it is
   * a brand-new subdirectory. On linux (fn-114 task .1) a `mkdir` is reported
   * while the directory is still EMPTY and the writes that follow inside it are
   * never reported at all, so that enumeration finds nothing on the one
   * platform where it would be the only chance; on macOS the files inside
   * produce their own eligible events and take the exact-path fast path.
   *
   * A hint that resolves to real work IS the affected area, so the directory is
   * not enumerated for it - that keeps a recursive directory delete from
   * dragging every unchanged sibling of the deleted directory into the batch.
   *
   * `replacements` are the same question asked about paths that still EXIST as
   * non-directories (see `#widenVanishedExactPaths`), and they ride the same
   * batched round trip. They differ from hints in exactly one way, and it is
   * the way that keeps the live-edit hot path narrow: a replacement candidate
   * that the store answers "nothing indexed here" for produces NO work at all,
   * where a hint falls back to reconciling its directory. Every ordinary file
   * event is such a candidate, so a fallback would enumerate the parent
   * directory of every live edit.
   *
   * Generation drift is handled BEFORE enumeration (R6): an entry queued
   * against a different root is dropped, and everything else is re-resolved
   * against the CURRENT collection configuration. Drift that appears during
   * enumeration or while `syncPaths` is in flight is deliberately left to the
   * pre-existing full-`syncCollection` recovery loop below, which is a superset
   * of this bounded work - reconciliation adds no second compensating pass.
   */
  async #reconcileDirtyDirectories(
    collection: Collection,
    entries: Array<[string, DirtyDirectoryEntry]>,
    replacements: ReadonlyMap<string, ObservationSet>
  ): Promise<DirectoryReconciliation[]> {
    const currentRoot = normalize(collection.path);
    const walkConfig = collectionToWalkConfig(collection, 0);
    const resolved = new Map<string, DirectoryReconciliation>();

    // The collection moved after these events were queued: the queued areas no
    // longer exist in the current configuration.
    const live = entries.filter(([, entry]) => entry.root === currentRoot);

    // Every key the flush could need an indexed answer for, resolved in one
    // round trip. Re-filtered against the CURRENT rules, so a directory the
    // configuration started excluding mid-window is never even asked about.
    const lookupKeys = new Set<string>();
    for (const [directory, entry] of live) {
      if (this.#isReconcilableDirectory(directory, collection)) {
        lookupKeys.add(directory);
      }
      for (const hint of entry.hints.keys()) {
        if (this.#isReconcilableDirectory(hint, collection)) {
          lookupKeys.add(hint);
        }
      }
    }
    const indexed = await this.#listActiveDirectChildrenBatch(collection.name, [
      ...lookupKeys,
    ]);
    if (this.#disposed) {
      return [];
    }

    // The SUBTREE answer, for the same flush and in the same one round trip.
    // Hints are the only keys asked for here: a hint is the candidate DELETED
    // DIRECTORY, and what makes it one is that indexed documents live beneath
    // it - at ANY depth. Discriminating on direct children alone left a
    // directory whose documents all sit one level deeper looking exactly like a
    // dead temp name. The collection root is never a hint, so no key here can
    // degenerate into "every active document in the collection".
    const hintKeys = new Set<string>();
    for (const [, entry] of live) {
      for (const hint of entry.hints.keys()) {
        if (hint !== "" && this.#isReconcilableDirectory(hint, collection)) {
          hintKeys.add(hint);
        }
      }
    }
    // Replacement candidates ask the SAME question of the SAME seam - "is
    // anything indexed beneath this name?" - so they ride the same round trip
    // rather than spending one each. They are asked here and nowhere else:
    // they never enter `lookupKeys`, because a still-present file has no
    // direct-children question to answer.
    for (const candidate of replacements.keys()) {
      if (this.#isReconcilableDirectory(candidate, collection)) {
        hintKeys.add(candidate);
      }
    }
    const descendants = await this.#listActiveDescendantsBatch(
      collection.name,
      [...hintKeys]
    );
    if (this.#disposed) {
      return [];
    }

    /**
     * The indexed answer for one directory, in the same shape the unbatched
     * seam returned. A failed lookup is propagated per directory rather than
     * summarized once: reconciliation reports store failures against the
     * directory they blocked, and infers no deactivation from them.
     */
    const indexedFor = (directory: string): StoreResult<string[]> =>
      indexed.ok
        ? { ok: true, value: indexed.value.get(directory) ?? [] }
        : { ok: false, error: indexed.error };

    /**
     * The subtree answer for one directory: from the batch when it was a hint,
     * fetched on demand otherwise (a dirty directory that turns out to be gone
     * is rare enough not to be worth widening every flush's batch for).
     * `null` means the store predates the seam - the caller then degrades to
     * the direct-child answer rather than inferring anything.
     */
    const descendantCache = new Map<string, StoreResult<string[]> | null>();
    if (descendants !== null) {
      for (const hint of hintKeys) {
        descendantCache.set(
          hint,
          descendants.ok
            ? { ok: true, value: descendants.value.get(hint) ?? [] }
            : { ok: false, error: descendants.error }
        );
      }
    }
    const descendantsFor = async (
      directory: string
    ): Promise<StoreResult<string[]> | null> => {
      if (descendantCache.has(directory)) {
        return descendantCache.get(directory) ?? null;
      }
      const fetched = await this.#listActiveDescendants(
        collection.name,
        directory
      );
      descendantCache.set(directory, fetched);
      return fetched;
    };

    /**
     * Directories whose REMOVAL was already established when the event was
     * classified (`#widenVanishedExactPaths`). Kept as intent so a directory
     * recreated between that classification and this enumeration cannot narrow
     * a subtree removal back to direct children.
     */
    const subtreeIntent = new Set<string>();
    for (const [directory, entry] of live) {
      if (entry.subtree) {
        subtreeIntent.add(directory);
      }
    }

    /**
     * Every observation that asks for a given reconciliation KEY, unioned
     * BEFORE any reconciliation runs.
     *
     * Computed up front rather than accumulated as directories are visited
     * because the suppression rule is "suppressed at EVERY contributing
     * observation": a witness discovered after the candidate filter already ran
     * could not be consulted, and the first caller's observations would silently
     * decide the question for everyone.
     *
     * Scoped PER KEY, and that is the whole point. An entry contributes its
     * directory-level witnesses to its own directory key, and each hint's own
     * witnesses to that hint - never the entry's whole set to every hint it
     * carries. Unioning up front and per entry meant an event naming sibling
     * hint `b` was counted as evidence about candidates under hint `a`: with two
     * suppressed `a` observations and one unsuppressed `b` observation between
     * them, `a`'s witness set contained an instant at which `a/doc.md` was not
     * suppressed, so "suppressed at every observation" failed and GNO's own
     * surviving write reached `syncPaths` (R4). Only observations that actually
     * asked for the same key are unioned; the up-front property is unchanged.
     */
    const observationsFor = new Map<string, ObservationSet>();
    const askFor = (key: string, observations: ObservationSet): void => {
      const existing = observationsFor.get(key);
      if (existing) {
        mergeObservations(existing, observations);
        return;
      }
      observationsFor.set(key, {
        witnesses: new Set(observations.witnesses),
        latestAtMs: observations.latestAtMs,
      });
    };
    for (const [directory, entry] of live) {
      askFor(directory, entry.observations);
      for (const [hint, hintObservations] of entry.hints) {
        askFor(hint, hintObservations);
      }
    }
    for (const [candidate, candidateObservations] of replacements) {
      askFor(candidate, candidateObservations);
    }

    /**
     * The observations of the QUEUED ENTRIES that asked for this directory
     * carry the moment it was seen through to `lastEventAt` (the latest of
     * them) and to the suppression decision for its candidates (all of them).
     */
    const reconcile = async (
      directory: string
    ): Promise<DirectoryReconciliation> => {
      const cached = resolved.get(directory);
      if (cached) {
        return cached;
      }
      const asked = observationsFor.get(directory);
      const observations = asked?.witnesses ?? new Set<Observation>();
      // From the SET's retained maximum, not from the capped witnesses: past
      // `MAX_DIRECTORY_OBSERVATIONS` distinct observations the witness set no
      // longer holds the latest one, and deriving the published timestamp from
      // it reported a stale moment (R7).
      const observedAtMs = asked?.latestAtMs ?? 0;
      const outcome = this.#isReconcilableDirectory(directory, collection)
        ? await this.#reconcileDirectory(collection, walkConfig, {
            directory,
            indexed: indexedFor(directory),
            descendantsFor,
            subtreeIntent: subtreeIntent.has(directory),
            observations,
            observedAtMs,
          })
        : {
            directory,
            candidates: [],
            observedAtMs,
            enumerationFailed: false,
            // Never started, so it owes no terminal outcome.
            started: false,
            failureReported: false,
          };
      resolved.set(directory, outcome);
      return outcome;
    };

    // Replacement candidates are resolved FIRST, so that a key which is also
    // reached as a hint below is already carrying its subtree intent when the
    // (memoized) reconciliation for it runs.
    //
    // Only the batched answer is consulted. Falling back to the per-directory
    // seam here would spend one query per surviving eligible file, which is
    // the per-event cost this whole discriminator exists to avoid; a store
    // that predates the batched seam simply does not get replacement
    // detection, exactly as it does not get subtree-wide hint detection.
    /**
     * The blocked replacement candidates of THIS flush, kept as an exact count
     * plus a bounded sample rather than a list.
     *
     * The failure being described is BATCHED: one failed round trip stores the
     * same error against every key it was asked about. Reporting it per
     * candidate turned that single failure into one callback per candidate -
     * and since every visible file event is a replacement candidate, a checkout
     * or sync-client burst during a store outage emitted thousands of identical
     * diagnostics from one failure, amplifying load and logs exactly when the
     * store is already in trouble (R7/R9). This is the same amplification
     * already bounded for cause STRINGS, applied to the callback COUNT.
     *
     * Retaining only `MAX_DESCRIBED_FAILURES` names keeps the accumulator
     * itself constant-size, so nothing here scales with the burst either.
     */
    let blockedReplacementCount = 0;
    const blockedReplacementSample: string[] = [];
    let blockedReplacementError: unknown;
    if (descendants !== null) {
      for (const candidate of replacements.keys()) {
        if (this.#disposed) {
          break;
        }
        const beneath = descendantCache.get(candidate);
        if (!beneath) {
          continue;
        }
        if (!beneath.ok) {
          // Same rule as a hint: an unanswered query is not "nothing is
          // indexed here". Nothing is inferred - the path keeps its ordinary
          // exact-path flow - and the blocked candidates are reported ONCE,
          // after the loop, as a single bounded aggregate.
          blockedReplacementCount += 1;
          if (blockedReplacementSample.length < MAX_DESCRIBED_FAILURES) {
            blockedReplacementSample.push(candidate);
          }
          if (blockedReplacementCount === 1) {
            blockedReplacementError = beneath.error;
          }
          continue;
        }
        if (beneath.value.length === 0) {
          // An ordinary file that merely shares a name with nothing indexed.
          // It resolves to NOTHING: no enumeration, no reconciliation, no
          // directory fallback - the exact path alone was the whole change.
          continue;
        }
        // Documents are indexed beneath a path that is now a FILE. Whatever
        // the index holds under it is unreachable to the walker, so the
        // removal is established here and the enumeration cannot narrow it.
        subtreeIntent.add(candidate);
        await reconcile(candidate);
      }
    }
    if (blockedReplacementCount > 0) {
      // ONE diagnostic per flush, whatever the burst size. A single blocked
      // candidate keeps its exact attribution - the directory it blocked and
      // the store's own error, unwrapped - because that is the case a reader
      // can act on directly. Beyond one there is no honest per-key attribution
      // to give (the batch failed as a whole), so the event carries a `null`
      // directory and an aggregate cause naming the exact total plus a bounded
      // sample, with the original error preserved underneath.
      const aggregated = blockedReplacementCount > 1;
      const cause = aggregated
        ? new Error(
            `store lookup failed for ${blockedReplacementCount} replacement candidate(s): ${joinBoundedSample(
              blockedReplacementCount,
              blockedReplacementSample.map(boundValue)
            )}`,
            { cause: blockedReplacementError }
          )
        : blockedReplacementError;
      this.#notifyDiagnostic(() =>
        this.#callbacks?.onReconcileFailed?.({
          collection: collection.name,
          directory: aggregated ? null : (blockedReplacementSample[0] ?? null),
          stage: "store",
          cause,
        })
      );
    }

    for (const [directory, entry] of live) {
      if (this.#disposed) {
        break;
      }
      // No hint at all means the affected directory itself is the only area we
      // can honestly claim changed.
      let needsDirectory = entry.hints.size === 0;
      for (const hint of entry.hints.keys()) {
        if (this.#disposed) {
          break;
        }
        // Subtree-aware where the store supports it, direct children where it
        // does not. Either way an unanswered store query is never read as
        // "nothing is there".
        const hintIndexed = (await descendantsFor(hint)) ?? indexedFor(hint);
        if (!hintIndexed.ok) {
          // The discriminator itself failed. This is NOT "nothing is indexed
          // here": collapsing the two would let a store outage silently turn a
          // deleted subtree into a parent-directory reconciliation, with the
          // descendants left active and no diagnostic at all (R7/R9). Report it
          // against the hint it blocked and infer nothing from it - the hint is
          // never reconciled, so nothing under it can deactivate. The affected
          // directory is still reconciled from DISK, which is what catches an
          // atomic-save sibling in the same window.
          this.#notifyDiagnostic(() =>
            this.#callbacks?.onReconcileFailed?.({
              collection: collection.name,
              directory: hint,
              stage: "store",
              cause: hintIndexed.error,
            })
          );
          needsDirectory = true;
          continue;
        }
        if (hintIndexed.value.length === 0) {
          // Nothing active is indexed under this hint: it is not a deleted
          // indexed directory, so the event means a file changed in the
          // affected directory.
          needsDirectory = true;
          continue;
        }
        const hintOutcome = await reconcile(hint);
        if (
          hintOutcome.candidates.length === 0 &&
          !hintOutcome.enumerationFailed
        ) {
          // An unreadable hint directory is NOT retried through its parent: it
          // failed closed on purpose.
          needsDirectory = true;
        }
      }
      if (needsDirectory && !this.#disposed) {
        await reconcile(directory);
      }
    }

    // Every STARTED reconciliation is returned, including the ones that
    // resolved to nothing: the caller owes each of them a terminal outcome, and
    // filtering empty outcomes away here is what previously made a successful
    // zero-candidate reconciliation disappear between start and completion.
    return [...resolved.values()].filter((outcome) => outcome.started);
  }

  /**
   * Union the eligible disk children and the active indexed children.
   *
   * `indexed` is the pre-resolved answer from the flush's single batched store
   * lookup, passed in rather than fetched here so one directory is never
   * queried twice within a flush.
   */
  async #reconcileDirectory(
    collection: Collection,
    walkConfig: WalkConfig,
    work: ReconciliationWork
  ): Promise<DirectoryReconciliation> {
    const {
      directory,
      indexed,
      descendantsFor,
      subtreeIntent,
      observations,
      observedAtMs,
    } = work;
    this.#notifyDiagnostic(() =>
      this.#callbacks?.onReconcileStart?.({
        collection: collection.name,
        directory,
      })
    );

    // A directory carrying REMOVAL INTENT reads the disk recursively, because
    // the disk may disagree with that intent: the directory can have been
    // RECREATED between classification and here. When it has, a direct-children
    // read describes only the top of the recreated tree, so a file written into
    // a recreated NESTED subdirectory appears in neither half of the union -
    // not on the enumerated disk side, not in the old indexed-descendant set -
    // and on Linux no further event ever names it (bun#15390/#15939: writes
    // inside a directory created after the watch began are not reported), so it
    // stays unindexed until a manual `gno update`. Genuinely missing
    // directories cost nothing extra: the enumeration returns `missing` at the
    // first `readdir` either way.
    //
    // The collection ROOT is deliberately excluded. Recursing from `""` is a
    // whole-collection walk, which is the one thing directory reconciliation
    // exists not to do; a recreated root is a whole-collection event and
    // belongs to `gno update`. Its indexed side still deactivates everything
    // (see `#listActiveCollectionPaths` below).
    const enumerate =
      subtreeIntent && directory !== ""
        ? listEligibleSubtreeFiles
        : listEligibleDirectChildren;
    const disk = await enumerate(directory, walkConfig);
    if (disk.status === "error") {
      // Fail closed: an unreadable directory must never be read as an
      // authoritative empty directory, or live documents would deactivate.
      this.#notifyDiagnostic(() =>
        this.#callbacks?.onReconcileFailed?.({
          collection: collection.name,
          directory,
          stage: "enumerate",
          cause: disk.cause,
        })
      );
      return {
        directory,
        candidates: [],
        observedAtMs,
        enumerationFailed: true,
        started: true,
        failureReported: true,
      };
    }

    const candidates = new Set<string>(
      disk.status === "present" ? disk.relPaths : []
    );

    // A directory that is GONE takes its WHOLE removed subtree, not just its
    // direct children. The reported path can sit at any depth, so a deleted
    // `dir1/` whose documents live in `dir1/sub/` would otherwise leave every
    // one of them active - the "direct children only" limitation this change
    // removes. A directory that is still PRESENT stays deliberately narrow: it
    // is usually a temp-file event, and its nested documents did not change.
    //
    // `subtreeIntent` is the SECOND way in, and it is not redundant with the
    // enumeration: the removal may have been established one classification
    // earlier, and the directory recreated since. Re-deriving the answer from
    // this enumeration alone would then narrow it back to direct children and
    // strand the nested documents that really did go. The recreated files are
    // safe either way - `syncPaths` stats every candidate.
    //
    // `skipped` is the THIRD way in, and it widens for a different reason. The
    // directory exists, but a symlink stands at it or above it, so the walker
    // reaches NOTHING under it - not one level, the whole subtree. Taking the
    // direct-children indexed side there would leave a document one level
    // deeper active forever. It needs no special deactivation path of its own:
    // `syncPaths` enforces the same no-follow policy (`checkWalkPathVisibility`)
    // and marks every one of these paths inactive through the ordinary batch.
    const removed =
      disk.status === "missing" || disk.status === "skipped" || subtreeIntent;
    let indexedSide = indexed;
    if (removed) {
      // The collection ROOT is the one directory with no bounded subtree. When
      // it is genuinely absent every active document in the collection is
      // implicated, and the descendant seam cannot express that (`""` has no
      // prefix range), so the whole-collection seam answers instead. A root
      // that merely could not be READ never reaches here: that is an
      // `enumerate` failure above, and it fails closed.
      indexedSide =
        (directory === ""
          ? await this.#listActiveCollectionPaths(collection.name)
          : await descendantsFor(directory)) ?? indexed;
    }

    // The indexed side is what makes deletion work: a vanished file leaves
    // nothing on disk to enumerate, so its relPath can only come from the
    // store, and `syncPaths` marks it inactive through its own ENOENT branch.
    if (indexedSide.ok) {
      for (const relPath of indexedSide.value) {
        candidates.add(relPath);
      }
    } else {
      this.#notifyDiagnostic(() =>
        this.#callbacks?.onReconcileFailed?.({
          collection: collection.name,
          directory,
          stage: "store",
          cause: indexedSide.error,
        })
      );
    }

    const root = normalize(collection.path);
    return {
      directory,
      // Suppression applies to the RESOLVED candidate paths, not to the
      // directory: an application-originated write inside a reconciled
      // directory must stay suppressed - but only while it still EXISTS. See
      // `#isSuppressedSurvivor`.
      candidates: await this.#dropSuppressedSurvivors(
        root,
        [...candidates],
        observations
      ),
      observedAtMs,
      enumerationFailed: false,
      started: true,
      // A store failure is already a reported terminal outcome for this
      // directory: the disk half may still yield candidates, but the
      // reconciliation was partial and must not also be claimed as complete.
      failureReported: !indexedSide.ok,
    };
  }

  /**
   * Active indexed source paths beneath SEVERAL directories in one round trip.
   *
   * This is the flush's hint DISCRIMINATOR: for each vanished reported name it
   * answers "is anything indexed under here?", which is the only way to tell a
   * recursively deleted directory from a dead temporary filename. Batched so
   * that unique-temp-name churn costs one query per window rather than one per
   * filename.
   *
   * Never throws. `null` means the store predates the seam, and each hint falls
   * back to the direct-child answer.
   */
  async #listActiveDescendantsBatch(
    collectionName: string,
    directories: string[]
  ): Promise<StoreResult<Map<string, string[]>> | null> {
    if (directories.length === 0) {
      return { ok: true, value: new Map() };
    }
    const store = this.#store as Partial<SqliteAdapter> | null;
    if (typeof store?.listActiveDescendantSourcePathsBatch !== "function") {
      return null;
    }
    try {
      return await store.listActiveDescendantSourcePathsBatch(
        collectionName,
        directories
      );
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message:
            cause instanceof Error
              ? cause.message
              : "active descendant query failed",
          cause,
        },
      };
    }
  }

  /**
   * Every active indexed source path in the collection.
   *
   * Reached only when the collection ROOT was observed ABSENT from disk, which
   * is a whole-collection event by definition: the bounded seams cannot answer
   * it (the descendant lookup rejects `""` because a root prefix range has no
   * bound, and the direct-children lookup returns only the root's own files,
   * stranding every nested document). A root that is present, or merely
   * unreadable, never gets here.
   *
   * Never throws. `null` means the store predates the seam, and the caller
   * degrades to the direct-child answer it already holds - narrower than ideal,
   * never wrong.
   */
  async #listActiveCollectionPaths(
    collectionName: string
  ): Promise<StoreResult<string[]> | null> {
    const store = this.#store as Partial<SqliteAdapter> | null;
    if (typeof store?.listActiveSourcePaths !== "function") {
      return null;
    }
    try {
      return await store.listActiveSourcePaths(collectionName);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message:
            cause instanceof Error
              ? cause.message
              : "active collection paths query failed",
          cause,
        },
      };
    }
  }

  /**
   * Active indexed source paths anywhere beneath ONE directory.
   *
   * The on-demand companion to the batched form: used for a dirty directory
   * that turns out to be gone, which is rare enough not to be worth widening
   * every flush's batch for.
   *
   * Never throws. `null` means the store predates the seam, and the caller
   * degrades to the direct-child answer it already holds - narrower than ideal,
   * never wrong. A store FAILURE is a `StoreResult` error, so nothing is
   * deactivated on the strength of an unanswered query.
   */
  async #listActiveDescendants(
    collectionName: string,
    directory: string
  ): Promise<StoreResult<string[]> | null> {
    const store = this.#store as Partial<SqliteAdapter> | null;
    if (typeof store?.listActiveDescendantSourcePaths !== "function") {
      return null;
    }
    try {
      return await store.listActiveDescendantSourcePaths(
        collectionName,
        directory
      );
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message:
            cause instanceof Error
              ? cause.message
              : "active descendant query failed",
          cause,
        },
      };
    }
  }

  /**
   * Resolve the active indexed direct children of many directories at once.
   *
   * Never throws: a store failure is reported, never inferred from.
   *
   * Prefers the batched seam so a whole flush costs ONE round trip. The
   * per-directory seam remains a supported fallback for a store that predates
   * the batched one; it is a correctness-preserving degradation, not a second
   * strategy, and it restores the per-hint query cost the batch exists to
   * remove. A store exposing neither seam fails closed.
   */
  async #listActiveDirectChildrenBatch(
    collectionName: string,
    directories: string[]
  ): Promise<StoreResult<Map<string, string[]>>> {
    if (directories.length === 0) {
      return { ok: true, value: new Map() };
    }
    const store = this.#store as Partial<SqliteAdapter> | null;
    try {
      if (typeof store?.listActiveDirectChildSourcePathsBatch === "function") {
        return await store.listActiveDirectChildSourcePathsBatch(
          collectionName,
          directories
        );
      }
      if (typeof store?.listActiveDirectChildSourcePaths === "function") {
        const byDirectory = new Map<string, string[]>();
        for (const directory of directories) {
          const result = await store.listActiveDirectChildSourcePaths(
            collectionName,
            directory
          );
          if (!result.ok) {
            return result;
          }
          byDirectory.set(directory, result.value);
        }
        return { ok: true, value: byDirectory };
      }
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message:
            cause instanceof Error
              ? cause.message
              : "active direct children query failed",
          cause,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "store does not expose listActiveDirectChildSourcePaths",
      },
    };
  }

  #notifySettledIfIdle(): void {
    if (
      this.#syncing.size === 0 &&
      ![...this.#pendingByCollection.values()].some(
        (relPaths) => relPaths.size > 0
      ) &&
      ![...this.#dirtyByCollection.values()].some(
        (directories) => directories.size > 0
      )
    ) {
      this.#callbacks?.onSettled?.();
    }
  }

  #afterSync(collection: Collection, relPaths: string[]): void {
    if (this.#disposed || relPaths.length === 0) {
      return;
    }

    this.#lastSyncAt = new Date().toISOString();
    this.#scheduler?.notifySyncComplete(relPaths);

    if (!this.#eventBus) {
      return;
    }

    for (const relPath of relPaths) {
      const event: DocumentEvent = {
        type: "document-changed",
        uri: `gno://${collection.name}/${relPath.split(sep).join("/")}`,
        collection: collection.name,
        relPath,
        origin: "watcher",
        changedAt: new Date().toISOString(),
      };
      this.#eventBus.emit(event);
    }
  }
}
