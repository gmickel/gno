/**
 * Bun.serve() web server for GNO web UI.
 * Uses Bun's fullstack dev server with HTML imports.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import type { ContextHolder } from "./routes/api";

import { getIndexDbPath } from "../app/constants";
import { getConfigPaths, isInitialized, loadConfig } from "../config";
import { SqliteAdapter } from "../store/sqlite/adapter";
import { createServerContext, disposeServerContext } from "./context";
// HTML import - Bun handles bundling TSX/CSS automatically via routes
import homepage from "./public/index.html";
import {
  handleAsk,
  handleCapabilities,
  handleCollections,
  handleCreateCollection,
  handleCreateDoc,
  handleDeactivateDoc,
  handleDeleteCollection,
  handleDoc,
  handleDocs,
  handleHealth,
  handleJob,
  handleModelPull,
  handleModelStatus,
  handlePresets,
  handleQuery,
  handleSearch,
  handleSetPreset,
  handleStatus,
  handleSync,
  handleTags,
  handleUpdateDoc,
} from "./routes/api";
import { forbiddenResponse, isRequestAllowed } from "./security";

export interface ServeOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Config path override */
  configPath?: string;
  /** Index name (from --index flag) */
  index?: string;
}

export interface ServeResult {
  success: boolean;
  error?: string;
}

// Hostname parsing helpers - preserved for future fetch handler use
// function parseHostname(host: string): string { ... }
// function isLoopback(hostname: string): boolean { ... }

/**
 * Get CSP based on environment.
 * Dev mode allows WebSocket connections for HMR.
 */
function getCspHeader(isDev: boolean): string {
  // Local fonts only - no Google Fonts for true offline-first
  const base = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'", // Prevent base tag injection
    "object-src 'none'", // Prevent plugin execution
  ];

  // Dev mode: allow WebSocket for HMR
  if (isDev) {
    base.push("connect-src 'self' ws:");
  } else {
    base.push("connect-src 'self'");
  }

  return base.join("; ");
}

/**
 * Apply security headers to a Response.
 */
function withSecurityHeaders(response: Response, isDev: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", getCspHeader(isDev));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Start the web server.
 * Opens DB once, closes on SIGINT/SIGTERM.
 */
export async function startServer(
  options: ServeOptions = {}
): Promise<ServeResult> {
  const port = options.port ?? 3000;
  const isDev = process.env.NODE_ENV !== "production";

  // Check initialization
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Open database once for server lifetime
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.index);
  // Use actual config path (from options or default) for consistency
  const paths = getConfigPaths();
  const actualConfigPath = options.configPath ?? paths.configFile;
  store.setConfigPath(actualConfigPath);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  // Sync collections and contexts from config to DB (same as CLI initStore)
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

  // Create server context with LLM ports for hybrid search and AI answers
  // Use holder pattern to allow hot-reloading presets
  const ctxHolder: ContextHolder = {
    current: await createServerContext(store, config),
    config, // Keep original config for reloading
  };

  // Shutdown controller for clean lifecycle
  const shutdownController = new AbortController();

  // Graceful shutdown handler
  const shutdown = async () => {
    console.log("\nShutting down...");
    await disposeServerContext(ctxHolder.current);
    await store.close();
    shutdownController.abort();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Start server with try/catch for port-in-use etc.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: "127.0.0.1", // Loopback only - no LAN exposure

      // Enable development mode for HMR and console logging
      development: isDev,

      // Static routes - Bun handles HTML bundling and /_bun/* assets automatically
      routes: {
        // SPA routes - all serve the same React app
        "/": homepage,
        "/search": homepage,
        "/browse": homepage,
        "/doc": homepage,
        "/edit": homepage,
        "/collections": homepage,
        "/ask": homepage,

        // API routes with CSRF protection wrapper
        "/api/health": {
          GET: () => withSecurityHeaders(handleHealth(), isDev),
        },
        "/api/status": {
          GET: async () =>
            withSecurityHeaders(await handleStatus(store), isDev),
        },
        "/api/collections": {
          GET: async () =>
            withSecurityHeaders(await handleCollections(store), isDev),
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleCreateCollection(ctxHolder, store, req),
              isDev
            );
          },
        },
        "/api/sync": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleSync(ctxHolder, store, req),
              isDev
            );
          },
        },
        "/api/docs": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(await handleDocs(store, url), isDev);
          },
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleCreateDoc(ctxHolder, store, req),
              isDev
            );
          },
        },
        "/api/docs/:id/deactivate": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            // Extract id from /api/docs/:id/deactivate
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDeactivateDoc(store, id),
              isDev
            );
          },
        },
        "/api/docs/:id": {
          PUT: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            // Extract id from /api/docs/:id
            const id = decodeURIComponent(url.pathname.split("/").pop() || "");
            return withSecurityHeaders(
              await handleUpdateDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/doc": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(await handleDoc(store, url), isDev);
          },
        },
        "/api/tags": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(await handleTags(store, url), isDev);
          },
        },
        "/api/search": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(await handleSearch(store, req), isDev);
          },
        },
        "/api/query": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleQuery(ctxHolder.current, req),
              isDev
            );
          },
        },
        "/api/ask": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleAsk(ctxHolder.current, req),
              isDev
            );
          },
        },
        "/api/capabilities": {
          GET: () =>
            withSecurityHeaders(handleCapabilities(ctxHolder.current), isDev),
        },
        "/api/presets": {
          GET: () =>
            withSecurityHeaders(handlePresets(ctxHolder.current), isDev),
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleSetPreset(ctxHolder, req),
              isDev
            );
          },
        },
        "/api/models/status": {
          GET: () => withSecurityHeaders(handleModelStatus(), isDev),
        },
        "/api/models/pull": {
          POST: (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(handleModelPull(ctxHolder), isDev);
          },
        },
        "/api/jobs/:id": {
          GET: (req: Request) => {
            const url = new URL(req.url);
            const id = decodeURIComponent(url.pathname.split("/").pop() || "");
            return withSecurityHeaders(handleJob(id), isDev);
          },
        },
        "/api/collections/:name": {
          DELETE: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const name = decodeURIComponent(
              url.pathname.split("/").pop() || ""
            );
            return withSecurityHeaders(
              await handleDeleteCollection(ctxHolder, store, name),
              isDev
            );
          },
        },
      },
    });
  } catch (e) {
    await store.close();
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  console.log(`GNO server running at http://localhost:${server.port}`);
  console.log("Press Ctrl+C to stop");

  // Block until shutdown signal
  await new Promise<void>((resolve) => {
    shutdownController.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });

  await server.stop(true);
  return { success: true };
}
