/**
 * Shared resident capture planning and write execution.
 *
 * Browser clipping and the ordinary REST capture route both use this service so
 * collision, provenance, atomic-write, sync, and receipt semantics cannot drift.
 */

// node:fs/promises structure operations have no Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities.
import { basename, dirname, join as pathJoin } from "node:path";

import type { Collection, Config } from "../config/types";
import type { PreparedBrowserClip } from "../core/browser-clip";
import type { CaptureInput, CapturePlan, CaptureSource } from "../core/capture";
import type { JobManager } from "../core/job-manager";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { ClipperIdempotencyPlan } from "../store/sqlite/clipper-store-types";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";
import type { CollectionWatchService } from "./watch-service";

import {
  buildCaptureReceipt,
  extractCaptureSourceFromFrontmatter,
  hashCaptureContent,
  listCaptureDiskRelPaths,
  planCapture,
} from "../core/capture";
import { writeCapturePlanFile } from "../core/capture-write";
import { recordContentMutation } from "../core/mutation-generations";
import {
  type CollectionSyncResult,
  defaultSyncService,
  type SyncResult,
  withContentTypeRules,
} from "../ingestion";
import { stripFrontmatter } from "../ingestion/frontmatter";
import { startJob } from "./jobs";

export interface ResidentCaptureContext {
  config: Config;
  scheduler: EmbedScheduler | null;
  eventBus: DocumentEventBus | null;
  watchService: CollectionWatchService | null;
  jobManager?: JobManager;
  markContentMutation?: () => void;
}

export type ResidentCapturePlanResult =
  | {
      ok: true;
      collection: Collection;
      fullPath: string;
      plan: CapturePlan;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "RUNTIME" | "VALIDATION";
      message: string;
      status: number;
    };

const listCollectionRelPaths = async (
  store: Pick<SqliteAdapter, "listDocuments">,
  collection: string
): Promise<string[]> => {
  const result = await store.listDocuments(collection);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.map((entry) => entry.relPath);
};

const readCandidateClipIdentity = async (
  collection: Collection,
  relPath: string
): Promise<string | null> => {
  const file = Bun.file(pathJoin(collection.path, relPath));
  if (!(await file.exists())) return null;
  try {
    return (
      extractCaptureSourceFromFrontmatter(await file.text()).browserClip
        ?.clipIdentity ?? null
    );
  } catch {
    return null;
  }
};

