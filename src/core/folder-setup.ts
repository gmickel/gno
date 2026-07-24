/**
 * Core-only verified folder setup orchestration.
 *
 * @module src/core/folder-setup
 */

import type { Collection } from "../config";
import type { SyncService } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { DEFAULT_EXCLUDES, loadConfig } from "../config";
import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { verifyLexicalActivation } from "./activation-verifier";
import { applyConfigChange } from "./config-mutation";
import { getConfigWriteLockPath } from "./config-write-lock";
import {
  type CollectionSelection,
  type FolderSetupError,
  type FolderSetupErrorCode,
  normalizeSetupExcludes,
  preflightFolder,
  resolveSetupFolder,
  resolveSetupStoreIndex,
  selectFolderCollection,
  setupError,
  setupExcludesMatch,
  setupFilterDisagreement,
  setupInjectedFailure,
  validateSetupOutputPaths,
} from "./folder-setup-planning";
import {
  createSetupReceipt,
  failSetupStage,
  type FolderSetupReceipt,
  getSetupReceiptPath,
  passSetupStage,
  persistSetupReceipt,
  setupFingerprint,
  type SetupFailure,
  type SetupStageName,
  startSetupStage,
} from "./setup-receipt";

export type {
  FolderSetupError,
  FolderSetupErrorCode,
} from "./folder-setup-planning";

export type FolderSetupFailurePoint =
  | "after_config_save"
  | "after_store_sync"
  | "after_lexical_index"
  | "after_lexical_proof";

export interface FolderSetupOptions {
  folder: string;
  store: SqliteAdapter;
  configPath: string;
  dataDir: string;
  indexName?: string;
  name?: string;
  exclude?: string[];
  secretRiskAuthorized?: boolean;
  /**
   * Preserve store-only recovery state while projecting the selected
   * collection. Project-profile setup uses this after its own additive apply.
   */
  additiveStoreProjection?: boolean;
  /** Test-only deterministic interruption hook. */
  failureInjection?: FolderSetupFailurePoint;
  /** Test-only concurrency seam before the serialized config boundary. */
  beforeConfigBoundary?: () => Promise<void>;
  /** Test-only receipt persistence seam. */
  receiptWriter?: (receipt: FolderSetupReceipt) => Promise<void>;
  syncService?: SyncService;
  now?: () => Date;
}

export type FolderSetupResult =
  | { ok: true; receipt: FolderSetupReceipt }
  | {
      ok: false;
      error: FolderSetupError;
      receipt: FolderSetupReceipt | null;
    };

class SetupAbort extends Error {
  readonly result: FolderSetupResult;

  constructor(result: FolderSetupResult) {
    super("Folder setup aborted");
    this.result = result;
  }
}

