/**
 * Destination safety for every path GNO itself WRITES into a collection.
 *
 * The walker's no-follow reachability policy lives in exactly one place
 * (`checkWalkPathVisibility`, beside `matchesWalkPath`) and `syncPaths` resolves
 * every candidate through it. That is right for READS: a path the walker cannot
 * reach reads as gone, and an indexed document under an alias deactivates.
 *
 * It is not sufficient for WRITES. `mkdir(dir, { recursive: true })` does NOT
 * guarantee real directories - it happily FOLLOWS an existing directory symlink
 * - so a capture beneath `alias -> real/` (or worse, `alias -> /outside`) writes
 * the file through the alias and only THEN asks the index about it. The index
 * correctly answers "not reachable", and a caller that treats any non-`error`
 * sync result as success reports a successful capture of a file that is not
 * indexed, or - for an escaping alias - of a file written outside the collection
 * entirely. Both halves of that failure are fixed here:
 *
 * - `prepareCaptureDestination` proves and creates the parent chain BEFORE the
 *   write, component by component, refusing to follow any symlink below the
 *   collection root. Nothing is written through an alias, and an escaping alias
 *   is still reported as a containment error.
 * - `requireActiveCaptureDocument` is the proof a caller must demand AFTER the
 *   write: an ACTIVE document must actually exist for the path's effective
 *   source path (`COALESCE(record_source_path, rel_path)`). "The sync
 *   result was not an error" is not that proof - `skipped` and `unchanged` are
 *   both non-errors and neither implies an indexed document.
 *
 * The policy itself is NOT restated here. Reachability is asked of
 * `checkWalkPathVisibility` exactly as `syncPaths` and `directory-children` ask
 * it, so the write path, the enumeration seam and a full `gno update` cannot
 * disagree about what is indexable.
 *
 * @module src/ingestion/capture-destination
 */

// node:fs/promises structure/link operations have no Bun equivalent.
import { mkdir, readlink, realpath } from "node:fs/promises";
// node:path has no Bun path utilities.
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { DocumentRow, StorePort } from "../store/types";
import type { FileSyncResult, WrittenPathHandle } from "./types";

import { normalizeCollectionDirRelPath } from "../core/path-rules";
import { MAX_WRITTEN_RECORD_URIS } from "./types";
import { checkWalkPathVisibility } from "./walker";

/**
 * Why a destination was refused.
 *
 * `PATH_OUTSIDE_COLLECTION` is deliberately the same name `syncPaths` reports
 * for a containment failure: an alias pointing out of the collection has to stay
 * a containment error whichever side observes it first.
 */
export type CaptureDestinationErrorCode =
  | "PATH_OUTSIDE_COLLECTION"
  | "PATH_NOT_WALKABLE"
  | "PATH_UNRESOLVED"
  | "NOT_DIRECTORY";

/** Refusal to write at a destination the indexer could never reach. */
export class CaptureDestinationError extends Error {
  readonly code: CaptureDestinationErrorCode;
  readonly relPath: string;

  constructor(
    code: CaptureDestinationErrorCode,
    message: string,
    relPath: string
  ) {
    super(message);
    this.name = "CaptureDestinationError";
    this.code = code;
    this.relPath = relPath;
  }
}

