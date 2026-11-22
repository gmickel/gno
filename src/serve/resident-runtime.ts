/** Single-process ownership boundary shared by serve and daemon surfaces. */

// node:fs watch: Bun has no recursive/directory watcher API with explicit close().
import { type FSWatcher, watch as fsWatch } from "node:fs";
// node:path basename/dirname/join/resolve have no Bun path utility equivalents.
import { basename, dirname, join, resolve } from "node:path";

import type { Config } from "../config/types";
import type { WriteLockHandle } from "../core/file-lock";
import type { SyncResult } from "../ingestion";
import type { ModelManager } from "../llm/nodeLlamaCpp/lifecycle";
import type { ToolContext } from "../mcp/context";
import type { HttpMcpTransportStatus } from "../mcp/http-transport";
import type { SessionAutomationRunResult } from "../sessions/types";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedResult, EmbedScheduler } from "./embed-scheduler";
import type { FindingsPassResult, FindingsScheduler } from "./findings-pass";
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
import { collectionEgressPolicyEpoch } from "../core/collection-egress-policy-service";
import { authorizeCurrentEgress } from "../core/egress-authorization";
import { acquireWriteLock } from "../core/file-lock";
import { JobManager } from "../core/job-manager";
import { recordContentMutation } from "../core/mutation-generations";
import {
  shutdownDuration,
  RESIDENT_BUSY_TIMEOUT_MS,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_ABORT_MS,
} from "../core/shutdown-budget";
import { acquireCliWriteLease } from "../core/write-lease";
import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { disposeFileProcessor } from "../ingestion/file-processor";
import { withOwnedInferenceScope } from "../llm/inference-scope";
import { getActivePreset } from "../llm/registry";
import { createToolContext, Mutex } from "../mcp/context";
import { watchedCollections } from "../sessions/config";
import {
  adoptServedConfig,
  readInstanceConfig,
} from "../sessions/config-refresh";
import { remoteSafeSessionsError } from "../sessions/types";
import {
  SqliteAdapter,
  StaleCollectionsError,
  staleCollectionsMessage,
} from "../store/sqlite/adapter";
import {
  createServerContext,
  type CreateServerContextOptions,
  disposeServerContext,
  type ServerContext,
} from "./context";
import { createEmbedScheduler, embedSchedulerIssues } from "./embed-scheduler";
import { AdmissionController, ReaderGate } from "./resident-admission";
import { ResidentBackgroundWork } from "./resident-background-work";
import { disposeResidentResources } from "./resident-shutdown";
import {
  createStandaloneResidentStatus,
  buildResidentStatusSnapshot,
} from "./resident-status";
import {
  notifyAutomationImport,
  SessionAutomationScheduler,
} from "./session-automation";
import { CollectionWatchService as DefaultCollectionWatchService } from "./watch-service";

const OWNER_LOCK_TIMEOUT_MS = 0;
/** Safety fallback interval if directory fs.watch fails on the config parent. */
const CONFIG_REFRESH_FALLBACK_INTERVAL_MS = 60_000;
/** Coalesce bursty editor/atomic-rename events from the config directory watcher. */
const CONFIG_WATCH_DEBOUNCE_MS = 50;

export type ResidentMode = "serve" | "daemon";

