/** Shared MCP surface and request-scoped runtime context. */

import { McpServer } from "@modelcontextprotocol/server";
// node:async_hooks provides async-local request context; Bun has no separate native equivalent.
import { AsyncLocalStorage } from "node:async_hooks";

import type { Collection, Config } from "../config/types";
import type {
  EgressCallerContext,
  EgressDestinationZone,
} from "../core/egress-policy";
import type { EgressLineage } from "../core/egress-provenance";
import type { JobManager } from "../core/job-manager";
import type { NativeDisposeOptions } from "../llm/native-worker/owned-exit";
import type { ModelLease } from "../llm/nodeLlamaCpp/lifecycle";
import type {
  EmbeddingPort,
  GenerationPort,
  LlmResult,
  RerankPort,
} from "../llm/types";
import type { ResidentStatus } from "../serve/status-model";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";
import type { VectorIndexPort } from "../store/vector";
import type { McpToolProfile } from "./tool-profile";

import { MCP_SERVER_NAME, VERSION } from "../app/constants";
import {
  type CreatePortOptions,
  LlmAdapter,
} from "../llm/nodeLlamaCpp/adapter";
import { createStandaloneResidentStatus } from "../serve/resident-status";
import { createVectorIndexPort } from "../store/vector";
import { getStoredEmbeddingDimensions } from "../store/vector/freshness";
import { createLazyVectorIndex } from "../store/vector/lazy";
import { registerResources } from "./resources/index";
import { registerTools } from "./tools/index";

export interface AsyncMutex {
  acquire(): Promise<() => void>;
  /** Shared read lock for concurrent read-only tools; falls back to exclusive acquire() on test doubles. */
  acquireRead?(): Promise<() => void>;
}

/**
 * Fair async reader-writer lock.
 * - `acquireRead()` allows concurrent read-only tools when no writer is active or queued.
 * - `acquire()` grants exclusive access for write tools, jobs, and shutdown, draining
 *   all active readers and queuing subsequent readers behind it to prevent writer starvation.
 */
export class Mutex implements AsyncMutex {
  #activeReaders = 0;
  #writerActive = false;
  readonly #waiters: Array<{ kind: "read" | "write"; grant: () => void }> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.#writerActive = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.#writerActive = false;
          this.#drain();
        });
      };
      if (
        !this.#writerActive &&
        this.#activeReaders === 0 &&
        this.#waiters.length === 0
      ) {
        grant();
        return;
      }
      this.#waiters.push({ kind: "write", grant });
    });
  }

  acquireRead(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.#activeReaders += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.#activeReaders -= 1;
          if (this.#activeReaders === 0) {
            this.#drain();
          }
        });
      };
      if (!this.#writerActive && this.#waiters.length === 0) {
        grant();
        return;
      }
      this.#waiters.push({ kind: "read", grant });
    });
  }

  #drain(): void {
    if (this.#writerActive) {
      return;
    }
    while (this.#waiters.length > 0) {
      const next = this.#waiters[0];
      if (!next) {
        break;
      }
      if (next.kind === "read") {
        this.#waiters.shift();
        next.grant();
        continue;
      }
      if (this.#activeReaders === 0) {
        this.#waiters.shift();
        next.grant();
      }
      break;
    }
  }
}

export interface ToolContextSnapshot {
  config: Config;
  collections: Collection[];
  egress?: {
    destinationZone: EgressDestinationZone;
    caller: EgressCallerContext;
    authorizationEpoch?: { value: string };
  };
  /**
   * Opaque per-caller identity the HTTP boundary derived for this request.
   * Set on both Streamable HTTP legs; the 2026-07-28 sessionless leg has no
   * session id, so this is what keeps two modern callers apart.
   */
  requestIdentity?: string;
  /** Stable request-receipt namespace of the authorized HTTP identity. */
  requestNamespace?: string;
}

export interface RequestScope {
  egress: NonNullable<ToolContextSnapshot["egress"]>;
  requestIdentity?: string;
  requestNamespace?: string;
}

