/**
 * Capture lexical sync under the write lease (shared by MCP, REST, and CLI
 * adapters). Split out of `capture.ts`; every symbol is re-exported there so
 * existing import paths keep working.
 *
 * @module src/core/capture-sync
 */

import type { Collection, Config } from "../config/types";
import type { StorePort } from "../store/types";
import type { CaptureIndexStatus } from "./capture";

import {
  type CollectionSyncResult,
  defaultSyncService,
  withContentTypeRules,
} from "../ingestion";

export const CAPTURE_SYNC_FAILED_CODE = "CAPTURE_SYNC_FAILED";

/**
 * The capture landed on disk but lexical sync did not make it retrievable.
 * Carries the write receipt half (`absPath`, `relPath`) so callers can report
 * the write separately from the failed sync.
 */
export class CaptureSyncError extends Error {
  readonly code = CAPTURE_SYNC_FAILED_CODE;
  readonly absPath: string;
  readonly relPath: string;

  constructor(input: { absPath: string; relPath: string; cause: string }) {
    super(
      `Capture written to ${input.absPath} but lexical sync failed: ${input.cause}. Run gno update to retry indexing.`
    );
    this.name = "CaptureSyncError";
    this.absPath = input.absPath;
    this.relPath = input.relPath;
  }
}

export type CaptureSyncPaths = typeof defaultSyncService.syncPaths;

export interface SyncCapturedFileInput {
  collection: Collection;
  store: StorePort;
  relPath: string;
  absPath: string;
  config?: Pick<Config, "contentTypes">;
  syncPaths?: CaptureSyncPaths;
}

export interface SyncCapturedFileResult {
  docid: string;
  documentId: number;
  /** Null when the file was already indexed and no sync ran. */
  result: CollectionSyncResult | null;
  sync: CaptureIndexStatus;
}

/**
 * Sync one written capture into the lexical index and prove it is
 * retrievable. Callers hold the shared write lease. Throws
 * `CaptureSyncError` when the sync reports an error or the document is still
 * missing afterwards — capture success is retrievability, never a bare write.
 */
export async function syncCapturedFile(
  input: SyncCapturedFileInput
): Promise<SyncCapturedFileResult> {
  const syncPaths =
    input.syncPaths ?? defaultSyncService.syncPaths.bind(defaultSyncService);
  const result = await syncPaths(
    input.collection,
    input.store,
    [input.relPath],
    withContentTypeRules({ runUpdateCmd: false, gitPull: false }, input.config)
  );
  const fileResult = result.files?.[0];
  const fail = (cause: string): never => {
    throw new CaptureSyncError({
      absPath: input.absPath,
      relPath: input.relPath,
      cause,
    });
  };
  if (!fileResult) {
    return fail("sync returned no result for the written file");
  }
  if (fileResult.status === "error") {
    return fail(
      `${fileResult.errorCode ?? "ERROR"} - ${fileResult.errorMessage ?? "Unknown error"}`
    );
  }
  const doc = await input.store.getDocument(
    input.collection.name,
    input.relPath
  );
  if (!doc.ok) {
    return fail(doc.error.message);
  }
  if (!doc.value) {
    return fail("document is not retrievable after sync");
  }
  return {
    docid: fileResult.docid ?? doc.value.docid,
    documentId: doc.value.id,
    result,
    sync: { status: "completed" },
  };
}

/**
 * `open_existing` half of the contract: an indexed file is returned as-is; a
 * disk-only file is synced first so opening it is also a retrievable success.
 */
export async function ensureCapturedFileIndexed(
  input: SyncCapturedFileInput
): Promise<SyncCapturedFileResult> {
  const doc = await input.store.getDocument(
    input.collection.name,
    input.relPath
  );
  if (!doc.ok) {
    throw new Error(doc.error.message);
  }
  if (doc.value) {
    return {
      docid: doc.value.docid,
      documentId: doc.value.id,
      result: null,
      sync: {
        status: "completed",
        reason: "Existing capture already indexed.",
      },
    };
  }
  const synced = await syncCapturedFile(input);
  return {
    ...synced,
    sync: {
      status: "completed",
      reason: "Existing capture was not indexed yet; synced before returning.",
    },
  };
}
