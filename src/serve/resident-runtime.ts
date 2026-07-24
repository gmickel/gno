/** Single-process ownership boundary shared by serve and daemon surfaces. */

// node:path resolve/dirname/join have no Bun path utility equivalents.
import { dirname, join, resolve } from "node:path";

import type { Config } from "../config/types";
import type { WriteLockHandle } from "../core/file-lock";
import type { SyncResult } from "../ingestion";
import type { ModelManager } from "../llm/nodeLlamaCpp/lifecycle";
import type { ToolContext } from "../mcp/context";
import type { HttpMcpTransportStatus } from "../mcp/http-transport";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedResult, EmbedScheduler } from "./embed-scheduler";
import type { ContextHolder } from "./routes/api";
import type { ResidentStatus } from "./status-model";
import type {
  CollectionWatchCallbacks,
  CollectionWatchService,
} from "./watch-service";

import { DEFAULT_INDEX_NAME, getIndexDbPath } from "../app/constants";
import {
  canonicalizeIndexName,
  INDEX_NAME_REQUIREMENTS,
  isValidIndexName,
} from "../app/index-name";
import {
  ensureDirectories,
  formatConfigWarnings,
  getConfigPaths,
  isInitialized,
  loadConfig,
} from "../config";
import { SavedCapsuleReverificationScheduler } from "../core/capsule-reverification-scheduler";
import { acquireWriteLock } from "../core/file-lock";
import { JobManager } from "../core/job-manager";
import { recordContentMutation } from "../core/mutation-generations";
import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { getModelManager } from "../llm/nodeLlamaCpp/lifecycle";
import { getModelConfig } from "../llm/registry";
import { getActivePreset } from "../llm/registry";
import { createToolContext, Mutex } from "../mcp/context";
import { SqliteAdapter } from "../store/sqlite/adapter";
import {
  createServerContext,
  type CreateServerContextOptions,
  disposeServerContext,
  type ServerContext,
} from "./context";
import { createEmbedScheduler } from "./embed-scheduler";
import { AdmissionController, ReaderGate } from "./resident-admission";
import { ResidentBackgroundWork } from "./resident-background-work";
import { buildResidentStatusSnapshot } from "./resident-status";
import { CollectionWatchService as DefaultCollectionWatchService } from "./watch-service";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
const OWNER_LOCK_TIMEOUT_MS = 0;

export type ResidentMode = "serve" | "daemon";

export interface ResidentRuntimeOptions {
  configPath?: string;
  index?: string;
  mode?: ResidentMode;
  requireCollections?: boolean;
  offline?: boolean;
  eventBus?: DocumentEventBus | null;
  watchCallbacks?: CollectionWatchCallbacks;
  readerLimit?: number;
  readerQueueLimit?: number;
  shutdownDeadlineMs?: number;
  shutdownAbortSettleMs?: number;
}

export interface ResidentGeneration {
  content: number;
  index: number;
}

export interface ResidentRequestHandle {
  id: string;
  signal: AbortSignal;
  finish(): void;
}

export interface ResidentRuntime {
  readonly mode: ResidentMode;
  readonly store: SqliteAdapter;
  readonly config: Config;
  readonly actualConfigPath: string;
  readonly ctxHolder: ContextHolder;
  readonly scheduler: EmbedScheduler;
  readonly eventBus: DocumentEventBus | null;
  readonly watchService: CollectionWatchService;
  readonly toolMutex: Mutex;
  readonly readerGate: ReaderGate;
  readonly jobManager: JobManager;
  readonly capsuleReverificationScheduler: SavedCapsuleReverificationScheduler;
  readonly modelManager: ModelManager;
  readonly mcpContext: ToolContext;
  readonly generations: ResidentGeneration;
  readonly activeRequests: number;
  readonly activeSessions: number;
  readonly isShuttingDown: boolean;
  getStatus(): ResidentStatus;
  setListenerPort(port: number | null): void;
  setTransportStatusProvider(
    provider: (() => HttpMcpTransportStatus) | null
  ): void;
  admitRequest(signal?: AbortSignal): ResidentRequestHandle | null;
  withModelLease<T>(operation: () => Promise<T>): Promise<T>;
  markContentMutation(): void;
  markIndexMutation(): void;
  startBackgroundWork(
    operation: (signal: AbortSignal) => Promise<void>
  ): boolean;
  openSession(): () => void;
  syncAll(options?: {
    gitPull?: boolean;
    runUpdateCmd?: boolean;
    triggerEmbed?: boolean;
  }): Promise<{ syncResult: SyncResult; embedResult: EmbedResult | null }>;
  dispose(): Promise<void>;
}