export const planResidentCapture = async (
  context: ResidentCaptureContext,
  store: SqliteAdapter,
  input: CaptureInput,
  now?: Date
): Promise<ResidentCapturePlanResult> => {
  const collection = context.config.collections.find(
    (candidate) =>
      candidate.name.toLowerCase() === input.collection.toLowerCase()
  );
  if (!collection) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Collection not found: ${input.collection}`,
      status: 404,
    };
  }

  let existingRelPaths: string[];
  let diskRelPaths: string[];
  try {
    existingRelPaths = await listCollectionRelPaths(store, collection.name);
    diskRelPaths = await listCaptureDiskRelPaths(collection.path);
  } catch (error) {
    return {
      ok: false,
      code: "RUNTIME",
      message: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }

  try {
    const normalizedInput = { ...input, collection: collection.name };
    let plan = planCapture({
      input: normalizedInput,
      existingRelPaths,
      diskRelPaths,
      now,
    });
    if (plan.provenanceConflict && plan.source.browserClip !== undefined) {
      const identity = await readCandidateClipIdentity(
        collection,
        plan.relPath
      );
      plan = planCapture({
        input: normalizedInput,
        existingRelPaths,
        diskRelPaths,
        existingProvenanceByRelPath:
          identity === null ? new Map() : new Map([[plan.relPath, identity]]),
        now,
      });
    }
    return {
      ok: true,
      collection,
      fullPath: pathJoin(collection.path, plan.relPath),
      plan,
    };
  } catch (error) {
    return {
      ok: false,
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
      status: 409,
    };
  }
};

const syncResidentCollection = async (
  context: ResidentCaptureContext,
  collection: Collection,
  store: SqliteAdapter,
  syncCollection: typeof defaultSyncService.syncCollection
): Promise<CollectionSyncResult> => {
  const result = await syncCollection(
    collection,
    store,
    withContentTypeRules({ runUpdateCmd: false }, context.config)
  );
  recordContentMutation(result, context.markContentMutation);
  return result;
};

export const executeResidentCapturePlan = async (
  context: ResidentCaptureContext,
  store: SqliteAdapter,
  planned: Extract<ResidentCapturePlanResult, { ok: true }>,
  dependencies: {
    syncCollection?: typeof defaultSyncService.syncCollection;
  } = {}
): Promise<{ body: unknown; status: number }> => {
  const { collection, fullPath, plan } = planned;
  if (plan.provenanceConflict) {
    return {
      body: buildCaptureReceipt({
        plan,
        absPath: fullPath,
        sync: {
          status: "skipped",
          reason:
            "Existing capture has absent or different browser provenance.",
        },
      }),
      status: 409,
    };
  }
  if (plan.openedExisting) {
    const existingDocument = await store.getDocument(
      collection.name,
      plan.relPath
    );
    if (!existingDocument.ok) {
      throw new Error(existingDocument.error.message);
    }
    return {
      body: buildCaptureReceipt({
        plan,
        absPath: fullPath,
        docid: existingDocument.value?.docid,
        sync: existingDocument.value
          ? { status: "completed" }
          : {
              status: "skipped",
              reason: "Existing file is not indexed yet.",
            },
      }),
      status: 200,
    };
  }

  await mkdir(dirname(fullPath), { recursive: true });
  context.watchService?.suppress(fullPath);
  await writeCapturePlanFile(plan, fullPath);
  const gnoUri = `gno://${collection.name}/${plan.relPath}`;
  const syncCollection =
    dependencies.syncCollection ??
    defaultSyncService.syncCollection.bind(defaultSyncService);
  const jobResult = await startJob(
    "sync",
    async (): Promise<SyncResult> => {
      const result = await syncResidentCollection(
        context,
        collection,
        store,
        syncCollection
      );
      context.scheduler?.notifySyncComplete([plan.relPath]);
      context.eventBus?.emit({
        type: "document-changed",
        uri: gnoUri,
        collection: collection.name,
        relPath: plan.relPath,
        origin: "create",
        changedAt: new Date().toISOString(),
      });
      return {
        collections: [result],
        totalDurationMs: result.durationMs,
        totalFilesProcessed: result.filesProcessed,
        totalFilesAdded: result.filesAdded,
        totalFilesUpdated: result.filesUpdated,
        totalFilesErrored: result.filesErrored,
        totalFilesSkipped: result.filesSkipped,
      };
    },
    context.jobManager
  );

  return {
    body: buildCaptureReceipt({
      plan,
      absPath: fullPath,
      sync: jobResult.ok
        ? {
            status: "pending",
            jobId: jobResult.jobId,
            reason: "Sync job started; poll /api/jobs/:id for status.",
          }
        : {
            status: "skipped",
            jobId: jobResult.activeJobId,
            reason: "Sync skipped because another job is running.",
            error: jobResult.error,
          },
    }),
    status: 202,
  };
};

export const browserClipIdempotencyPlan = (
  planned: Extract<ResidentCapturePlanResult, { ok: true }>
): ClipperIdempotencyPlan => {
  const browserClip = planned.plan.source.browserClip;
  if (!browserClip) {
    throw new Error("Browser capture plan is missing browser provenance");
  }
  return {
    collection: planned.plan.collection,
    relPath: planned.plan.relPath,
    collisionPolicyResult: planned.plan.collisionPolicyResult,
    contentHash: planned.plan.contentHash,
    clipIdentity: browserClip.clipIdentity,
  };
};

