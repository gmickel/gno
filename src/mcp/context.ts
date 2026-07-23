/** Shared MCP surface and request-scoped runtime context. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// node:async_hooks provides async-local request context; Bun has no separate native equivalent.
import { AsyncLocalStorage } from "node:async_hooks";

import type { Collection, Config } from "../config/types";
import type { JobManager } from "../core/job-manager";
import type { ModelLease } from "../llm/nodeLlamaCpp/lifecycle";
import type { ResidentStatus } from "../serve/status-model";
import type { SqliteAdapter } from "../store/sqlite/adapter";

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
  isShuttingDown: () => boolean;
  getResidentStatus?: () => ResidentStatus;
  acquireModelLease?: () => ModelLease;
  markContentMutation?: () => void;
  markIndexMutation?: () => void;
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
  isShuttingDown: () => boolean;
  getResidentStatus?: () => ResidentStatus;
  acquireModelLease?: () => ModelLease;
  markContentMutation?: () => void;
  markIndexMutation?: () => void;
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
    isShuttingDown: options.isShuttingDown,
    getResidentStatus:
      options.getResidentStatus ??
      (() => createStandaloneResidentStatus("stdio")),
    acquireModelLease: options.acquireModelLease,
    markContentMutation: options.markContentMutation,
    markIndexMutation: options.markIndexMutation,
    runWithSnapshot<T>(operation: () => Promise<T>): Promise<T> {
      const config = options.getConfig();
      return requestSnapshot.run(
        { config, collections: config.collections },
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
  const server = new McpServer(identity, {
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
  });
  registerTools(server, context);
  registerResources(server, context);
  return server;
}