export type ResidentRuntimeResult =
  | { success: true; runtime: ResidentRuntime }
  | { success: false; error: string };

export type ResidentRuntimeDeps = {
  isInitialized?: typeof isInitialized;
  loadConfig?: typeof loadConfig;
  getConfigPaths?: typeof getConfigPaths;
  ensureDirectories?: typeof ensureDirectories;
  acquireOwnerLock?: (
    path: string,
    timeoutMs: number
  ) => Promise<WriteLockHandle | null>;
  storeFactory?: () => SqliteAdapter;
  createServerContext?: (
    store: SqliteAdapter,
    config: Config,
    options?: CreateServerContextOptions
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
    syncOptions?: Parameters<typeof withContentTypeRules>[0];
  }) => CollectionWatchService;
  modelManagerFactory?: (config: Config) => ModelManager;
};

export async function startResidentRuntime(
  options: ResidentRuntimeOptions = {},
  deps: ResidentRuntimeDeps = {}
): Promise<ResidentRuntimeResult> {
  if (options.index !== undefined && !isValidIndexName(options.index)) {
    return {
      success: false,
      error: `Invalid index name: ${INDEX_NAME_REQUIREMENTS}.`,
    };
  }

  const initialized = await (deps.isInitialized ?? isInitialized)(
    options.configPath
  );
  if (!initialized)
    return { success: false, error: "GNO not initialized. Run: gno init" };

  const configResult = await (deps.loadConfig ?? loadConfig)(
    options.configPath
  );
  if (!configResult.ok)
    return { success: false, error: configResult.error.message };
  for (const warning of formatConfigWarnings(configResult.warnings))
    console.warn(warning);
  const initialConfig = configResult.value;
  if (options.requireCollections && initialConfig.collections.length === 0) {
    return {
      success: false,
      error: "No collections configured. Run: gno collection add <path>",
    };
  }

  await (deps.ensureDirectories ?? ensureDirectories)();
  const dbPath = getIndexDbPath(options.index);
  const ownerLockPath = join(dirname(dbPath), ".resident-owner.lock");
  const ownerLock = await (deps.acquireOwnerLock ?? acquireWriteLock)(
    ownerLockPath,
    OWNER_LOCK_TIMEOUT_MS
  );
  if (!ownerLock) {
    return {
      success: false,
      error: `Resident runtime already active for index "${canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME)}". Stop the owning gno serve or gno daemon process and retry.`,
    };
  }

  const store = deps.storeFactory?.() ?? new SqliteAdapter();
  const paths = (deps.getConfigPaths ?? getConfigPaths)();
  const actualConfigPath = resolve(options.configPath ?? paths.configFile);
  store.setConfigPath(actualConfigPath);
  const openResult = await store.open(dbPath, initialConfig.ftsTokenizer);
  if (!openResult.ok) {
    await ownerLock.release();
    return { success: false, error: openResult.error.message };
  }

  const failStartup = async (error: string): Promise<ResidentRuntimeResult> => {
    await Promise.allSettled([store.close(), ownerLock.release()]);
    return { success: false, error };
  };
  const syncCollections = await store.syncCollections(
    initialConfig.collections
  );
  if (!syncCollections.ok) return failStartup(syncCollections.error.message);
  const syncContexts = await store.syncContexts(initialConfig.contexts ?? []);
  if (!syncContexts.ok) return failStartup(syncContexts.error.message);

  let ctx: ServerContext;
  try {
    ctx = await (deps.createServerContext ?? createServerContext)(
      store,
      initialConfig,
      {
        offline: options.offline ?? false,
        indexName: options.index,
      }
    );
  } catch (error) {
    return failStartup(error instanceof Error ? error.message : String(error));
  }

  const ctxHolder: ContextHolder = {
    current: ctx,
    config: initialConfig,
    actualConfigPath,
    scheduler: null,
    eventBus: options.eventBus ?? null,
    watchService: null,
  };
  const modelManager =
    deps.modelManagerFactory?.(initialConfig) ??
    getModelManager(getModelConfig(initialConfig));
  const generations: ResidentGeneration = { content: 0, index: 0 };
  ctxHolder.markContentMutation = () => {
    generations.content += 1;
  };
  ctxHolder.markIndexMutation = () => {
    generations.index += 1;
  };
  const scheduler = (deps.createEmbedScheduler ?? createEmbedScheduler)({
    db: store.getRawDb(),
    getEmbedPort: () => ctxHolder.current.embedPort,
    getVectorIndex: () => ctxHolder.current.vectorIndex,
    getModelUri: () => getActivePreset(ctxHolder.config).embed,
    acquireModelLease: () => modelManager.acquireLease(),
    onEmbedded: () => {
      generations.index += 1;
    },
  });
  ctxHolder.scheduler = scheduler;
  ctxHolder.current.scheduler = scheduler;
  ctxHolder.current.eventBus = options.eventBus ?? null;

  let capsuleReverificationScheduler: SavedCapsuleReverificationScheduler | null =
    null;
  const watchService = (
    deps.watchServiceFactory ??
    ((watchOptions) => new DefaultCollectionWatchService(watchOptions))
  )({
    collections: initialConfig.collections,
    store,
    scheduler,
    eventBus: options.eventBus ?? null,
    callbacks: {
      ...options.watchCallbacks,
      onSyncComplete: (event) => {
        recordContentMutation(event.result, () => {
          generations.content += 1;
        });
        options.watchCallbacks?.onSyncComplete?.(event);
      },
      onSettled: () => {
        capsuleReverificationScheduler?.notifySyncSettled();
        options.watchCallbacks?.onSettled?.();
      },
    },
    syncOptions: withContentTypeRules({}, initialConfig),
  });
  watchService.start();
  ctxHolder.watchService = watchService;
  ctxHolder.current.watchService = watchService;

  const toolMutex = new Mutex();
  const serverInstanceId = crypto.randomUUID();
  const writeLockPath = join(dirname(dbPath), ".mcp-write.lock");
  const jobManager = new JobManager({
    lockPath: writeLockPath,
    serverInstanceId,
    toolMutex,
  });
  ctxHolder.jobManager = jobManager;
  const admission = new AdmissionController();
  const readerGate = new ReaderGate(
    options.readerLimit,
    options.readerQueueLimit
  );
  const startedAt = Date.now();
  let listenerPort: number | null = null;
  let transportStatusProvider: (() => HttpMcpTransportStatus) | null = null;
  let shutdownState: ResidentStatus["shutdown"]["state"] = "none";
  let admissionState: ResidentStatus["admission"]["state"] = "accepting";
  let disposed = false;
  const backgroundWork = new ResidentBackgroundWork(
    () => !disposed && admission.accepting
  );
  capsuleReverificationScheduler = new SavedCapsuleReverificationScheduler({
    deps: {
      store,
      get config() {
        return ctxHolder.config;
      },
      indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
      notify: (event) => options.eventBus?.emit(event),
    },
    startBackgroundWork: (operation) => backgroundWork.start(operation),
  });

  const mcpContext = createToolContext({
    store,
    getConfig: () => ctxHolder.config,
    setConfig: (config) => {
      ctxHolder.config = config;
      ctxHolder.current = { ...ctxHolder.current, config };
      ctxHolder.watchService?.updateCollections(
        config.collections,
        withContentTypeRules({}, config)
      );
    },
    actualConfigPath,
    indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
    toolMutex,
    jobManager,
    serverInstanceId,
    writeLockPath,
    enableWrite: false,
    isShuttingDown: () => disposed || !admission.accepting,
    acquireModelLease: () => modelManager.acquireLease(),
    markContentMutation: () => {
      generations.content += 1;
    },
    markIndexMutation: () => {
      generations.index += 1;
    },
  });

  const runtime: ResidentRuntime = {
    mode: options.mode ?? "serve",
    store,
    get config() {
      return ctxHolder.config;
    },
    actualConfigPath,
    ctxHolder,
    scheduler,
    eventBus: options.eventBus ?? null,
    watchService,
    toolMutex,
    readerGate,
    jobManager,
    capsuleReverificationScheduler,
    modelManager,
    mcpContext,
    generations,
    get activeRequests() {
      return admission.active;
    },
    get activeSessions() {
      return transportStatusProvider?.().activeSessions ?? 0;
    },
    get isShuttingDown() {
      return disposed || !admission.accepting;
    },
    admitRequest: (signal) => admission.admit(signal),
    async withModelLease<T>(operation: () => Promise<T>): Promise<T> {
      const lease = modelManager.acquireLease();
      try {
        return await operation();
      } finally {
        lease.release();
      }
    },
    markContentMutation() {
      generations.content += 1;
    },
    markIndexMutation() {
      generations.index += 1;
    },
    startBackgroundWork(operation) {
      return backgroundWork.start(operation);
    },
    openSession() {
      return () => undefined;
    },
    getStatus() {
      const transport = transportStatusProvider?.() ?? {
        activeRequests: 0,
        activeSessions: 0,
        queuedRequests: 0,
        maxConcurrentRequests: 0,
        maxQueuedRequests: 0,
        maxSessions: 0,
      };
      const jobs = jobManager.listJobs(100);
      return buildResidentStatusSnapshot({
        mode: options.mode ?? "serve",
        startedAt,
        listenerPort,
        admission: {
          state: admissionState,
          activeRequests: admission.active,
        },
        shutdown: { state: shutdownState },
        transport,
        readers: {
          active: readerGate.active,
          queued: readerGate.queued,
          limit: readerGate.limit,
          maxQueued: readerGate.maxQueued,
        },
        models: modelManager.getLifecycleStats(),
        jobs: {
          active: jobs.active.length,
          recent: jobs.recent.length,
          failed: jobs.recent.filter((job) => job.status === "failed").length,
        },
        generations: { ...generations },
      });
    },
    setListenerPort(port) {
      listenerPort = port;
    },
    setTransportStatusProvider(provider) {
      transportStatusProvider = provider;
    },
    async syncAll(syncOptions = {}) {
      const config = ctxHolder.config;
      const syncAllService = deps.syncAllService
        ? (...args: Parameters<typeof defaultSyncService.syncAll>) =>
            deps.syncAllService!(...args)
        : defaultSyncService.syncAll.bind(defaultSyncService);
      const syncResult = await syncAllService(
        config.collections,
        store,
        withContentTypeRules(
          {
            gitPull: syncOptions.gitPull,
            runUpdateCmd: syncOptions.runUpdateCmd,
          },
          config
        )
      );
      recordContentMutation(syncResult, () => {
        generations.content += 1;
      });
      const embedResult =
        syncOptions.triggerEmbed === false
          ? null
          : await scheduler.triggerNow();
      capsuleReverificationScheduler.notifySyncSettled();
      return { syncResult, embedResult };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      admissionState = "draining";
      shutdownState = "graceful";
      const deadlineReached = await admission.closeAndDrain(
        options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
        options.shutdownAbortSettleMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS
      );
      if (deadlineReached) shutdownState = "deadline";
      await backgroundWork.cancelAndDrain();
      await capsuleReverificationScheduler.dispose();
      await jobManager.shutdown().catch(() => undefined);
      await Promise.allSettled([
        Promise.resolve().then(() => watchService.dispose()),
        Promise.resolve().then(() => options.eventBus?.close()),
      ]);
      await Promise.allSettled([scheduler.dispose()]);
      await Promise.allSettled([
        (deps.disposeServerContext ?? disposeServerContext)(ctxHolder.current),
      ]);
      await Promise.allSettled([modelManager.disposeAll()]);
      await Promise.allSettled([store.close()]);
      await Promise.allSettled([ownerLock.release()]);
      admissionState = "closed";
      transportStatusProvider = null;
      listenerPort = null;
    },
  };
  ctxHolder.startBackgroundWork = (operation) =>
    runtime.startBackgroundWork(operation);
  mcpContext.getResidentStatus = () => runtime.getStatus();
  return { success: true, runtime };
}