export const browserClipIdempotencyPlansMatch = (
  left: ClipperIdempotencyPlan,
  right: ClipperIdempotencyPlan
): boolean =>
  left.collection === right.collection &&
  left.relPath === right.relPath &&
  left.collisionPolicyResult === right.collisionPolicyResult &&
  left.contentHash === right.contentHash &&
  left.clipIdentity === right.clipIdentity;

export type ResidentCaptureRecoveryResult =
  | { status: "recovered"; body: unknown; statusCode: number }
  | {
      status: "execute";
      planned: Extract<ResidentCapturePlanResult, { ok: true }>;
    }
  | { status: "conflict"; message: string };

const recoveredCapturePlan = (
  prepared: PreparedBrowserClip,
  persisted: ClipperIdempotencyPlan,
  storedSource: CaptureSource
): CapturePlan => ({
  collection: persisted.collection,
  relPath: persisted.relPath,
  filename: basename(persisted.relPath),
  content: prepared.captureInput.content ?? prepared.preview.body,
  body: prepared.preview.body,
  contentHash: persisted.contentHash,
  title: prepared.payload.title,
  tags: prepared.preview.tags,
  source: storedSource,
  openedExisting: persisted.collisionPolicyResult === "opened_existing",
  createdWithSuffix: persisted.collisionPolicyResult === "created_with_suffix",
  provenanceConflict: persisted.collisionPolicyResult === "conflict",
  collisionPolicy: prepared.payload.destination.collisionPolicy,
  collisionPolicyResult: persisted.collisionPolicyResult,
  overwrite: persisted.collisionPolicyResult === "overwritten",
});

/**
 * Reconcile a pending clipper claim without ever choosing a new destination.
 * A matching exact file proves the atomic write landed; otherwise execution is
 * allowed only when a fresh plan is byte-for-byte identical to the saved plan.
 */
export const recoverPendingResidentBrowserClip = async (
  context: ResidentCaptureContext,
  store: SqliteAdapter,
  prepared: PreparedBrowserClip,
  persisted: ClipperIdempotencyPlan
): Promise<ResidentCaptureRecoveryResult> => {
  const collection = context.config.collections.find(
    (candidate) => candidate.name === persisted.collection
  );
  if (!collection) {
    return {
      status: "conflict",
      message: "Saved browser capture collection is no longer configured",
    };
  }

  const fullPath = pathJoin(collection.path, persisted.relPath);
  const file = Bun.file(fullPath);
  if (await file.exists()) {
    try {
      const storedContent = await file.text();
      const source = extractCaptureSourceFromFrontmatter(storedContent);
      const browserClip = source.browserClip;
      if (
        source.kind === "web" &&
        typeof source.capturedAt === "string" &&
        browserClip?.clipIdentity === persisted.clipIdentity &&
        browserClip.finalBodyHash === persisted.contentHash &&
        browserClip.previewDigest === prepared.preview.digest &&
        hashCaptureContent(stripFrontmatter(storedContent)) ===
          persisted.contentHash
      ) {
        const storedSource: CaptureSource = {
          ...source,
          kind: source.kind,
          capturedAt: source.capturedAt,
          browserClip,
        };
        const plan = recoveredCapturePlan(prepared, persisted, storedSource);
        return {
          status: "recovered",
          body: buildCaptureReceipt({
            plan,
            absPath: fullPath,
            sync: {
              status: "skipped",
              reason:
                "Recovered a completed atomic write after receipt persistence was interrupted.",
            },
          }),
          statusCode:
            persisted.collisionPolicyResult === "opened_existing" ? 200 : 202,
        };
      }
    } catch {
      // A malformed or unrelated exact file is handled as plan drift below.
    }
  }

  const replanned = await planResidentCapture(
    context,
    store,
    prepared.captureInput
  );
  if (
    !replanned.ok ||
    !browserClipIdempotencyPlansMatch(
      browserClipIdempotencyPlan(replanned),
      persisted
    )
  ) {
    return {
      status: "conflict",
      message:
        "Pending browser capture cannot be recovered because its destination changed",
    };
  }
  return { status: "execute", planned: replanned };
};