/** True when `candidate` is at or below `rootReal`. */
function isContained(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `errno`-style code of a rejected filesystem operation, if it carried one. */
function errnoOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Canonicalize a path that may not exist yet.
 *
 * `realpath` on a dangling target fails, and the lexical target is NOT a safe
 * substitute for the answer we need: containment is judged against the
 * canonical collection root, so a lexical path disagrees with it whenever the
 * root itself is reached through a symlink (`/tmp -> /private/tmp` on macOS is
 * the everyday case) or whenever the missing target sits under an existing
 * symlinked ancestor. Both make a merely-unreachable alias look like an escape.
 *
 * So: canonicalize the deepest ancestor that DOES exist and re-append the
 * missing tail. That is the path the target would have if it were created,
 * which is exactly what containment has to be decided on.
 *
 * @returns the canonical path, or the `errno` of the failure that stopped
 *   resolution - anything other than a missing component (`EACCES`, `EIO`,
 *   `ENOTDIR`, `ELOOP`, ...) is a genuine resolution failure and must not be
 *   answered with a guess.
 */
async function canonicalizePossiblyMissing(
  target: string
): Promise<{ ok: true; path: string } | { ok: false; errno: string }> {
  const missingTail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return {
        ok: true,
        path:
          missingTail.length === 0
            ? real
            : join(real, ...missingTail.slice().reverse()),
      };
    } catch (cause) {
      const errno = errnoOf(cause) ?? "UNKNOWN";
      if (errno !== "ENOENT") return { ok: false, errno };
      const parent = dirname(current);
      if (parent === current) {
        // Walked to the filesystem root without finding anything that exists.
        return { ok: false, errno: "ENOENT" };
      }
      missingTail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Classify a symlink component: does it escape the collection, or is it merely
 * out of the walker's reach?
 *
 * Both are refusals, but they are not the same refusal, and the distinction is
 * user-visible: an escaping alias is a containment failure and must not be
 * softened into "not indexable".
 */
async function classifySymlinkComponent(
  collectionPath: string,
  absPath: string,
  relPath: string
): Promise<CaptureDestinationError> {
  let rootReal: string;
  try {
    rootReal = await realpath(collectionPath);
  } catch {
    return new CaptureDestinationError(
      "PATH_UNRESOLVED",
      `Collection root could not be resolved while validating ${relPath}.`,
      relPath
    );
  }

  let target: string;
  try {
    const link = await readlink(absPath);
    target = isAbsolute(link) ? link : resolve(dirname(absPath), link);
  } catch {
    return new CaptureDestinationError(
      "PATH_UNRESOLVED",
      `Symlink ${absPath} could not be read while validating ${relPath}.`,
      relPath
    );
  }

  // A DANGLING alias still has a destination, so `alias -> /outside/missing`
  // stays a containment error rather than becoming "unreadable". But only a
  // MISSING component justifies resolving past the failure: `EACCES`, `EIO`,
  // `ENOTDIR`, `ELOOP` and friends mean we do not know where the alias points,
  // and guessing there is how a real escape gets reported as merely
  // unreachable. Those fail as `PATH_UNRESOLVED`.
  const canonical = await canonicalizePossiblyMissing(target);
  if (!canonical.ok) {
    return new CaptureDestinationError(
      "PATH_UNRESOLVED",
      `Refusing to write ${relPath}: the target of symlink ${absPath} could not be resolved (${canonical.errno}).`,
      relPath
    );
  }
  const resolved = canonical.path;

  if (isContained(rootReal, resolved)) {
    return new CaptureDestinationError(
      "PATH_NOT_WALKABLE",
      `Refusing to write ${relPath}: ${absPath} is a symlink, and the indexer never follows symlinks below the collection root, so the file would not be indexed.`,
      relPath
    );
  }
  return new CaptureDestinationError(
    "PATH_OUTSIDE_COLLECTION",
    `Refusing to write ${relPath}: ${absPath} is a symlink resolving outside the collection root.`,
    relPath
  );
}

/** Create exactly one component, never recursively, never through a symlink. */
async function createComponent(
  absPath: string,
  relPath: string
): Promise<void> {
  try {
    await mkdir(absPath);
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    if (code === "EEXIST") {
      // Someone else won the race. The re-proof below decides whether what
      // landed there is acceptable.
      return;
    }
    throw new CaptureDestinationError(
      "PATH_UNRESOLVED",
      `Failed to create parent directory ${absPath} for ${relPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      relPath
    );
  }
}

/**
 * Prove - and where absent, create - the parent chain of a collection-relative
 * write target without following any symlink below the collection root.
 *
 * Replaces `mkdir(dirname(absPath), { recursive: true })` at every capture and
 * note-creation site. `recursive: true` is not equivalent: it treats an existing
 * directory symlink as "already there" and writes through it.
 *
 * The collection ROOT stays exempt, exactly as it is for the walker: it is
 * legitimately a symlink (`/tmp -> /private/tmp`).
 *
 * Like `checkWalkPathVisibility`, this is component-by-component on path
 * strings and therefore not atomic; a component can be replaced by a symlink
 * after it is proven. The post-write `requireActiveCaptureDocument` proof is
 * what makes that residual window non-silent: the file is written, the index
 * refuses it, and the caller reports a failure instead of success.
 *
 * @returns the absolute destination path, proven reachable at the time of the
 *   check.
 * @throws CaptureDestinationError - nothing has been written when it throws.
 */
export async function prepareCaptureDestination(
  collectionPath: string,
  relPath: string
): Promise<string> {
  const normalized = normalizeCollectionDirRelPath(relPath);
  if (normalized === null) {
    throw new CaptureDestinationError(
      "PATH_OUTSIDE_COLLECTION",
      `Refusing to write ${relPath}: the path escapes the collection root.`,
      relPath
    );
  }
  if (normalized === "") {
    throw new CaptureDestinationError(
      "NOT_DIRECTORY",
      `Refusing to write ${relPath}: the path is the collection root, not a file.`,
      relPath
    );
  }

  const segments = normalized.split("/");
  const parents = segments.slice(0, -1);
  let walked = "";
  for (const segment of parents) {
    walked = walked === "" ? segment : `${walked}/${segment}`;
    const absPath = join(collectionPath, ...walked.split("/"));
    const visibility = await checkWalkPathVisibility(collectionPath, walked);
    if (visibility.status === "symlink") {
      throw await classifySymlinkComponent(
        collectionPath,
        visibility.absPath,
        relPath
      );
    }
    if (visibility.status === "error") {
      throw new CaptureDestinationError(
        "PATH_UNRESOLVED",
        `Refusing to write ${relPath}: ${absPath} could not be examined.`,
        relPath
      );
    }
    if (visibility.status === "visible") {
      if (visibility.leaf?.isDirectory()) {
        continue;
      }
      throw new CaptureDestinationError(
        "NOT_DIRECTORY",
        `Refusing to write ${relPath}: ${absPath} exists and is not a directory.`,
        relPath
      );
    }

    await createComponent(absPath, relPath);
    // Re-prove what we just created rather than assuming it: `EEXIST` above is
    // swallowed, and only this decides whether the winner of that race is a
    // real directory.
    const proven = await checkWalkPathVisibility(collectionPath, walked);
    if (proven.status === "symlink") {
      throw await classifySymlinkComponent(
        collectionPath,
        proven.absPath,
        relPath
      );
    }
    if (!(proven.status === "visible" && proven.leaf?.isDirectory())) {
      throw new CaptureDestinationError(
        "PATH_UNRESOLVED",
        `Refusing to write ${relPath}: ${absPath} is not a usable directory after creation.`,
        relPath
      );
    }
  }

  const absPath = join(collectionPath, ...segments);
  const leaf = await checkWalkPathVisibility(collectionPath, normalized);
  if (leaf.status === "symlink") {
    // The leaf counts too: `Bun.Glob.scan({ followSymlinks: false })` emits
    // neither a symlinked directory nor a symlinked regular file, so writing
    // through a symlinked FILE name is just as unindexable as writing under a
    // symlinked directory.
    throw await classifySymlinkComponent(collectionPath, leaf.absPath, relPath);
  }
  if (leaf.status === "error") {
    throw new CaptureDestinationError(
      "PATH_UNRESOLVED",
      `Refusing to write ${relPath}: ${absPath} could not be examined.`,
      relPath
    );
  }
  if (leaf.status === "visible" && leaf.leaf && !leaf.leaf.isFile()) {
    throw new CaptureDestinationError(
      "NOT_DIRECTORY",
      `Refusing to write ${relPath}: ${absPath} exists and is not a regular file.`,
      relPath
    );
  }
  return absPath;
}

/**
 * Outcome of demanding an indexed document for a just-written path.
 *
 * The success side is a UNION because the two shapes are genuinely different
 * things, and collapsing them is what produced incoherent receipts:
 *
 * - `kind: "file"` - the written path IS the document. Its `docid`/`uri`
 *   describe the same path the caller wrote, so a receipt may carry both.
 * - `kind: "record-container"` - the written path is a container that was
 *   imported as N logical record documents, each living at a virtual
 *   `.gno/records/...` rel path. There is no document AT the written path, and
 *   with N records there is no single "the" document either. A caller must not
 *   pair one arbitrary record's `docid` with the container's physical URI: the
 *   two would name different things, and `getDocumentByUri` (an exact lookup)
 *   resolves the physical URI to nothing.
 *
 * The failure side carries `failure` because "the store could not answer" and
 * "the store answered: nothing indexed here" are different facts with different
 * consequences. A post-write caller reports both as a failed capture, but a
 * caller asking about a file it did NOT write (the opened-existing paths) has
 * to keep propagating a store error as an error rather than downgrading it into
 * the far calmer "not indexed yet".
 */
export type ActiveCaptureDocument =
  | { ok: true; kind: "file"; document: DocumentRow }
  | { ok: true; kind: "record-container"; records: DocumentRow[] }
  | { ok: false; failure: "store-error" | "not-indexed"; message: string };

/** The success side of {@link ActiveCaptureDocument}. */
export type ActiveCaptureProof = Extract<ActiveCaptureDocument, { ok: true }>;

/**
 * The docid a receipt may honestly carry for a proven write.
 *
 * `undefined` for a record container: the container path has no document of its
 * own, and any one of its N records would disagree with the receipt's URI.
 */
export const captureProofDocid = (
  proof: ActiveCaptureProof
): string | undefined =>
  proof.kind === "file" ? proof.document.docid : undefined;

/**
 * One phrasing of the container fact, for every surface that has to state it.
 *
 * `undefined` for a plain file - there is nothing unusual to say about it.
 * Returned as a sentence FRAGMENT so each caller can finish the sentence with
 * the consequence its own surface has (no docid, an unresolvable URI, ...).
 */
export const captureProofContainerSummary = (
  proof: ActiveCaptureProof
): string | undefined => {
  if (proof.kind !== "record-container") return undefined;
  const count = proof.records.length;
  return `imported as ${count} logical record document${count === 1 ? "" : "s"} at virtual paths; the container path itself has no document`;
};

/**
 * The consequence the container fact has for a RECEIPT.
 *
 * A capture receipt ({@link CaptureReceipt}) carries a `uri` for the written
 * FILE and an optional `docid`, and a container has no document at that path -
 * so the honest thing to say about a receipt is that its `docid` is absent
 * rather than lost. Only surfaces with a docid contract may say this.
 */
export const CAPTURE_CONTAINER_RECEIPT_CONSEQUENCE =
  "so this receipt carries no docid";

/**
 * The consequence the container fact has for a HANDLE.
 *
 * {@link WrittenPathHandle} and the SDK's `GnoCreateNoteResult` have no docid
 * field at all, so "carries no docid" would name a contract they do not have.
 * What their caller loses is the single fetchable URI, and what it gets
 * instead is `recordUris` - which both shapes actually carry.
 */
export const CAPTURE_CONTAINER_HANDLE_CONSEQUENCE =
  "so there is no single fetchable URI for it - fetch the records in recordUris instead";

/**
 * The container FACT plus the consequence the calling surface actually has.
 *
 * The fact - this write produced a record container, indexed as N logical
 * record documents with nothing at the written path - is identical everywhere
 * and is composed once, in {@link captureProofContainerSummary}. The
 * CONSEQUENCE is not: a receipt loses its docid, a handle loses its single
 * fetchable URI, a duplicate loses the target URI's resolvability. Sharing the
 * consequence too is how a receipt sentence ended up on a shape with no docid
 * contract, which was simply false there. Each caller passes its own.
 */
export const captureProofContainerReason = (
  proof: ActiveCaptureProof,
  wording: { lead: string; consequence: string }
): string | undefined => {
  const summary = captureProofContainerSummary(proof);
  return summary === undefined
    ? undefined
    : `${wording.lead}: ${summary}, ${wording.consequence}.`;
};

/**
 * The `sync.reason` that keeps a container receipt from reading as a plain
 * document capture whose docid merely went missing.
 *
 * `consequence` defaults to the receipt's, because every surface that renders
 * a `sync.reason` into a {@link CaptureReceipt} has a docid contract. A caller
 * whose shape does not (the written handle, `createNote`) passes its own.
 */
export const captureProofSyncReason = (
  proof: ActiveCaptureProof,
  consequence: string = CAPTURE_CONTAINER_RECEIPT_CONSEQUENCE
): string | undefined =>
  captureProofContainerReason(proof, {
    lead: "Written as a record container",
    consequence,
  });

/**
 * Where the per-record failures are, for a caller holding the SYNC RESULT.
 *
 * True only where the shape carrying this sentence sits inside a `SyncResult`
 * whose `collections[].files[].recordImport` the same caller can read - which
 * is the create/capture JOB result (`GET /api/jobs/:id` returns the whole
 * `SyncResult`, and `syncCollection` populates `files`). Nothing else.
 */
export const CAPTURE_FAILURES_ON_SYNC_RESULT =
  "See this sync job result's collections[].files[].recordImport.failures for each rejected record.";

/**
 * Where the per-record failures are, for every caller that does NOT hold the
 * sync result.
 *
 * A capture receipt, a `createNote` result and a duplicate warning all carry
 * the COUNT of rejected records and none of the failures themselves, so
 * pointing them at `recordImport.failures` named a field they have no route
 * to. It says so, and names a route that exists: a record container is
 * re-imported on every collection sync - `SyncService.processFile` hands a
 * file with a configured record adapter to `processRecordContainer` before the
 * unchanged/skip decision is ever reached - so re-syncing re-derives the same
 * failures, and `formatSyncResultLines` prints each one's code, source locator
 * and message under `--verbose`.
 */
export const CAPTURE_FAILURES_NOT_CARRIED =
  "This response does not carry the per-record failures; re-run the collection sync with `gno update --verbose`, which re-imports the container and prints each rejected record.";

/**
 * The `sync.reason` fragment for a record import that did NOT take everything
 * the written file offered.
 *
 * The container path's own sync result is a non-error whenever the adapter
 * accepted at least ONE record - a `.jsonl` export with one good line and one
 * malformed line is `added`/`updated`, not `error`. The rejected lines are
 * disclosed only in `recordImport.failures`, so a receipt that reports
 * `completed` and stops there tells the caller their malformed capture was
 * fully imported. The same holds for a PARTIAL snapshot: records the adapter
 * never saw were preserved from the previous import, not refreshed.
 *
 * `undefined` for a fully successful import (and for a file that is not a
 * record container at all), so a clean capture reads exactly as it did before.
 *
 * `pointer` is where THIS surface's caller can reach the failures themselves.
 * The fact (N records rejected) is shareable; the route to their detail is
 * not, so it defaults to {@link CAPTURE_FAILURES_NOT_CARRIED} - the honest
 * answer for every shape that carries only the count.
 */
export const captureRecordImportReason = (
  recordImport: FileSyncResult["recordImport"],
  pointer: string = CAPTURE_FAILURES_NOT_CARRIED
): string | undefined => {
  if (!recordImport) return undefined;
  const { accepted, failed } = recordImport.records;
  const partialSnapshot = recordImport.snapshotState === "partial";
  if (failed === 0 && !partialSnapshot) return undefined;
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(
      `${failed} record${failed === 1 ? "" : "s"} rejected by the ${recordImport.adapterId} adapter and NOT indexed (${accepted} accepted)`
    );
  }
  if (partialSnapshot) {
    parts.push(
      "the adapter reported a partial snapshot, so records it did not see were preserved from the previous import rather than refreshed"
    );
  }
  // Only a REJECTION has per-record detail to point at. A partial snapshot
  // names no individual record, so a pointer there would send the caller
  // looking for a list that does not exist.
  const suffix = failed > 0 ? ` ${pointer}` : "";
  return `Record import was partial: ${parts.join("; ")}.${suffix}`;
};

/**
 * The whole `sync.reason` a proven capture receipt should carry.
 *
 * Two independent facts can need stating about one write - the path is a
 * container and the import was partial (so some of what was written is not
 * indexed) - and they are orthogonal: a container can import cleanly, and
 * either fact alone must still be said. The capture surfaces that share this
 * receipt shape (CLI `gno capture`, MCP `gno_capture`, SDK `capture()`, REST
 * resident capture) all compose them here so none of them can drift into
 * reporting only half of it.
 *
 * What is composed here is the FACTS. Their consequences are surface-specific
 * and are passed in: what the container costs THIS shape, and where THIS
 * caller can reach the rejected records. The defaults are the receipt's,
 * because the receipt is what most callers of this composer render; a shape
 * with no docid contract, or one that carries its own sync result, overrides
 * them rather than inheriting a sentence that is false of it.
 *
 * `undefined` when there is nothing unusual to say, which is the entire
 * ordinary case.
 */
export const captureSyncReason = (
  proof: ActiveCaptureProof,
  recordImport?: FileSyncResult["recordImport"],
  wording: { containerConsequence?: string; failurePointer?: string } = {}
): string | undefined => {
  const stated = [
    captureProofSyncReason(proof, wording.containerConsequence),
    captureRecordImportReason(recordImport, wording.failurePointer),
  ].filter((reason): reason is string => reason !== undefined);
  return stated.length === 0 ? undefined : stated.join(" ");
};

/**
 * The one file result a single-path write cares about, out of a whole-collection
 * sync.
 *
 * The 202 create paths sync the COLLECTION, not just the file they wrote, so the
 * per-file receipt they need (`recordImport` above all) has to be picked back
 * out. Compared on the posix form because a receipt built from a platform
 * `relPath` and a walker entry must not miss each other on Windows.
 */
export const captureFileSyncResult = (
  result: { files?: FileSyncResult[] },
  relPath: string
): FileSyncResult | undefined => {
  const wanted = relPath.split(sep).join("/");
  return result.files?.find(
    (file) => file.relPath.split(sep).join("/") === wanted
  );
};

/**
 * The bounded URI page a container handle may carry, plus the exact count.
 *
 * A container is not a small thing. One valid `.jsonl` export can hold six
 * figures of records, and every consumer of this page keeps or copies it far
 * past the write: the job manager retains up to 100 completed jobs for an hour,
 * and the `document-changed` frame is JSON-encoded once per connected SSE
 * client. Listing every URI therefore turned one ordinary write into megabytes
 * of retained strings and a multi-megabyte event frame - while the record
 * IMPORT receipt sitting beside it has been capped at
 * {@link MAX_WRITTEN_RECORD_URIS} items all along. Same cap here.
 *
 * What the page costs is stated precisely, in both directions: the page is the
 * first records (never empty for a proven container) and `recordCount` is
 * exact, but the records past the page are not listed HERE. There is no
 * DEDICATED per-container enumeration endpoint - and there is also no need to
 * claim the omitted records are unreachable, because they are not. Every
 * record URI shares the container's virtual `.gno/records/<id>/` prefix, so a
 * prefix-scoped listing (`GnoClient.list({ scope })`, `gno ls <scope>`)
 * enumerates exactly that container, and ordinary collection paging returns
 * every logical record with `relPath` projected from the container's own path
 * for client-side selection. The handle names those mechanisms instead of
 * either inventing a continuation or denying the ones that exist.
 */
export const captureWrittenRecordPage = (
  records: readonly Pick<DocumentRow, "uri">[]
): {
  recordCount: number;
  recordUris: string[];
  recordUrisTruncated: number;
} => {
  const recordUris = records
    .slice(0, MAX_WRITTEN_RECORD_URIS)
    .map((record) => record.uri);
  return {
    recordCount: records.length,
    recordUris,
    recordUrisTruncated: records.length - recordUris.length,
  };
};

/**
 * The sentence a truncated page owes its caller.
 *
 * `undefined` when the page is complete, so the ordinary container - which is
 * every container under the cap - reads exactly as it did before.
 *
 * It states the limit and then says where the omitted records ARE. No
 * continuation offset is named, because this handle supports none - but the
 * two mechanisms that do reach the whole container (a prefix-scoped listing of
 * the container's virtual record directory, and ordinary collection paging
 * filtered client-side on `relPath`) are named, because they exist. Claiming
 * the records were unreachable would be as inaccurate as promising a
 * continuation.
 */
export const captureWrittenRecordPageReason = (page: {
  recordCount: number;
  recordUris: string[];
  recordUrisTruncated: number;
}): string | undefined => {
  if (page.recordUrisTruncated === 0) return undefined;
  return `recordUris lists the first ${page.recordUris.length} of ${page.recordCount} records; the remaining ${page.recordUrisTruncated} are not listed here. There is no dedicated per-container enumeration endpoint, but they remain reachable: list the container's virtual record URI prefix - the directory every URI in recordUris shares - or page the collection and select the records whose relPath is this container.`;
};

/**
 * The proven write, in the shape a job result and a change event can state.
 *
 * Same facts as {@link captureSyncReason}, addressed to a caller that gets a
 * HANDLE rather than a rendered receipt: which URIs it can actually fetch - and
 * a BOUNDED page of them (see {@link captureWrittenRecordPage}).
 *
 * Same facts, different consequences, because this is not a receipt. It has no
 * docid field to be missing, so the container costs it the single fetchable
 * URI, not a docid. And it is returned INSIDE the create/capture job's
 * `SyncResult`, so its caller - unlike a receipt's - really can read
 * `collections[].files[].recordImport.failures` and is told to.
 */
export const captureWrittenHandle = (
  proof: ActiveCaptureProof,
  location: { collection: string; relPath: string },
  recordImport?: FileSyncResult["recordImport"]
): WrittenPathHandle => {
  const reason = captureSyncReason(proof, recordImport, {
    containerConsequence: CAPTURE_CONTAINER_HANDLE_CONSEQUENCE,
    failurePointer: CAPTURE_FAILURES_ON_SYNC_RESULT,
  });
  if (proof.kind === "file") {
    return {
      kind: "document",
      collection: location.collection,
      relPath: location.relPath,
      uri: proof.document.uri,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const page = captureWrittenRecordPage(proof.records);
  const fullReason = [reason, captureWrittenRecordPageReason(page)]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return {
    kind: "record-container",
    collection: location.collection,
    relPath: location.relPath,
    ...page,
    ...(fullReason === "" ? {} : { reason: fullReason }),
  };
};

/**
 * The same fact, for a receipt that OPENED an existing file instead of writing
 * one.
 *
 * The opened-existing paths ask exactly the question the post-write proof asks -
 * "is this file indexed?" - and must ask it the same way, by effective source
 * path. Only the sentence differs: nothing was written just now, so the reason
 * cannot say "Written as".
 *
 * The consequence is the receipt's, and stays fixed: every caller of this
 * (CLI `gno capture`, MCP `gno_capture`, SDK `capture()`, resident capture)
 * renders it into a {@link CaptureReceipt}, which does have a docid contract.
 */
export const captureProofOpenedExistingSyncReason = (
  proof: ActiveCaptureProof
): string | undefined =>
  captureProofContainerReason(proof, {
    lead: "Existing file is a record container",
    consequence: CAPTURE_CONTAINER_RECEIPT_CONSEQUENCE,
  });

/**
 * The proof a capture/create caller must demand after syncing its own write.
 *
 * `FileSyncResult.status !== "error"` is NOT proof. `skipped` and `unchanged`
 * are ordinary non-error outcomes, and `syncPaths` returns `skipped` for a path
 * it cannot reach that has no indexed document - precisely the case a write
 * through a symlinked parent produces. A caller that accepts it reports a
 * successful capture, hands back a `gno://` URI that resolves to nothing, and
 * the user finds out later.
 *
 * The proof is by EFFECTIVE SOURCE PATH - `COALESCE(record_source_path,
 * rel_path)`, the same notion the reconciliation seams use - not by `rel_path`
 * alone. A write targeting a configured record-container format (a `.jsonl`
 * export, a `.vtt` transcript) is imported as one or more LOGICAL documents
 * whose `rel_path` is a virtual `#record/...` path, with the physical file
 * recorded in `record_source_path`. Asking only `getDocument(collection,
 * relPath)` answers "no document exists" for a completely successful container
 * import, so a working capture reports FAILURE. `listRecordDocuments` is the
 * index-served (`idx_documents_record_source_path`) seam for that half, and it
 * is consulted only when the plain-path lookup did not already prove the write.
 *
 * The two halves are reported SEPARATELY (see {@link ActiveCaptureDocument}):
 * proving a container write does not entitle a caller to speak of "the"
 * document for it.
 *
 * A failed `listRecordDocuments` is always propagated. "The document is
 * inactive" is a stronger, more confident claim than the store can support once
 * the record half is unknown - active logical records can legitimately coexist
 * with an inactive direct row across a format or config transition - so a store
 * failure must never be reported as inactivity.
 */
export async function requireActiveCaptureDocument(
  store: Pick<StorePort, "getDocument"> &
    Partial<Pick<StorePort, "listRecordDocuments">>,
  collectionName: string,
  relPath: string
): Promise<ActiveCaptureDocument> {
  const result = await store.getDocument(collectionName, relPath);
  if (!result.ok) {
    return { ok: false, failure: "store-error", message: result.error.message };
  }
  const document = result.value;
  if (document?.active) {
    return { ok: true, kind: "file", document };
  }

  // Record containers: one written file, N active logical documents.
  const records =
    typeof store.listRecordDocuments === "function"
      ? await store.listRecordDocuments(collectionName, relPath)
      : null;
  // A store failure means the record half is UNKNOWN. Report that, whether or
  // not a direct row exists - never let a weaker, more confident-sounding
  // answer ("inactive", "no document exists") conceal it.
  if (records && !records.ok) {
    return {
      ok: false,
      failure: "store-error",
      message: records.error.message,
    };
  }
  const activeRecords = records
    ? records.value.filter((row) => row.active)
    : [];
  if (activeRecords.length > 0) {
    return { ok: true, kind: "record-container", records: activeRecords };
  }

  if (!document) {
    return {
      ok: false,
      failure: "not-indexed",
      message: `File written but not indexed: no document exists for ${relPath}. The path is not reachable to the indexer or is excluded from the collection.`,
    };
  }
  return {
    ok: false,
    failure: "not-indexed",
    message: `File written but not indexed: the document for ${relPath} is inactive.`,
  };
}