export interface ResidentRuntimeOptions {
  configPath?: string;
  index?: string;
  mode?: ResidentMode;
  requireCollections?: boolean;
  offline?: boolean;
  eventBus?: DocumentEventBus | null;
  watchCallbacks?: CollectionWatchCallbacks;
  /** Daemon mode only: observes every scheduled findings-pass attempt. */
  onFindingsResult?: (result: FindingsPassResult) => void;
  /** Daemon mode on a session archive: observes every automation run. */
  onSessionAutomationResult?: (result: SessionAutomationRunResult) => void;
  onSessionAutomationError?: (error: unknown) => void;
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
  authorizationEpoch?: string;
  id: string;
  signal: AbortSignal;
  isAuthorizationEpochCurrent?(): boolean;
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
  /** Present only when daemon mode runs with `findings.enabled`. */
  readonly findingsScheduler: FindingsScheduler | null;
  /** Present only when daemon mode runs on a session-archive config. */
  readonly sessionAutomation: SessionAutomationScheduler | null;
  readonly modelManager: Pick<
    ModelManager,
    "acquireLease" | "getLifecycleStats" | "disposeAll"
  >;
  readonly mcpContext: ToolContext;
  readonly generations: ResidentGeneration;
  readonly activeRequests: number;
  readonly activeSessions: number;
  readonly authorizationEpoch: string;
  readonly isShuttingDown: boolean;
  getStatus(): ResidentStatus;
  setListenerPort(port: number | null): void;
  setTransportStatusProvider(
    provider: (() => HttpMcpTransportStatus) | null
  ): void;
  setPolicySessionInvalidator(invalidator: (() => Promise<void>) | null): void;
  /**
   * Adopt collection (and context) edits made to the config file while the
   * resident runs, with the sessions refresh's binding checks: rejects when
   * the file is unreadable or bound to another index, leaving the served
   * config as it was. Other settings keep their restart behaviour. Callers
   * run it before admitting a request (an adoption moves the policy epoch).
   * Optional only for test doubles; the real runtime always provides it.
   */
  refreshConfig?(): Promise<void>;
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
  dispose(closeSurface?: () => Promise<unknown>): Promise<void>;
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
    acquireWriteLease?: () => Promise<(() => Promise<void>) | null>;
    reconcileOnStart?: boolean;
  }) => CollectionWatchService;
  modelManagerFactory?: (config: Config) => ModelManager;
};

/** No-wait shared writer lease for background writes; null when held elsewhere. */
async function acquireBackgroundWriteLease(
  dbPath: string,
  command: string
): Promise<(() => Promise<void>) | null> {
  const lease = await acquireCliWriteLease({
    dbPath,
    waitMs: 0,
    noWait: true,
    command,
  });
  return lease.ok ? lease.release : null;
}

