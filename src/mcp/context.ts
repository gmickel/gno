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
import type { ResidentStatus } from "../serve/status-model";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";
import type { McpToolProfile } from "./tool-profile";

import { MCP_SERVER_NAME, VERSION } from "../app/constants";
import { LlmAdapter } from "../llm/nodeLlamaCpp/adapter";
import { createStandaloneResidentStatus } from "../serve/resident-status";
import { registerResources } from "./resources/index";
import { registerTools } from "./tools/index";

export interface AsyncMutex {
  acquire(): Promise<() => void>;
}

export class Mutex implements AsyncMutex {
  #locked = false;
  readonly #queue: Array<() => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (this.#locked) {
          this.#queue.push(tryAcquire);
          return;
        }
        this.#locked = true;
        resolve(() => this.#release());
      };
      tryAcquire();
    });
  }

  #release(): void {
    this.#locked = false;
    this.#queue.shift()?.();
  }
}

/** Gateway principal that authenticated the current HTTP request. */
export interface RequestPrincipal {
  name: string;
  admin: boolean;
  mayAssertSubject: boolean;
}

/** Conversation context an asserting principal declared for the subject. */
export type RequestSubjectContext = "1to1" | "shared" | "public_only";

/**
 * End user an asserting principal acts for. `hash` is the SHA-256 hex of
 * `id`; request receipts store only the hash.
 */
export interface RequestSubject {
  id: string;
  context?: RequestSubjectContext;
  hash: string;
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
  /** Named gateway principal; absent unless `gateway.principals` is set. */
  principal?: RequestPrincipal;
  /** Subject asserted by a `mayAssertSubject` principal for this request. */
  subject?: RequestSubject;
}

export interface RequestScope {
  egress: NonNullable<ToolContextSnapshot["egress"]>;
  requestIdentity?: string;
  requestNamespace?: string;
  principal?: RequestPrincipal;
  subject?: RequestSubject;
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
  /**
   * Resident only: the config file holds an edit the server could not adopt
   * (a collection it omits is still indexed), so the served config, and the
   * `access` rules in it, are behind the file.
   */
  isConfigEditPending?: () => boolean;
  getModelAdapter?: () => LlmAdapter;
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
  /** Named gateway principal of the current HTTP request, if any. */
  getRequestPrincipal?: () => RequestPrincipal | undefined;
  /** Subject asserted for the current HTTP request, if any. */
  getRequestSubject?: () => RequestSubject | undefined;
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
  let modelsClosed = false;
  const requestSnapshot = new AsyncLocalStorage<ToolContextSnapshot>();
  const currentSnapshot = (): ToolContextSnapshot =>
    requestSnapshot.getStore() ??
    (() => {
      const config = options.getConfig();
      return { config, collections: config.collections };
    })();

  return {
    store: options.store,
    get config() {
      return currentSnapshot().config;
    },
    set config(config: Config) {
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
    getModelAdapter: () => {
      if (modelsClosed) throw new Error("Resident runtime is shutting down");
      const config = currentSnapshot().config;
      const shared = options.getModelAdapter?.(config);
      if (shared) return shared;
      let adapter = adapters.get(config);
      if (!adapter) {
        adapter = new LlmAdapter(config);
        adapters.set(config, adapter);
      }
      return adapter;
    },
    disposeModels: async (disposeOptions) => {
      modelsClosed = true;
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
    getRequestPrincipal: () => requestSnapshot.getStore()?.principal,
    getRequestSubject: () => requestSnapshot.getStore()?.subject,
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
          principal: scope?.principal,
          subject: scope?.subject,
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
          principal: current?.principal,
          subject: current?.subject,
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
