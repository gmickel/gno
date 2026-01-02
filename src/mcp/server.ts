/**
 * MCP Server implementation for GNO.
 * Exposes search, retrieval, and status tools over stdio transport.
 *
 * @module src/mcp/server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// node:path for join/dirname (no Bun path utils)
import { dirname, join } from "node:path";

import type { Collection, Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { MCP_SERVER_NAME, VERSION, getIndexDbPath } from "../app/constants";
import { JobManager } from "../core/job-manager";
import { envIsSet } from "../llm/policy";

// ─────────────────────────────────────────────────────────────────────────────
// Simple Promise Mutex (avoids async-mutex dependency)
// ─────────────────────────────────────────────────────────────────────────────

class Mutex {
  #locked = false;
  readonly #queue: Array<() => void> = [];

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.#locked) {
          this.#queue.push(tryAcquire);
        } else {
          this.#locked = true;
          resolve(() => this.#release());
        }
      };
      tryAcquire();
    });
  }

  #release(): void {
    this.#locked = false;
    const next = this.#queue.shift();
    if (next) {
      next();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Context
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  store: SqliteAdapter;
  config: Config;
  collections: Collection[];
  actualConfigPath: string;
  toolMutex: Mutex;
  jobManager: JobManager;
  serverInstanceId: string;
  writeLockPath: string;
  enableWrite: boolean;
  isShuttingDown: () => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Options
// ─────────────────────────────────────────────────────────────────────────────

export interface McpServerOptions {
  indexName?: string;
  configPath?: string;
  verbose?: boolean;
  enableWrite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  // ========================================
  // STDOUT PURITY GUARD (CRITICAL)
  // ========================================
  // Wrap stdout to catch accidental writes during init
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let protocolMode = false;

  // Stdout wrapper - redirect to stderr during init
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded write signature
  (process.stdout as any).write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    if (!protocolMode) {
      // During init, redirect to stderr
      if (typeof encodingOrCb === "function") {
        return process.stderr.write(chunk, encodingOrCb);
      }
      return process.stderr.write(chunk, encodingOrCb, cb);
    }
    // After transport connected, allow JSON-RPC only
    if (typeof encodingOrCb === "function") {
      return originalStdoutWrite(chunk, encodingOrCb);
    }
    return originalStdoutWrite(chunk, encodingOrCb, cb);
  };

  // Lazy import to avoid pulling in all deps on --help
  const { initStore } = await import("../cli/commands/shared.js");

  // Open DB once with index/config threading
  const init = await initStore({
    indexName: options.indexName,
    configPath: options.configPath,
  });

  if (!init.ok) {
    console.error("Failed to initialize:", init.error);
    process.exit(1);
  }

  const { store, config, collections, actualConfigPath } = init;

  // Create MCP server
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
    }
  );

  // Sequential execution mutex
  const toolMutex = new Mutex();

  // Server instance ID (per-process)
  const serverInstanceId = crypto.randomUUID();

  const enableWrite =
    options.enableWrite ?? envIsSet(process.env, "GNO_MCP_ENABLE_WRITE");
  const dbPath = getIndexDbPath(options.indexName);
  const writeLockPath = join(dirname(dbPath), ".mcp-write.lock");
  const jobManager = new JobManager({
    lockPath: writeLockPath,
    serverInstanceId,
    toolMutex,
  });

  // Shutdown state
  let shuttingDown = false;

  // Tool context (passed to all handlers)
  const ctx: ToolContext = {
    store,
    config,
    collections,
    actualConfigPath,
    toolMutex,
    jobManager,
    serverInstanceId,
    writeLockPath,
    enableWrite,
    isShuttingDown: () => shuttingDown,
  };

  // Register tools (T10.2)
  const { registerTools } = await import("./tools/index.js");
  registerTools(server, ctx);

  // Register resources (T10.3)
  const { registerResources } = await import("./resources/index.js");
  registerResources(server, ctx);

  if (options.verbose) {
    console.error(
      `[MCP] Loaded ${ctx.collections.length} collections from ${ctx.actualConfigPath}`
    );
  }

  // ========================================
  // GRACEFUL SHUTDOWN (ordered)
  // ========================================
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.error("[MCP] Shutting down...");

    // 1. Wait for current handler (no timeout - correctness over speed)
    // If we timeout and close DB while tool is running, we risk corruption
    const release = await toolMutex.acquire();
    release();

    // 2. Wait for background jobs before closing DB
    await jobManager.shutdown();

    // 3. Close MCP server/transport (flush buffers, clean disconnect)
    try {
      await server.close();
    } catch {
      // Best-effort - server may already be closed
    }

    // 4. Close DB (safe now - no tool or job is running)
    await store.close();

    // 5. Exit
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ========================================
  // CONSOLE REDIRECT (CRITICAL for stdout purity)
  // ========================================
  // Redirect console.log/info/debug/warn to stderr to prevent JSON-RPC corruption
  // Save originals (prefixed with _ to indicate intentionally unused)
  const _origLog = console.log;
  const _origInfo = console.info;
  const _origDebug = console.debug;
  const _origWarn = console.warn;
  console.log = (...args: unknown[]) => console.error("[log]", ...args);
  console.info = (...args: unknown[]) => console.error("[info]", ...args);
  console.debug = (...args: unknown[]) => console.error("[debug]", ...args);
  console.warn = (...args: unknown[]) => console.error("[warn]", ...args);

  // Connect transport
  const transport = new StdioServerTransport();
  protocolMode = true; // Enable stdout for JSON-RPC

  await server.connect(transport);

  console.error(`[MCP] ${MCP_SERVER_NAME} v${VERSION} ready on stdio`);

  // Block forever until shutdown signal or stdin closes
  // This prevents the CLI from exiting after startMcpServer() returns
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => {
      console.error("[MCP] stdin ended");
      resolve();
    });
    process.stdin.on("close", () => {
      console.error("[MCP] stdin closed");
      resolve();
    });
    // Also resolve on SIGTERM/SIGINT (already handled by shutdown())
  });
}
