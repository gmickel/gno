import type { Config } from "../config/types";
import type { SyncResult } from "../ingestion";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedResult, EmbedScheduler } from "./embed-scheduler";
import type { ContextHolder } from "./routes/api";
import type {
  CollectionWatchCallbacks,
  CollectionWatchService,
} from "./watch-service";

import { getIndexDbPath } from "../app/constants";
import {
  ensureDirectories,
  getConfigPaths,
  isInitialized,
  loadConfig,
} from "../config";
import { defaultSyncService } from "../ingestion";
import { getActivePreset } from "../llm/registry";
import { SqliteAdapter } from "../store/sqlite/adapter";
import {
  createServerContext,
  disposeServerContext,
  type ServerContext,
} from "./context";
import { createEmbedScheduler } from "./embed-scheduler";
import { CollectionWatchService as DefaultCollectionWatchService } from "./watch-service";

export interface BackgroundRuntimeOptions {
  configPath?: string;
  index?: string;
  requireCollections?: boolean;
  eventBus?: DocumentEventBus | null;
  watchCallbacks?: CollectionWatchCallbacks;
}

export interface BackgroundRuntime {
  store: SqliteAdapter;
  config: Config;
  actualConfigPath: string;
  ctxHolder: ContextHolder;
  scheduler: EmbedScheduler;
  eventBus: DocumentEventBus | null;
  watchService: CollectionWatchService;
  syncAll(options?: {
    gitPull?: boolean;
    runUpdateCmd?: boolean;
    triggerEmbed?: boolean;
  }): Promise<{
    syncResult: SyncResult;
    embedResult: EmbedResult | null;
  }>;
  dispose(): Promise<void>;
}

export type BackgroundRuntimeResult =
  | { success: true; runtime: BackgroundRuntime }
  | { success: false; error: string };

type BackgroundRuntimeDeps = {
  isInitialized?: typeof isInitialized;
  loadConfig?: typeof loadConfig;
  getConfigPaths?: typeof getConfigPaths;
  ensureDirectories?: typeof ensureDirectories;
  storeFactory?: () => SqliteAdapter;
  createServerContext?: (
    store: SqliteAdapter,
    config: Config
  ) => Promise<ServerContext>;
  disposeServerContext?: (ctx: ServerContext) => Promise<void>;
  createEmbedScheduler?: typeof createEmbedScheduler;
  syncAllService?: typeof defaultSyncService.syncAll;
  watchServiceFactory?: (options: {
    collections: Config["collections"];
    store: SqliteAdapter;
    scheduler: EmbedScheduler | null;
    eventBus?: DocumentEventBus | null;
    callbacks?: CollectionWatchCallbacks;
  }) => CollectionWatchService;
};

export async function startBackgroundRuntime(
  options: BackgroundRuntimeOptions = {},
  deps: BackgroundRuntimeDeps = {}
): Promise<BackgroundRuntimeResult> {
  const syncAllService = deps.syncAllService
    ? (...args: Parameters<typeof defaultSyncService.syncAll>) =>
        deps.syncAllService!(...args)
    : defaultSyncService.syncAll.bind(defaultSyncService);
  const initialized = await (deps.isInitialized ?? isInitialized)(
    options.configPath
  );
  if (!initialized) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  const configResult = await (deps.loadConfig ?? loadConfig)(
    options.configPath
  );
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  if (options.requireCollections && config.collections.length === 0) {
    return {
      success: false,
      error: "No collections configured. Run: gno collection add <path>",
    };
  }

  await (deps.ensureDirectories ?? ensureDirectories)();

  const store = deps.storeFactory ? deps.storeFactory() : new SqliteAdapter();
  const dbPath = getIndexDbPath(options.index);
  const paths = (deps.getConfigPaths ?? getConfigPaths)();
  const actualConfigPath = options.configPath ?? paths.configFile;
  store.setConfigPath(actualConfigPath);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  const syncCollResult = await store.syncCollections(config.collections);
  if (!syncCollResult.ok) {
    await store.close();
    return { success: false, error: syncCollResult.error.message };
  }
  const syncCtxResult = await store.syncContexts(config.contexts ?? []);
  if (!syncCtxResult.ok) {
    await store.close();
    return { success: false, error: syncCtxResult.error.message };
  }

  const ctx = await (deps.createServerContext ?? createServerContext)(
    store,
    config
  );

  const ctxHolder: ContextHolder = {
    current: ctx,
    config,
    scheduler: null,
    eventBus: options.eventBus ?? null,
    watchService: null,
  };

  const scheduler = (deps.createEmbedScheduler ?? createEmbedScheduler)({
    db: store.getRawDb(),
    getEmbedPort: () => ctxHolder.current.embedPort,
    getVectorIndex: () => ctxHolder.current.vectorIndex,
    getModelUri: () => getActivePreset(ctxHolder.config).embed,
  });
  ctxHolder.scheduler = scheduler;
  ctxHolder.current.scheduler = scheduler;
  ctxHolder.current.eventBus = options.eventBus ?? null;

  const watchService = (
    deps.watchServiceFactory ??
    ((watchOptions) => new DefaultCollectionWatchService(watchOptions))
  )({
    collections: config.collections,
    store,
    scheduler,
    eventBus: options.eventBus ?? null,
    callbacks: options.watchCallbacks,
  });
  watchService.start();
  ctxHolder.watchService = watchService;
  ctxHolder.current.watchService = watchService;

  let disposed = false;

  return {
    success: true,
    runtime: {
      store,
      config,
      actualConfigPath,
      ctxHolder,
      scheduler,
      eventBus: options.eventBus ?? null,
      watchService,
      async syncAll(syncOptions = {}) {
        const syncResult = await syncAllService(config.collections, store, {
          gitPull: syncOptions.gitPull,
          runUpdateCmd: syncOptions.runUpdateCmd,
        });

        let embedResult: EmbedResult | null = null;
        if (syncOptions.triggerEmbed !== false) {
          embedResult = await scheduler.triggerNow();
        }

        return { syncResult, embedResult };
      },
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        await watchService.dispose();
        options.eventBus?.close();
        scheduler.dispose();
        await (deps.disposeServerContext ?? disposeServerContext)(
          ctxHolder.current
        );
        await store.close();
      },
    },
  };
}
