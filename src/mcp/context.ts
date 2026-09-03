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
import type { ModelLease } from "../llm/nodeLlamaCpp/lifecycle";
import type { ResidentStatus } from "../serve/status-model";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";
import type { McpToolProfile } from "./tool-profile";

import { MCP_SERVER_NAME, VERSION } from "../app/constants";
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
}

export interface RequestScope {
  egress: NonNullable<ToolContextSnapshot["egress"]>;
  requestIdentity?: string;
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
  runWithEgressContext?<T>(
    egress: NonNullable<ToolContextSnapshot["egress"]>,
    operation: () => Promise<T>,
    scope?: Omit<RequestScope, "egress">
  ): Promise<T>;
  runWithSnapshot?<T>(operation: () => Promise<T>): Promise<T>;
}

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
