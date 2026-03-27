import type { CollectionSyncResult } from "../../ingestion";
import type { BackgroundRuntimeResult } from "../../serve/background-runtime";

import { startBackgroundRuntime } from "../../serve/background-runtime";

export interface DaemonOptions {
  configPath?: string;
  index?: string;
  offline?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  noSyncOnStart?: boolean;
  signal?: AbortSignal;
}

export type DaemonResult =
  | { success: true }
  | { success: false; error: string };

type DaemonLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

type DaemonDeps = {
  startBackgroundRuntime?: typeof startBackgroundRuntime;
  logger?: DaemonLogger;
};

function formatCollectionSyncSummary(result: CollectionSyncResult): string {
  return `${result.collection}: ${result.filesAdded} added, ${result.filesUpdated} updated, ${result.filesUnchanged} unchanged, ${result.filesErrored} errors`;
}

function createSignalPromise(
  signal: AbortSignal | undefined,
  logger: DaemonLogger,
  quiet: boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const complete = (message?: string): void => {
      signal?.removeEventListener("abort", onAbort);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (message && !quiet) {
        logger.log(message);
      }
      resolve();
    };

    const onAbort = (): void => complete("Daemon stopped.");
    const onSigint = (): void => complete("Received SIGINT. Shutting down...");
    const onSigterm = (): void =>
      complete("Received SIGTERM. Shutting down...");

    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

export async function daemon(
  options: DaemonOptions = {},
  deps: DaemonDeps = {}
): Promise<DaemonResult> {
  const logger = deps.logger ?? {
    log: (message: string) => {
      console.log(message);
    },
    error: (message: string) => {
      console.error(message);
    },
  };

  const runtimeResult: BackgroundRuntimeResult = await (
    deps.startBackgroundRuntime ?? startBackgroundRuntime
  )({
    configPath: options.configPath,
    index: options.index,
    requireCollections: true,
    offline: options.offline,
    watchCallbacks: {
      onSyncStart: ({ collection, relPaths }) => {
        if (!options.quiet) {
          logger.log(
            `watch sync started: ${collection} (${relPaths.length} path${relPaths.length === 1 ? "" : "s"})`
          );
        }
      },
      onSyncComplete: ({ result }) => {
        if (!options.quiet) {
          logger.log(formatCollectionSyncSummary(result));
        }
      },
      onSyncError: ({ collection, error }) => {
        logger.error(
          `watch sync failed: ${collection}: ${error instanceof Error ? error.message : String(error)}`
        );
      },
    },
  });
  if (!runtimeResult.success) {
    return { success: false, error: runtimeResult.error };
  }

  const { runtime } = runtimeResult;
  try {
    if (!options.quiet) {
      logger.log(
        `GNO daemon started for index "${options.index ?? "default"}" using ${runtime.config.collections.length} collection${runtime.config.collections.length === 1 ? "" : "s"}.`
      );
      const watchState = runtime.watchService.getState();
      if (watchState.activeCollections.length > 0) {
        logger.log(`watching: ${watchState.activeCollections.join(", ")}`);
      }
      if (watchState.failedCollections.length > 0) {
        for (const failed of watchState.failedCollections) {
          logger.error(`watch failed: ${failed.collection}: ${failed.reason}`);
        }
      }
    }

    if (!options.noSyncOnStart) {
      if (!options.quiet) {
        logger.log("Running initial sync...");
      }
      const { syncResult, embedResult } = await runtime.syncAll({
        runUpdateCmd: true,
        triggerEmbed: true,
      });
      if (!options.quiet) {
        logger.log(
          `sync totals: ${syncResult.totalFilesAdded} added, ${syncResult.totalFilesUpdated} updated, ${syncResult.totalFilesErrored} errors, ${syncResult.totalFilesSkipped} skipped`
        );
      }
      if (!options.quiet && embedResult) {
        logger.log(
          `embed: ${embedResult.embedded} embedded, ${embedResult.errors} errors`
        );
      }
    } else if (!options.quiet) {
      logger.log("Skipping initial sync (--no-sync-on-start).");
    }

    await createSignalPromise(options.signal, logger, options.quiet ?? false);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.dispose();
  }
}