export async function startResidentRuntime(
  options: ResidentRuntimeOptions = {},
  deps: ResidentRuntimeDeps = {}
): Promise<ResidentRuntimeResult> {
  shutdownDuration(options.shutdownDeadlineMs, SHUTDOWN_DRAIN_MS);
  shutdownDuration(options.shutdownAbortSettleMs, SHUTDOWN_ABORT_MS);
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

  const paths = (deps.getConfigPaths ?? getConfigPaths)();
  const actualConfigPath = resolve(options.configPath ?? paths.configFile);
  const readConfigStampAt = async (
    filePath: string
  ): Promise<string | undefined> => {
    try {
      const stat = await Bun.file(filePath).stat();
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return undefined;
    }
  };
  const startupStampBefore = await readConfigStampAt(actualConfigPath);
  const configResult = await (deps.loadConfig ?? loadConfig)(
    options.configPath
  );
  const startupStampAfter = await readConfigStampAt(actualConfigPath);
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

  const mode: ResidentMode = options.mode ?? "serve";
  const findingsRunStateMod =
    mode === "daemon" ? await import("../core/findings-run-state") : null;
  const findingsResolution = findingsRunStateMod
    ? findingsRunStateMod.resolveFindingsSchedule(initialConfig)
    : ({ ok: true, enabled: false } as const);
  if (!findingsResolution.ok) {
    return { success: false, error: findingsResolution.error };
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
  store.setConfigPath(actualConfigPath);
  const openResult = await store.open(
    dbPath,
    initialConfig.ftsTokenizer,
    initialConfig.busyTimeoutMs
  );
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
  // SQLite busy waits block this event loop; keep each one short enough that
  // a stop signal is still handled within the stop grace.
  store.setBusyTimeout?.(RESIDENT_BUSY_TIMEOUT_MS);
  const leaseFor = (command: string) => () =>
    acquireBackgroundWriteLease(dbPath, command);

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
  const modelManager = deps.modelManagerFactory?.(initialConfig) ?? {
    acquireLease: () =>
      ctxHolder.current.llm?.acquireModelLease() ?? { release() {} },
    getLifecycleStats: () =>
      ctxHolder.current.llm?.getLifecycleStats() ??
      createStandaloneResidentStatus("stdio").models,
    disposeAll: async () => {
      await ctxHolder.current.llm?.dispose();
    },
  };
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
    onEmbedded: () => {
      generations.index += 1;
    },
    acquireWriteLease: leaseFor(`gno ${mode} (background embed)`),
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
    collections: watchedCollections(initialConfig),
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
    acquireWriteLease: leaseFor(`gno ${mode} (watch sync)`),
    // serve has no initial sync of its own; the daemon runs one unless told not to.
    reconcileOnStart: mode === "serve",
  });
  watchService.start();
  // A backlog left by `--no-embed` or an earlier run gets a pass without
  // waiting for a file change.
  const startupStatus = await store.getStatus({
    embedModel: getActivePreset(initialConfig).embed,
  });
  if (startupStatus.ok && startupStatus.value.embeddingBacklog > 0)
    scheduler.notifySyncComplete([]);
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
  let authorizationEpoch = collectionEgressPolicyEpoch(initialConfig);
  jobManager.setAuthorizationEpoch(authorizationEpoch);
  ctxHolder.jobManager = jobManager;
  const admission = new AdmissionController();
  const readerGate = new ReaderGate(
    options.readerLimit,
    options.readerQueueLimit
  );
  const startedAt = Date.now();
  let listenerPort: number | null = null;
  let transportStatusProvider: (() => HttpMcpTransportStatus) | null = null;
  let policySessionInvalidator: (() => Promise<void>) | null = null;
  let shutdownState: ResidentStatus["shutdown"]["state"] = "none";
  let admissionState: ResidentStatus["admission"]["state"] = "accepting";
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const backgroundWork = new ResidentBackgroundWork(
    () => !disposed && admission.accepting
  );
  let findingsScheduler: FindingsScheduler | null = null;
  if (findingsRunStateMod) {
    const findingsStatePath = findingsRunStateMod.findingsRunStatePath(dbPath);
    if (findingsResolution.enabled) {
      const { FindingsScheduler: FindingsSchedulerCtor } =
        await import("./findings-pass");
      findingsScheduler = new FindingsSchedulerCtor({
        deps: {
          store,
          getConfig: () => ctxHolder.config,
          schedule: findingsResolution.schedule,
          dbPath,
          indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
          statePath: findingsStatePath,
        },
        startBackgroundWork: (operation) => backgroundWork.start(operation),
        onResult: options.onFindingsResult,
      });
      await findingsScheduler.start();
    } else {
      // Findings are off: a state file from an earlier configuration would
      // otherwise keep reporting a schedule that no longer exists.
      await findingsRunStateMod.deleteFindingsRunState(findingsStatePath);
    }
  }
  // Session automation drains only in daemon mode on an archive config;
  // `serve` never runs admitted hook work or schedules.
  let sessionAutomation: SessionAutomationScheduler | null = null;
  if (mode === "daemon" && initialConfig.sessions) {
    sessionAutomation = new SessionAutomationScheduler({
      store,
      configPath: actualConfigPath,
      indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
      dbPath,
      startBackgroundWork: (operation) => backgroundWork.start(operation),
      onResult: (result) => {
        notifyAutomationImport(result, {
          markMutation: () => {
            generations.content += 1;
            generations.index += 1;
          },
          notifySyncComplete: (collections) =>
            scheduler.notifySyncComplete(collections),
        });
        options.onSessionAutomationResult?.(result);
      },
      onError: options.onSessionAutomationError,
    });
    sessionAutomation.start();
  }
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

  const setServedConfig = (config: Config): void => {
    ctxHolder.config = config;
    ctxHolder.current = { ...ctxHolder.current, config };
    ctxHolder.watchService?.updateCollections(
      watchedCollections(config),
      withContentTypeRules({}, config)
    );
  };
  const instance = {
    configPath: actualConfigPath,
    indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
  };
  let configRefresh: Promise<void> | undefined;
  // Every read request refreshes the config. Re-reading and re-parsing an
  // unchanged file each time kept the main thread busy under load; skip it
  // while the file's identity, size and times match the last good load. Any
  // write, rename, chmod or delete changes the stamp, so a broken file is
  // still reported, never served stale.
  const configStamp = (): Promise<string | undefined> =>
    readConfigStampAt(instance.configPath);
  // Seed the stamp only when the file was verified unchanged across the
  // initial config read (and default loader was used). If the file changed
  // mid-load or between load and watcher install, leave undefined or reconcile
  // once after installing the watcher so replacements are never masked.
  let loadedConfigStamp: string | undefined =
    !deps.loadConfig &&
    startupStampBefore !== undefined &&
    startupStampBefore === startupStampAfter
      ? startupStampAfter
      : undefined;
  // Another client may index a collection the served config omits after this
  // runtime started; requests fail instead of reading it. Memoize clean checks
  // by (PRAGMA data_version, total_changes, configRef) on committed reads only.
  let cachedCleanStaleCheck: {
    dataVersion: number;
    totalChanges: number;
    configRef: Config;
  } | null = null;
  const readDbVersionTuple = (): {
    dataVersion: number;
    totalChanges: number;
  } | null => {
    try {
      if (typeof Reflect.get(store, "getRawDb") !== "function") {
        return null;
      }
      const db = store.getRawDb();
      if (db.inTransaction) {
        return null;
      }
      const row = db
        .query<{ dv: number; tc: number }, []>(
          "SELECT (SELECT * FROM pragma_data_version) AS dv, total_changes() AS tc"
        )
        .get();
      return row ? { dataVersion: row.dv, totalChanges: row.tc } : null;
    } catch {
      return null;
    }
  };
  const assertServedCollections = (): void => {
    const configRef = ctxHolder.config;
    const dbVersion = readDbVersionTuple();
    if (
      dbVersion &&
      cachedCleanStaleCheck &&
      cachedCleanStaleCheck.configRef === configRef &&
      cachedCleanStaleCheck.dataVersion === dbVersion.dataVersion &&
      cachedCleanStaleCheck.totalChanges === dbVersion.totalChanges
    ) {
      return;
    }
    const stale = store.staleIndexedCollections(
      configRef.collections.map(({ name }) => name)
    );
    if (stale.length > 0) {
      cachedCleanStaleCheck = null;
      throw new StaleCollectionsError(staleCollectionsMessage(stale));
    }
    if (dbVersion) {
      cachedCleanStaleCheck = {
        dataVersion: dbVersion.dataVersion,
        totalChanges: dbVersion.totalChanges,
        configRef,
      };
    }
  };
  const refreshConfig = (): Promise<void> => {
    configRefresh ??= (async () => {
      const stamp = await configStamp();
      if (stamp !== undefined && stamp === loadedConfigStamp) {
        assertServedCollections();
        return;
      }
      const file = await readInstanceConfig(
        instance,
        deps.loadConfig ?? loadConfig
      );
      const served = ctxHolder.config;
      const next: Config = {
        ...served,
        collections: file.collections,
        contexts: file.contexts,
      };
      if (Bun.deepEquals(next, served)) {
        loadedConfigStamp = stamp;
        assertServedCollections();
        return;
      }
      await adoptServedConfig(
        {
          ...instance,
          store,
          config: served,
          setConfig: setServedConfig,
          invalidateEgressPolicy: async () => {
            await ctxHolder.invalidateEgressPolicy?.();
          },
          markContentMutation: () => ctxHolder.markContentMutation?.(),
          markIndexMutation: () => ctxHolder.markIndexMutation?.(),
        },
        next
      );
      loadedConfigStamp = stamp;
    })().finally(() => {
      configRefresh = undefined;
    });
    return configRefresh;
  };

  const mcpContext = createToolContext({
    store,
    getConfig: () => ctxHolder.config,
    setConfig: setServedConfig,
    actualConfigPath,
    indexName: canonicalizeIndexName(options.index ?? DEFAULT_INDEX_NAME),
    toolMutex,
    jobManager,
    serverInstanceId,
    writeLockPath,
    enableWrite: false,
    isShuttingDown: () => disposed || !admission.accepting,
    getModelAdapter: (config) =>
      config === ctxHolder.current.config ? ctxHolder.current.llm : undefined,
    markContentMutation: () => {
      generations.content += 1;
    },
    markIndexMutation: () => {
      generations.index += 1;
    },
    invalidateEgressPolicy: async () =>
      (await ctxHolder.invalidateEgressPolicy?.()) ?? {
        policyEpoch: collectionEgressPolicyEpoch(ctxHolder.config),
        queuedJobsInvalidated: 0,
        sessionsInvalidated: 0,
        staleWorkMustRetry: true,
      },
  });
  mcpContext.authorizeTraceExport = async (lineage) => {
    const egress = mcpContext.getEgressContext?.();
    return authorizeCurrentEgress({
      store,
      config: ctxHolder.config,
      lineage,
      action: "export",
      destinationZone:
        egress?.destinationZone === "loopback"
          ? "local_process"
          : (egress?.destinationZone ?? "local_process"),
      caller: egress?.caller ?? {
        authenticated: true,
        operationAuthorized: true,
      },
      contentClass: "retrieval_trace",
    });
  };

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
    findingsScheduler,
    sessionAutomation,
    modelManager,
    mcpContext,
    generations,
    get activeRequests() {
      return admission.active;
    },
    get activeSessions() {
      return transportStatusProvider?.().activeSessions ?? 0;
    },
    get authorizationEpoch() {
      return authorizationEpoch;
    },
    get isShuttingDown() {
      return disposed || !admission.accepting;
    },
    admitRequest: (signal) => {
      const admitted = admission.admit(signal);
      if (!admitted) return null;
      const requestEpoch = authorizationEpoch;
      return {
        ...admitted,
        authorizationEpoch: requestEpoch,
        isAuthorizationEpochCurrent: () => requestEpoch === authorizationEpoch,
      };
    },
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
        backgroundIssues: embedSchedulerIssues(scheduler.getState()),
      });
    },
    setListenerPort(port) {
      listenerPort = port;
    },
    setTransportStatusProvider(provider) {
      transportStatusProvider = provider;
    },
    setPolicySessionInvalidator(invalidator) {
      policySessionInvalidator = invalidator;
    },
    refreshConfig,
    async syncAll(syncOptions = {}) {
      const request = admission.admit();
      if (!request) throw new Error("Resident runtime is shutting down");
      try {
        return await withOwnedInferenceScope(
          { signal: request.signal },
          async () => {
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
          }
        );
      } finally {
        request.finish();
      }
    },
    dispose(closeSurface) {
      if (disposal) return disposal;
      disposed = true;
      stopConfigMonitoring();
      admission.stop();
      jobManager.stop();
      // A file mid-preparation fails now instead of holding shutdown.
      disposeFileProcessor();
      admissionState = "draining";
      shutdownState = "graceful";
      disposal = disposeResidentResources({
        options,
        admission,
        backgroundWork,
        jobManager,
        scheduler,
        store,
        watchService,
        context: ctxHolder.current,
        mcpContext,
        modelManager,
        ownerLock,
        stopFindings: () => {
          findingsScheduler?.dispose();
          sessionAutomation?.dispose();
        },
        stopCapsules: () => capsuleReverificationScheduler.dispose(),
        closeEvents: () => options.eventBus?.close(),
        disposeContext: deps.disposeServerContext ?? disposeServerContext,
        closeSurface,
        onDeadline: () => {
          shutdownState = "deadline";
        },
      }).then(() => {
        admissionState = "closed";
        transportStatusProvider = null;
        listenerPort = null;
      });
      return disposal;
    },
  };
  ctxHolder.startBackgroundWork = (operation) =>
    runtime.startBackgroundWork(operation);
  ctxHolder.invalidateEgressPolicy = async () => {
    const sessionsInvalidated = transportStatusProvider?.().activeSessions ?? 0;
    const policyEpoch = collectionEgressPolicyEpoch(ctxHolder.config);
    authorizationEpoch = policyEpoch;
    const queuedJobsInvalidated = jobManager.setAuthorizationEpoch(policyEpoch);
    await policySessionInvalidator?.();
    return {
      policyEpoch,
      queuedJobsInvalidated,
      sessionsInvalidated,
      staleWorkMustRetry: true,
    };
  };
  mcpContext.getResidentStatus = () => runtime.getStatus();
  // Without requests (a headless daemon) the watcher still follows config edits
  // via fs.watch on the config parent directory (handling both in-place edits
  // and atomic temp-file renames), falling back to a 60s timer only if fs.watch
  // is unavailable or errors.
  let lastRefreshError: string | undefined;
  let configWatcher: FSWatcher | null = null;
  let configWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let configRefreshFallbackTimer: ReturnType<typeof setInterval> | null = null;

  const triggerBackgroundConfigRefresh = (): void => {
    if (disposed) return;
    backgroundWork.start(async () => {
      try {
        await refreshConfig();
        lastRefreshError = undefined;
      } catch (error) {
        // The stale-collections message names collections, never paths.
        const message =
          error instanceof StaleCollectionsError
            ? error.message
            : remoteSafeSessionsError(error).message;
        if (message !== lastRefreshError)
          console.warn(`gno ${mode}: config not reloaded: ${message}`);
        lastRefreshError = message;
      }
    });
  };

  const ensureFallbackRefreshTimer = (): void => {
    if (disposed || configRefreshFallbackTimer) return;
    configRefreshFallbackTimer = setInterval(
      triggerBackgroundConfigRefresh,
      CONFIG_REFRESH_FALLBACK_INTERVAL_MS
    );
    configRefreshFallbackTimer.unref?.();
  };

  const stopConfigMonitoring = (): void => {
    if (configWatchDebounceTimer) {
      clearTimeout(configWatchDebounceTimer);
      configWatchDebounceTimer = null;
    }
    if (configRefreshFallbackTimer) {
      clearInterval(configRefreshFallbackTimer);
      configRefreshFallbackTimer = null;
    }
    if (configWatcher) {
      try {
        configWatcher.close();
      } catch {
        // Ignore watcher close errors during shutdown
      }
      configWatcher = null;
    }
  };

  const configDir = dirname(actualConfigPath);
  const configFileName = basename(actualConfigPath);
  try {
    configWatcher = fsWatch(
      configDir,
      { persistent: false },
      (_eventType, filename) => {
        if (disposed) return;
        const changedName =
          typeof filename === "string"
            ? basename(filename)
            : filename
              ? basename(String(filename))
              : null;
        if (changedName !== null && changedName !== configFileName) {
          return;
        }
        if (configWatchDebounceTimer) {
          clearTimeout(configWatchDebounceTimer);
        }
        configWatchDebounceTimer = setTimeout(() => {
          configWatchDebounceTimer = null;
          triggerBackgroundConfigRefresh();
        }, CONFIG_WATCH_DEBOUNCE_MS);
        configWatchDebounceTimer.unref?.();
      }
    );
    configWatcher.on("error", () => {
      if (configWatcher) {
        try {
          configWatcher.close();
        } catch {
          // Ignore close errors after watcher failure
        }
        configWatcher = null;
      }
      ensureFallbackRefreshTimer();
    });
  } catch {
    ensureFallbackRefreshTimer();
  }
  // Reconcile once after installing the watcher in case the config file was
  // replaced between startup load and watcher registration.
  if (
    loadedConfigStamp === undefined ||
    (await configStamp()) !== loadedConfigStamp
  ) {
    triggerBackgroundConfigRefresh();
  }
  return { success: true, runtime };
}
