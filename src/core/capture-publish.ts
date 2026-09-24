/**
 * Shared leased capture publication for CLI, MCP, SDK and REST.
 *
 * One critical section under the shared write lease: plan against current
 * state, publish the note, lexically sync it. With a request ID the same
 * steps run through the request-receipt service so a retry replays or
 * finishes the admitted capture instead of planning a second one.
 *
 * @module src/core/capture-publish
 */

// node:fs/promises mkdir: filesystem structure op, no Bun equivalent
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { dirname, join } from "node:path";

import type { Collection, Config } from "../config/types";
import type { StorePort } from "../store/types";

import {
  buildCaptureReceipt,
  type CaptureInput,
  CaptureSyncError,
  type CapturePlan,
  type CaptureReceipt,
  type CaptureSyncPaths,
  ensureCapturedFileIndexed,
  syncCapturedFile,
  type SyncCapturedFileResult,
} from "./capture";
import { writeCapturePlanFile } from "./capture-write";
import { withWriteLock } from "./file-lock";
import {
  type RequestCheckpoint,
  requestDigest,
  type RequestPlanState,
  type RequestReceiptInfo,
  runRequestedWrite,
} from "./request-receipts";
import { DEFAULT_LOCK_WAIT_MS } from "./write-lease";

export interface CaptureRequest {
  ledgerPath: string;
  namespace: string;
  requestId: string;
  /** Semantic capture input: the request digest payload. */
  input: CaptureInput;
  checkpoint?: (stage: RequestCheckpoint) => Promise<void> | void;
}

export interface PublishCaptureInput {
  collection: Collection;
  store: StorePort;
  lockPath: string;
  lockWaitMs?: number;
  config?: Pick<Config, "contentTypes">;
  syncPaths?: CaptureSyncPaths;
  /** Plan against current state. Runs under the lease; must not write. */
  plan: () => Promise<CapturePlan>;
  beforeWrite?: (absPath: string) => void;
  /**
   * CLI/SDK receipt contract without a request ID: a failed lexical sync is
   * reported in `sync` (not thrown) and an unindexed `open_existing` file is
   * returned as `skipped` rather than synced.
   */
  reportSyncFailure?: boolean;
  /** Runs under the lease once the capture is retrievable. */
  afterSync?: (
    synced: SyncCapturedFileResult,
    receipt: CaptureReceipt
  ) => Promise<void> | void;
  request?: CaptureRequest;
}

export interface PublishedCapture {
  receipt: CaptureReceipt;
  request?: RequestReceiptInfo;
}

/**
 * Private recovery record: destination, expected file hashes and the
 * pre-sync receipt (metadata only, never the note content).
 */
interface CaptureRecoveryPlan {
  openedExisting: boolean;
  fileHash: string;
  baseHash: string | null;
  receipt: CaptureReceipt;
}

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function readFileHash(absPath: string): Promise<string | null> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return null;
  return sha256(await file.text());
}

/** Pre-sync receipt; `sync` is replaced once the capture is retrievable. */
function toReceipt(plan: CapturePlan, absPath: string): CaptureReceipt {
  return buildCaptureReceipt({
    plan,
    absPath,
    overwritten: plan.collisionPolicyResult === "overwritten",
    sync: plan.provenanceConflict
      ? {
          status: "skipped",
          reason:
            "Existing capture has absent or different browser provenance.",
        }
      : undefined,
  });
}

export async function publishCapture(
  options: PublishCaptureInput
): Promise<PublishedCapture> {
  const absPathFor = (relPath: string) =>
    join(options.collection.path, relPath);
  const syncInput = (plan: Pick<CaptureReceipt, "relPath">) => ({
    collection: options.collection,
    store: options.store,
    relPath: plan.relPath,
    absPath: absPathFor(plan.relPath),
    config: options.config,
    syncPaths: options.syncPaths,
  });
  const write = async (plan: CapturePlan): Promise<void> => {
    const absPath = absPathFor(plan.relPath);
    await mkdir(dirname(absPath), { recursive: true });
    options.beforeWrite?.(absPath);
    await writeCapturePlanFile(plan, absPath);
  };
  const finish = async (
    draft: CaptureReceipt,
    openedExisting: boolean
  ): Promise<CaptureReceipt> => {
    const synced = openedExisting
      ? await ensureCapturedFileIndexed(syncInput(draft))
      : await syncCapturedFile(syncInput(draft));
    await options.afterSync?.(synced, draft);
    return { ...draft, docid: synced.docid, sync: synced.sync };
  };
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;

  if (!options.request) {
    const receipt = await withWriteLock(
      options.lockPath,
      async () => {
        const plan = await options.plan();
        if (plan.provenanceConflict) {
          return toReceipt(plan, absPathFor(plan.relPath));
        }
        if (!plan.openedExisting) await write(plan);
        const draft = toReceipt(plan, absPathFor(plan.relPath));
        if (!options.reportSyncFailure) {
          return finish(draft, plan.openedExisting);
        }
        if (plan.openedExisting) {
          const existing = await options.store.getDocument(
            plan.collection,
            plan.relPath
          );
          if (!existing.ok) throw new Error(existing.error.message);
          const opened: CaptureReceipt = {
            ...draft,
            docid: existing.value?.docid,
            sync: existing.value
              ? { status: "completed" }
              : {
                  status: "skipped",
                  reason: "Existing file is not indexed yet.",
                },
          };
          return opened;
        }
        try {
          return await finish(draft, false);
        } catch (error) {
          if (!(error instanceof CaptureSyncError)) throw error;
          const failed: CaptureReceipt = {
            ...draft,
            sync: { status: "failed", error: error.syncError },
          };
          return failed;
        }
      },
      lockWaitMs
    );
    return { receipt };
  }

  const outcome = await runRequestedWrite<CaptureRecoveryPlan, CaptureReceipt>({
    ledgerPath: options.request.ledgerPath,
    namespace: options.request.namespace,
    requestId: options.request.requestId,
    operation: "capture",
    digest: requestDigest("capture", options.request.input),
    lockPath: options.lockPath,
    lockWaitMs,
    checkpoint: options.request.checkpoint,
    prepare: async () => {
      const plan = await options.plan();
      if (plan.provenanceConflict) {
        return { result: toReceipt(plan, absPathFor(plan.relPath)) };
      }
      const absPath = absPathFor(plan.relPath);
      const baseHash = plan.overwrite ? await readFileHash(absPath) : null;
      return {
        plan: {
          openedExisting: plan.openedExisting,
          fileHash: sha256(plan.content),
          baseHash,
          receipt: toReceipt(plan, absPath),
        },
        publish: async () => {
          if (!plan.openedExisting) await write(plan);
        },
      };
    },
    inspect: async (recovery): Promise<RequestPlanState> => {
      const onDisk = await readFileHash(absPathFor(recovery.receipt.relPath));
      if (recovery.openedExisting) {
        return onDisk === null ? "absent" : "published";
      }
      if (onDisk === recovery.fileHash) return "published";
      if (onDisk === recovery.baseHash) return "absent";
      return onDisk === null ? "absent" : "unexpected";
    },
    finish: (recovery) => finish(recovery.receipt, recovery.openedExisting),
    resultRef: (receipt) => ({
      uri: receipt.uri,
      docid: receipt.docid,
      contentHash: receipt.contentHash,
    }),
  });
  return { receipt: outcome.result, request: outcome.request };
}
