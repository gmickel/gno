/**
 * Bun.serve() web server for GNO web UI.
 * Uses Bun's fullstack dev server with HTML imports.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import type { ContextHolder } from "./routes/api";

import { startBackgroundRuntime } from "./background-runtime";
import { DocumentEventBus } from "./doc-events";
// HTML import - Bun handles bundling TSX/CSS automatically via routes
import homepage from "./public/index.html";
import {
  handleActiveJob,
  handleAsk,
  handleBrowseTree,
  handleCapabilities,
  handleClearCollectionEmbeddings,
  handleCollections,
  handleConnectors,
  handleCreateFolder,
  handleCreateCollection,
  handleCreateEditableCopy,
  handleCreateDoc,
  handleDeactivateDoc,
  handleDeleteCollection,
  handleDoc,
  handleDocAsset,
  handleDocSections,
  handleDocsAutocomplete,
  handleDocs,
  handleDuplicateDoc,
  handleEmbed,
  handleEmbedStatus,
  handleHealth,
  handleImportPreview,
  handleInstallConnector,
  handleMoveDoc,
  handleNotePresets,
  handleJob,
  handleModelPull,
  handleModelStatus,
  handlePublishExport,
  handlePresets,
  handleQuery,
  handleRefactorPlan,
  handleRenameDoc,
  handleRevealDoc,
  handleSearch,
  handleSetPreset,
  handleStatus,
  handleSync,
  handleTags,
  handleTrashDoc,
  handleUpdateCollection,
  handleUpdateDoc,
} from "./routes/api";
import { handleGraph } from "./routes/graph";
import {
  handleDocBacklinks,
  handleDocLinks,
  handleDocSimilar,
} from "./routes/links";
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
  const runtimeResult = await startBackgroundRuntime({
    configPath: options.configPath,
    index: options.index,
    requireCollections: false,
    eventBus: new DocumentEventBus(),
  });
  if (!runtimeResult.success) {
    return { success: false, error: runtimeResult.error };
  }
  const runtime = runtimeResult.runtime;
  const store = runtime.store;
  const ctxHolder: ContextHolder = runtime.ctxHolder;

  // Shutdown controller for clean lifecycle
  const shutdownController = new AbortController();

  // Graceful shutdown handler
  const shutdown = () => {
    console.log("\nShutting down...");
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
        "/connectors": homepage,
        "/ask": homepage,
        "/graph": homepage,

        // API routes with CSRF protection wrapper
        "/api/health": {
          GET: () => withSecurityHeaders(handleHealth(), isDev),
        },
        "/api/status": {
          GET: async () =>
            withSecurityHeaders(await handleStatus(ctxHolder.current), isDev),
        },
        "/api/collections": {
          GET: async () =>
            withSecurityHeaders(
              await handleCollections(ctxHolder.config),
              isDev
            ),
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
        "/api/connectors": {
          GET: async () => withSecurityHeaders(await handleConnectors(), isDev),
        },
        "/api/connectors/install": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleInstallConnector(req),
              isDev
            );
          },
        },
        "/api/import/preview": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleImportPreview(ctxHolder, req),
              isDev
            );
          },
        },
        "/api/publish/export": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handlePublishExport(ctxHolder.config, store, req),
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
        "/api/docs/autocomplete": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleDocsAutocomplete(store, url),
              isDev
            );
          },
        },
        "/api/note-presets": {
          GET: async () =>
            withSecurityHeaders(await handleNotePresets(), isDev),
        },
        "/api/folders": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleCreateFolder(ctxHolder, req),
              isDev
            );
          },
        },
        "/api/browse/tree": {
          GET: async () =>
            withSecurityHeaders(await handleBrowseTree(store), isDev),
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
              await handleDeactivateDoc(store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/rename": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleRenameDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/move": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleMoveDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/duplicate": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDuplicateDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/refactor-plan": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleRefactorPlan(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/trash": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleTrashDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/reveal": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleRevealDoc(ctxHolder, store, id, req),
              isDev
            );
          },
        },
        "/api/docs/:id/editable-copy": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleCreateEditableCopy(ctxHolder, store, id, req),
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
            return withSecurityHeaders(
              await handleDoc(store, ctxHolder.config, url),
              isDev
            );
          },
        },
        "/api/doc-asset": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleDocAsset(store, ctxHolder.config, url),
              isDev
            );
          },
        },
        "/api/events": {
          GET: () =>
            withSecurityHeaders(
              runtime.eventBus?.createResponse() ??
                new Response("event stream unavailable", { status: 503 }),
              isDev
            ),
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
        "/api/jobs/active": {
          GET: () => withSecurityHeaders(handleActiveJob(), isDev),
        },
        "/api/jobs/:id": {
          GET: (req: Request) => {
            const url = new URL(req.url);
            const id = decodeURIComponent(url.pathname.split("/").pop() || "");
            return withSecurityHeaders(handleJob(id), isDev);
          },
        },
        "/api/embed": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleEmbed(ctxHolder.scheduler),
              isDev
            );
          },
        },
        "/api/embed/status": {
          GET: () =>
            withSecurityHeaders(handleEmbedStatus(ctxHolder.scheduler), isDev),
        },
        "/api/collections/:name": {
          PATCH: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const name = decodeURIComponent(
              url.pathname.split("/").pop() || ""
            );
            return withSecurityHeaders(
              await handleUpdateCollection(ctxHolder, store, name, req),
              isDev
            );
          },
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
        "/api/collections/:name/embeddings/clear": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const name = decodeURIComponent(parts.at(-3) || "");
            return withSecurityHeaders(
              await handleClearCollectionEmbeddings(
                ctxHolder,
                store,
                name,
                req
              ),
              isDev
            );
          },
        },
        "/api/doc/:id/links": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            // Extract id from /api/doc/:id/links
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDocLinks(store, id, url),
              isDev
            );
          },
        },
        "/api/doc/:id/sections": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDocSections(store, id, req),
              isDev
            );
          },
        },
        "/api/doc/:id/backlinks": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            // Extract id from /api/doc/:id/backlinks
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDocBacklinks(store, id),
              isDev
            );
          },
        },
        "/api/doc/:id/similar": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            // Extract id from /api/doc/:id/similar
            const parts = url.pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleDocSimilar(ctxHolder.current, id, url),
              isDev
            );
          },
        },
        "/api/graph": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(await handleGraph(store, url), isDev);
          },
        },
      },
    });
  } catch (e) {
    await runtime.dispose();
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
  await runtime.dispose();
  return { success: true };
}