export interface ToolContext {
  store: SqliteAdapter;
  config: Config;
  collections: Collection[];
  actualConfigPath: string;
  indexName: string;
  toolMutex: AsyncMutex;
  jobManager: JobManager;
  serverInstanceId: string;
  writeLockPath: string;
  enableWrite: boolean;
  /** Advertised tool set; `full` when absent. Narrows, never widens, the write gate. */
  toolProfile?: McpToolProfile;
  isShuttingDown: () => boolean;
  getResidentStatus?: () => ResidentStatus;
  getModelAdapter?: () => LlmAdapter;
  getCachedEmbeddingPort?: (
    uri: string,
    options: CreatePortOptions
  ) => Promise<LlmResult<EmbeddingPort>>;
  getCachedExpansionPort?: (
    uri: string,
    options: CreatePortOptions
  ) => Promise<LlmResult<GenerationPort>>;
  getCachedRerankPort?: (
    uri: string,
    options: CreatePortOptions
  ) => Promise<LlmResult<RerankPort>>;
  getCachedVectorIndex?: (
    modelUri: string,
    dimensions: number
  ) => Promise<StoreResult<VectorIndexPort>>;
  getCachedLazyVectorIndex?: (
    modelUri: string,
    embedPort: EmbeddingPort
  ) => Promise<VectorIndexPort | null>;
  disposeModels?: (options?: NativeDisposeOptions) => Promise<void>;
  acquireModelLease?: () => ModelLease;
  markContentMutation?: () => void;
  markIndexMutation?: () => void;
  invalidateEgressPolicy?: () => Promise<{
    policyEpoch: string;
    queuedJobsInvalidated: number;
    sessionsInvalidated: number;
    staleWorkMustRetry: true;
  }>;
  authorizeTraceExport?: (
    lineage: EgressLineage
  ) => Promise<StoreResult<EgressLineage>>;
  advanceRequestAuthorizationEpoch?: (epoch: string) => void;
  getRequestAuthorizationEpoch?: () => string | undefined;
  getEgressContext?: () => ToolContextSnapshot["egress"];
  /** Per-caller identity of the current request; absent on stdio. */
  getRequestIdentity?: () => string | undefined;
  /** Request-receipt namespace of the current HTTP caller; absent on stdio. */
  getRequestNamespace?: () => string | undefined;
  runWithEgressContext?<T>(
    egress: NonNullable<ToolContextSnapshot["egress"]>,
    operation: () => Promise<T>,
    scope?: Omit<RequestScope, "egress">
  ): Promise<T>;
  runWithSnapshot?<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Host absolute paths reach only stdio callers, which run on the owner's
 * machine. Every Streamable HTTP request runs inside an egress context,
 * whatever its peer, so HTTP callers get URIs and relative paths only.
 */
export const exposesHostPaths = (
  ctx: Pick<ToolContext, "getEgressContext">
): boolean => ctx.getEgressContext?.() === undefined;

export interface CreateToolContextOptions {
  store: SqliteAdapter;
  getConfig: () => Config;
  setConfig?: (config: Config) => void;
  actualConfigPath: string;
  indexName: string;
  toolMutex: AsyncMutex;
  jobManager: JobManager;
  serverInstanceId: string;
  writeLockPath: string;
  enableWrite: boolean;
  toolProfile?: McpToolProfile;
  isShuttingDown: () => boolean;
  getResidentStatus?: () => ResidentStatus;
  getModelAdapter?: (config: Config) => LlmAdapter | undefined;
  disposeModels?: (options?: NativeDisposeOptions) => Promise<void>;
  acquireModelLease?: () => ModelLease;
  markContentMutation?: () => void;
  markIndexMutation?: () => void;
  invalidateEgressPolicy?: ToolContext["invalidateEgressPolicy"];
  authorizeTraceExport?: ToolContext["authorizeTraceExport"];
}

/**
 * Create a transport-neutral MCP context.
 *
 * Config and collection getters resolve from one snapshot captured at the
 * request boundary, so a hot reload cannot mix old and new values mid-call.
 */
export function createToolContext(
  options: CreateToolContextOptions
): ToolContext {
  const adapters = new Map<Config, LlmAdapter>();
  let cachedPortConfig: Config | null = null;
  let cachedPortGeneration = 0;
  // Cache ONLY successfully initialized ports so concurrent callers never
  // inherit another caller's cancellation scope during cold initialization.
  const cachedEmbedPorts = new Map<string, EmbeddingPort>();
  const cachedExpandPorts = new Map<string, GenerationPort>();
  const cachedRerankPorts = new Map<string, RerankPort>();
  // Ports superseded by a config reload remain live for any in-flight caller
  // until shutdown (`disposeModels`) drains requests and disposes all ports.
  const retiredPorts = new Set<{ dispose(): Promise<void> }>();
  const cachedVectorIndexes = new Map<
    string,
    Promise<StoreResult<VectorIndexPort>>
  >();
  let modelsClosed = false;
  const requestSnapshot = new AsyncLocalStorage<ToolContextSnapshot>();
  const currentSnapshot = (): ToolContextSnapshot =>
    requestSnapshot.getStore() ??
    (() => {
      const config = options.getConfig();
      return { config, collections: config.collections };
    })();

  const portCacheKey = (
    uri: string,
    portOptions?: CreatePortOptions
  ): string => {
    const egress = portOptions?.egressCollections;
    const egressKey =
      egress === undefined || egress === "all"
        ? "*"
        : [...egress].sort().join("\u0000");
    const policy = portOptions?.policy;
    const policyKey = policy
      ? `${policy.offline ? 1 : 0}:${policy.allowDownload ? 1 : 0}`
      : "default";
    return `${uri}\u0001${egressKey}\u0001${policyKey}`;
  };

  const evictCachedPortsForConfigChange = (): void => {
    cachedPortGeneration += 1;
    for (const port of cachedEmbedPorts.values()) {
      retiredPorts.add(port);
    }
    for (const port of cachedExpandPorts.values()) {
      retiredPorts.add(port);
    }
    for (const port of cachedRerankPorts.values()) {
      retiredPorts.add(port);
    }
    cachedEmbedPorts.clear();
    cachedExpandPorts.clear();
    cachedRerankPorts.clear();
    cachedVectorIndexes.clear();
    cachedPortConfig = null;
  };

  const disposeAllCachedPorts = async (): Promise<void> => {
    evictCachedPortsForConfigChange();
    const disposals: Promise<unknown>[] = [];
    for (const port of retiredPorts) {
      disposals.push(Promise.resolve().then(() => port.dispose()));
    }
    retiredPorts.clear();
    await Promise.allSettled(disposals);
  };

  const ensurePortCacheForConfig = (config: Config): void => {
    if (cachedPortConfig !== null && cachedPortConfig !== config) {
      evictCachedPortsForConfigChange();
    }
    cachedPortConfig = config;
  };

  const resolveModelAdapter = (config: Config): LlmAdapter => {
    if (modelsClosed) throw new Error("Resident runtime is shutting down");
    const shared = options.getModelAdapter?.(config);
    if (shared) return shared;
    let adapter = adapters.get(config);
    if (!adapter) {
      adapter = new LlmAdapter(config);
      adapters.set(config, adapter);
    }
    return adapter;
  };

  return {
    store: options.store,
    get config() {
      return currentSnapshot().config;
    },
    set config(config: Config) {
      if (cachedPortConfig !== null && cachedPortConfig !== config) {
        evictCachedPortsForConfigChange();
      }
      options.setConfig?.(config);
    },
    get collections() {
      return currentSnapshot().collections;
    },
    set collections(_collections: Collection[]) {
      // Collections are derived from config. Existing write handlers assign
      // both for backwards compatibility; the config setter is authoritative.
    },
    actualConfigPath: options.actualConfigPath,
    indexName: options.indexName,
    toolMutex: options.toolMutex,
    jobManager: options.jobManager,
    serverInstanceId: options.serverInstanceId,
    writeLockPath: options.writeLockPath,
    enableWrite: options.enableWrite,
    toolProfile: options.toolProfile,
    isShuttingDown: options.isShuttingDown,
    getResidentStatus:
      options.getResidentStatus ??
      (() => createStandaloneResidentStatus("stdio")),
    getModelAdapter: () => resolveModelAdapter(currentSnapshot().config),
    getCachedEmbeddingPort: async (uri, portOptions) => {
      const config = currentSnapshot().config;
      const llm = resolveModelAdapter(config);
      ensurePortCacheForConfig(config);
      const key = portCacheKey(uri, portOptions);
      const cached = cachedEmbedPorts.get(key);
      if (cached) {
        return { ok: true, value: cached };
      }
      const generation = cachedPortGeneration;
      const res = await llm.createEmbeddingPort(uri, portOptions);
      if (!res.ok) {
        return res;
      }
      if (modelsClosed) {
        await res.value.dispose();
        return {
          ok: false,
          error: {
            code: "MODEL_LOAD_FAILED",
            message: "Resident runtime is shutting down",
            retryable: false,
          },
        };
      }
      if (generation !== cachedPortGeneration) {
        // Keep the opened port live for this in-flight snapshot caller;
        // disposeModels() will clean it up after shutdown drains requests.
        retiredPorts.add(res.value);
        return res;
      }
      const existing = cachedEmbedPorts.get(key);
      if (existing) {
        // Do NOT call res.value.dispose() while existing is active: native
        // ports share the same ModelManager slot and dispose() unloads it.
        // Defer disposal to shutdown (`disposeModels`) via retiredPorts.
        retiredPorts.add(res.value);
        return { ok: true, value: existing };
      }
      cachedEmbedPorts.set(key, res.value);
      return res;
    },
    getCachedExpansionPort: async (uri, portOptions) => {
      const config = currentSnapshot().config;
      const llm = resolveModelAdapter(config);
      ensurePortCacheForConfig(config);
      const key = portCacheKey(uri, portOptions);
      const cached = cachedExpandPorts.get(key);
      if (cached) {
        return { ok: true, value: cached };
      }
      const generation = cachedPortGeneration;
      const res = await llm.createExpansionPort(uri, portOptions);
      if (!res.ok) {
        return res;
      }
      if (modelsClosed) {
        await res.value.dispose();
        return {
          ok: false,
          error: {
            code: "MODEL_LOAD_FAILED",
            message: "Resident runtime is shutting down",
            retryable: false,
          },
        };
      }
      if (generation !== cachedPortGeneration) {
        retiredPorts.add(res.value);
        return res;
      }
      const existing = cachedExpandPorts.get(key);
      if (existing) {
        retiredPorts.add(res.value);
        return { ok: true, value: existing };
      }
      cachedExpandPorts.set(key, res.value);
      return res;
    },
    getCachedRerankPort: async (uri, portOptions) => {
      const config = currentSnapshot().config;
      const llm = resolveModelAdapter(config);
      ensurePortCacheForConfig(config);
      const key = portCacheKey(uri, portOptions);
      const cached = cachedRerankPorts.get(key);
      if (cached) {
        return { ok: true, value: cached };
      }
      const generation = cachedPortGeneration;
      const res = await llm.createRerankPort(uri, portOptions);
      if (!res.ok) {
        return res;
      }
      if (modelsClosed) {
        await res.value.dispose();
        return {
          ok: false,
          error: {
            code: "MODEL_LOAD_FAILED",
            message: "Resident runtime is shutting down",
            retryable: false,
          },
        };
      }
      if (generation !== cachedPortGeneration) {
        retiredPorts.add(res.value);
        return res;
      }
      const existing = cachedRerankPorts.get(key);
      if (existing) {
        retiredPorts.add(res.value);
        return { ok: true, value: existing };
      }
      cachedRerankPorts.set(key, res.value);
      return res;
    },
    getCachedVectorIndex: (modelUri, dimensions) => {
      const config = currentSnapshot().config;
      ensurePortCacheForConfig(config);
      const key = `${modelUri}\u0000${dimensions}`;
      let pending = cachedVectorIndexes.get(key);
      if (!pending) {
        pending = createVectorIndexPort(options.store.getRawDb(), {
          model: modelUri,
          dimensions,
        }).then((res) => {
          if (!res.ok) cachedVectorIndexes.delete(key);
          return res;
        });
        cachedVectorIndexes.set(key, pending);
      }
      return pending;
    },
    getCachedLazyVectorIndex: async (modelUri, embedPort) => {
      const config = currentSnapshot().config;
      ensurePortCacheForConfig(config);
      const db = options.store.getRawDb();
      const storedDimensions = getStoredEmbeddingDimensions(db, modelUri);
      if (storedDimensions !== undefined) {
        const key = `${modelUri}\u0000${storedDimensions}`;
        let pending = cachedVectorIndexes.get(key);
        if (!pending) {
          pending = createVectorIndexPort(db, {
            model: modelUri,
            dimensions: storedDimensions,
          }).then((res) => {
            if (!res.ok) cachedVectorIndexes.delete(key);
            return res;
          });
          cachedVectorIndexes.set(key, pending);
        }
        const res = await pending;
        return res.ok ? res.value : null;
      }
      // Never cache an uninitialized lazy wrapper holding a caller-scoped
      // embedPort (its egress policy is specific to this request).
      return createLazyVectorIndex(db, modelUri, embedPort);
    },
    disposeModels: async (disposeOptions) => {
      modelsClosed = true;
      await disposeAllCachedPorts();
      await Promise.all(
        [...adapters.values()].map((adapter) => adapter.dispose(disposeOptions))
      );
      adapters.clear();
    },
    acquireModelLease: options.acquireModelLease,
    markContentMutation: options.markContentMutation,
    markIndexMutation: options.markIndexMutation,
    invalidateEgressPolicy: options.invalidateEgressPolicy,
    authorizeTraceExport: options.authorizeTraceExport,
    advanceRequestAuthorizationEpoch: (epoch) => {
      const reference = requestSnapshot.getStore()?.egress?.authorizationEpoch;
      if (reference) reference.value = epoch;
    },
    getRequestAuthorizationEpoch: () =>
      requestSnapshot.getStore()?.egress?.authorizationEpoch?.value,
    getEgressContext: () => requestSnapshot.getStore()?.egress,
    getRequestIdentity: () => requestSnapshot.getStore()?.requestIdentity,
    getRequestNamespace: () => requestSnapshot.getStore()?.requestNamespace,
    runWithEgressContext<T>(
      egress: NonNullable<ToolContextSnapshot["egress"]>,
      operation: () => Promise<T>,
      scope?: Omit<RequestScope, "egress">
    ): Promise<T> {
      const config = options.getConfig();
      return requestSnapshot.run(
        {
          config,
          collections: config.collections,
          egress,
          requestIdentity: scope?.requestIdentity,
          requestNamespace: scope?.requestNamespace,
        },
        operation
      );
    },
    runWithSnapshot<T>(operation: () => Promise<T>): Promise<T> {
      const config = options.getConfig();
      const current = requestSnapshot.getStore();
      return requestSnapshot.run(
        {
          config,
          collections: config.collections,
          egress: current?.egress,
          requestIdentity: current?.requestIdentity,
          requestNamespace: current?.requestNamespace,
        },
        operation
      );
    },
  };
}

/** Build the contract-identical MCP tool/resource surface for any transport. */
export function createMcpServerSurface(
  context: ToolContext,
  identity: { name: string; version: string } = {
    name: MCP_SERVER_NAME,
    version: VERSION,
  }
): McpServer {
  // `listChanged: true` is the advertised 2025-11-25 contract pinned by
  // test/fixtures/mcp/legacy-2025-11-25.json (SDK v1 always advertised it).
  const server = new McpServer(identity, {
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: false, listChanged: true },
    },
  });
  registerTools(server, context);
  registerResources(server, context);
  return server;
}