function nowIso(options: FolderSetupOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function stageFailure(
  stage: SetupStageName,
  error: FolderSetupError
): SetupFailure {
  return { stage, ...error };
}

async function writeReceipt(
  receipt: FolderSetupReceipt,
  stage: SetupStageName,
  options: FolderSetupOptions
): Promise<FolderSetupResult | null> {
  try {
    await (options.receiptWriter ?? persistSetupReceipt)(receipt);
    return null;
  } catch {
    const error = setupError(
      "receipt_write_failed",
      `Failed to persist setup receipt: ${receipt.paths.receipt}`,
      "Check local data-directory permissions and retry."
    );
    failSetupStage(receipt, stageFailure(stage, error), nowIso(options));
    return { ok: false, error, receipt };
  }
}

async function persistFailure(
  receipt: FolderSetupReceipt,
  stage: SetupStageName,
  error: FolderSetupError,
  options: FolderSetupOptions
): Promise<FolderSetupResult> {
  failSetupStage(receipt, stageFailure(stage, error), nowIso(options));
  const writeFailure = await writeReceipt(receipt, stage, options);
  return writeFailure ?? { ok: false, error, receipt };
}

export async function setupFolder(
  options: FolderSetupOptions
): Promise<FolderSetupResult> {
  const resolved = await resolveSetupFolder(options.folder);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error, receipt: null };
  }
  const folder = resolved.folder;

  const storeIdentity = await resolveSetupStoreIndex({
    store: options.store,
    requestedIndexName: options.indexName,
  });
  if ("code" in storeIdentity) {
    return { ok: false, error: storeIdentity, receipt: null };
  }
  const receiptPath = getSetupReceiptPath({
    dataDir: options.dataDir,
    indexName: storeIdentity.indexName,
    folderRealpath: folder,
  });
  const configLockPath = await getConfigWriteLockPath(options.configPath);
  const unsafeOutput = await validateSetupOutputPaths(folder, [
    { label: "Data directory", path: options.dataDir },
    { label: "Setup receipt", path: receiptPath },
    { label: "Config", path: options.configPath },
    { label: "Config lock", path: configLockPath },
    { label: "Index database", path: storeIdentity.dbPath },
  ]);
  if (unsafeOutput) {
    return { ok: false, error: unsafeOutput, receipt: null };
  }

  const requestedExcludes = normalizeSetupExcludes(
    options.exclude?.length ? options.exclude : DEFAULT_EXCLUDES
  );
  const loaded = await loadConfig(options.configPath);
  let initialSelection: CollectionSelection | FolderSetupError | null = null;
  let effectiveExcludes = requestedExcludes;
  if (loaded.ok) {
    initialSelection = await selectFolderCollection(
      loaded.value,
      folder,
      options.name,
      requestedExcludes
    );
    if (
      !("code" in initialSelection) &&
      initialSelection.disposition === "reused"
    ) {
      if (
        options.exclude !== undefined &&
        !setupExcludesMatch(
          requestedExcludes,
          initialSelection.collection.exclude
        )
      ) {
        initialSelection = setupFilterDisagreement(initialSelection.collection);
      } else {
        effectiveExcludes = normalizeSetupExcludes(
          initialSelection.collection.exclude
        );
      }
    }
  }

  const receipt = createSetupReceipt({
    now: nowIso(options),
    folder,
    indexName: storeIdentity.indexName,
    requestedName: options.name,
    excludes: effectiveExcludes,
    secretRiskAuthorized: options.secretRiskAuthorized ?? false,
    configPath: options.configPath,
    dataDir: options.dataDir,
  });
  startSetupStage(receipt, "preflight", nowIso(options));
  let writeFailure = await writeReceipt(receipt, "preflight", options);
  if (writeFailure) {
    return writeFailure;
  }
  if (initialSelection && "code" in initialSelection) {
    return persistFailure(receipt, "preflight", initialSelection, options);
  }
  const preflightError = await preflightFolder(
    folder,
    effectiveExcludes,
    options.secretRiskAuthorized ?? false
  );
  if (preflightError) {
    return persistFailure(receipt, "preflight", preflightError, options);
  }
  passSetupStage(receipt, "preflight", nowIso(options));

  startSetupStage(receipt, "config_saved", nowIso(options));
  writeFailure = await writeReceipt(receipt, "config_saved", options);
  if (writeFailure) {
    return writeFailure;
  }
  if (!loaded.ok) {
    return persistFailure(
      receipt,
      "config_saved",
      setupError(
        "config_load_failed",
        loaded.error.message,
        "Initialize or repair the selected GNO config, then retry."
      ),
      options
    );
  }

  await options.beforeConfigBoundary?.();
  let activeSelection: CollectionSelection | null = null;
  let selectedCollection: Collection | undefined;
  let activeConfig = loaded.value;
  let boundaryError: FolderSetupError | null = null;
  try {
    const mutation = await applyConfigChange(
      {
        store: options.store,
        configPath: options.configPath,
        onConfigUpdated: (config) => {
          activeConfig = config;
        },
        afterConfigSaved: async (config) => {
          activeConfig = config;
          const selected = activeSelection;
          if (!selected) {
            throw new Error("Setup collection selection was not established");
          }
          receipt.collection = {
            name: selected.collection.name,
            path: folder,
            disposition: selected.disposition,
          };
          receipt.fingerprints.config = setupFingerprint({
            version: config.version,
            ftsTokenizer: config.ftsTokenizer,
            collection: selected.collection,
          });
          passSetupStage(receipt, "config_saved", nowIso(options));
          const configReceiptFailure = await writeReceipt(
            receipt,
            "config_saved",
            options
          );
          if (configReceiptFailure) {
            throw new SetupAbort(configReceiptFailure);
          }
          if (options.failureInjection === "after_config_save") {
            throw new Error("INJECTED_AFTER_CONFIG_SAVE");
          }
          startSetupStage(receipt, "store_synced", nowIso(options));
          const storeReceiptFailure = await writeReceipt(
            receipt,
            "store_synced",
            options
          );
          if (storeReceiptFailure) {
            throw new SetupAbort(storeReceiptFailure);
          }
        },
        projectStore: options.additiveStoreProjection
          ? async (store, config) => {
              const selected = activeSelection;
              if (!selected) {
                return {
                  ok: false,
                  error: "Setup collection selection was not established",
                };
              }
              const collectionResult = await store.upsertCollections([
                selected.collection,
              ]);
              if (!collectionResult.ok) {
                return { ok: false, error: collectionResult.error.message };
              }
              const contextResult = await store.upsertContexts(
                config.contexts ?? []
              );
              return contextResult.ok
                ? { ok: true }
                : { ok: false, error: contextResult.error.message };
            }
          : undefined,
      },
      async (config) => {
        const fresh = await selectFolderCollection(
          config,
          folder,
          options.name,
          effectiveExcludes
        );
        if ("code" in fresh) {
          boundaryError = fresh;
          return { ok: false, error: fresh.message, code: fresh.code };
        }
        if (
          fresh.disposition === "reused" &&
          !setupExcludesMatch(fresh.collection.exclude, effectiveExcludes)
        ) {
          boundaryError = setupFilterDisagreement(fresh.collection);
          return {
            ok: false,
            error: boundaryError.message,
            code: boundaryError.code,
          };
        }
        activeSelection = fresh;
        return {
          ok: true,
          config: fresh.config,
          value: fresh.collection,
          skipSave: fresh.disposition === "reused",
        };
      }
    );
    if (!mutation.ok) {
      if (boundaryError) {
        return persistFailure(receipt, "config_saved", boundaryError, options);
      }
      return persistFailure(
        receipt,
        receipt.stages.config_saved.status === "passed"
          ? "store_synced"
          : "config_saved",
        setupError(
          mutation.code === "SYNC_ERROR"
            ? "store_sync_failed"
            : "config_save_failed",
          mutation.error,
          "Fix config/data-directory permissions and rerun setup."
        ),
        options
      );
    }
    activeConfig = mutation.config;
    selectedCollection = mutation.value;
  } catch (error) {
    if (error instanceof SetupAbort) {
      return error.result;
    }
    if (
      error instanceof Error &&
      error.message === "INJECTED_AFTER_CONFIG_SAVE"
    ) {
      return persistFailure(
        receipt,
        "config_saved",
        setupInjectedFailure("after_config_save"),
        options
      );
    }
    return persistFailure(
      receipt,
      receipt.stages.config_saved.status === "passed"
        ? "store_synced"
        : "config_saved",
      setupError(
        "config_save_failed",
        error instanceof Error ? error.message : "Config mutation failed",
        "Retry after the selected config write lock is available."
      ),
      options
    );
  }

  const collection = selectedCollection;
  if (!collection) {
    return persistFailure(
      receipt,
      "store_synced",
      setupError(
        "store_sync_failed",
        "Store projection completed without a selected collection",
        "Retry setup against a healthy config and index store."
      ),
      options
    );
  }
  passSetupStage(receipt, "store_synced", nowIso(options));
  writeFailure = await writeReceipt(receipt, "store_synced", options);
  if (writeFailure) {
    return writeFailure;
  }
  if (options.failureInjection === "after_store_sync") {
    return persistFailure(
      receipt,
      "store_synced",
      setupInjectedFailure("after_store_sync"),
      options
    );
  }

  startSetupStage(receipt, "lexical_indexed", nowIso(options));
  writeFailure = await writeReceipt(receipt, "lexical_indexed", options);
  if (writeFailure) {
    return writeFailure;
  }
  const syncService = options.syncService ?? defaultSyncService;
  const sync = await syncService.syncCollection(
    collection,
    options.store,
    withContentTypeRules({ runUpdateCmd: false }, activeConfig)
  );
  const indexedCount =
    sync.filesAdded + sync.filesUpdated + sync.filesUnchanged;
  if (indexedCount === 0) {
    return persistFailure(
      receipt,
      "lexical_indexed",
      setupError(
        "lexical_index_failed",
        `No document reached the lexical index (${sync.filesErrored} errors, ${sync.filesSkipped} skipped)`,
        "Inspect converter errors or add an indexable text document, then retry."
      ),
      options
    );
  }
  passSetupStage(receipt, "lexical_indexed", nowIso(options));
  writeFailure = await writeReceipt(receipt, "lexical_indexed", options);
  if (writeFailure) {
    return writeFailure;
  }
  if (options.failureInjection === "after_lexical_index") {
    return persistFailure(
      receipt,
      "lexical_indexed",
      setupInjectedFailure("after_lexical_index"),
      options
    );
  }

  startSetupStage(receipt, "lexical_proved", nowIso(options));
  writeFailure = await writeReceipt(receipt, "lexical_proved", options);
  if (writeFailure) {
    return writeFailure;
  }
  const proof = await verifyLexicalActivation(options.store, collection.name);
  if (!proof.ok || !proof.value.ready) {
    const message = proof.ok
      ? `Lexical activation was not proven (${proof.value.stages.lexical.code ?? proof.value.stages.index.code ?? "unknown"})`
      : proof.error.message;
    if (proof.ok) {
      receipt.activation = proof.value;
      receipt.fingerprints.index = proof.value.fingerprint;
    }
    return persistFailure(
      receipt,
      "lexical_proved",
      setupError(
        "lexical_proof_failed",
        message,
        "Fix the lexical corpus/index state, then rerun setup."
      ),
      options
    );
  }
  receipt.activation = proof.value;
  receipt.fingerprints.index = proof.value.fingerprint;
  passSetupStage(receipt, "lexical_proved", nowIso(options));
  writeFailure = await writeReceipt(receipt, "lexical_proved", options);
  if (writeFailure) {
    return writeFailure;
  }
  if (options.failureInjection === "after_lexical_proof") {
    return persistFailure(
      receipt,
      "lexical_proved",
      setupInjectedFailure("after_lexical_proof"),
      options
    );
  }

  startSetupStage(receipt, "completed", nowIso(options));
  passSetupStage(receipt, "completed", nowIso(options));
  receipt.status = "completed";
  receipt.pending = [];
  writeFailure = await writeReceipt(receipt, "completed", options);
  return writeFailure ?? { ok: true, receipt };
}
