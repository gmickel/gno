/** Backwards-compatible entrypoint for the shared resident runtime. */

import type { Config } from "../config/types";
import type { SyncResult } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { EmbedResult, EmbedScheduler } from "./embed-scheduler";
import type { ContextHolder } from "./routes/api";
import type { CollectionWatchService } from "./watch-service";

import {
  startResidentRuntime,
  type ResidentRuntimeDeps,
  type ResidentRuntimeOptions,
} from "./resident-runtime";

export type BackgroundRuntimeOptions = ResidentRuntimeOptions;
export type BackgroundRuntimeDeps = ResidentRuntimeDeps;

export interface BackgroundRuntime {
  store: SqliteAdapter;
  config: Config;
  actualConfigPath: string;
  ctxHolder: ContextHolder;
  scheduler: EmbedScheduler;
  eventBus: import("./doc-events").DocumentEventBus | null;
  watchService: CollectionWatchService;
  syncAll(options?: {
    gitPull?: boolean;
    runUpdateCmd?: boolean;
    triggerEmbed?: boolean;
  }): Promise<{ syncResult: SyncResult; embedResult: EmbedResult | null }>;
  dispose(): Promise<void>;
}

export type BackgroundRuntimeResult =
  | { success: true; runtime: BackgroundRuntime }
  | { success: false; error: string };

export async function startBackgroundRuntime(
  options: BackgroundRuntimeOptions = {},
  deps: BackgroundRuntimeDeps = {}
): Promise<BackgroundRuntimeResult> {
  return startResidentRuntime(options, deps);
}
