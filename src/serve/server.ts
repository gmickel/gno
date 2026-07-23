/**
 * Bun.serve() web server for GNO web UI.
 * Uses Bun's fullstack dev server with HTML imports.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import type { HttpGatewayOverrides } from "../mcp/http-security";
import type { ResidentRuntime } from "./resident-runtime";
import type { ContextHolder } from "./routes/api";

import {
  isHttpGatewayLoopbackBind,
  resolveHttpGatewayConfig,
} from "../mcp/http-security";
import { startBackgroundRuntime } from "./background-runtime";
import { handleContextBuild, handleContextVerify } from "./context-capsule";
import { DocumentEventBus } from "./doc-events";
// HTML import - Bun handles bundling TSX/CSS automatically via routes
import homepage from "./public/index.html";
import { handleResidentRead } from "./resident-request";
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
  handleCreateCapture,
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
  handleQueryDiagnose,
  handleRefactorPlan,
  handleResidentStatus,
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
  handleVerifyConnector,
} from "./routes/api";
import { handleGraph, handleGraphQuery } from "./routes/graph";
import {
  handleDocBacklinks,
  handleDocLinks,
  handleDocSimilar,
} from "./routes/links";
import { createMcpHttpGateway } from "./routes/mcp";
import {
  handleTraceDelete,
  handleTraceExport,
  handleTraceLabel,
  handleTraceList,
  handleTracePurge,
  handleTraceShow,
} from "./routes/traces";
import { forbiddenResponse, isRequestAllowed } from "./security";

export interface ServeOptions extends HttpGatewayOverrides {
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

interface StartServerDependencies {
  startBackgroundRuntime?: typeof startBackgroundRuntime;
  createMcpHttpGateway?: typeof createMcpHttpGateway;
  serve?: typeof Bun.serve;
  handleInstallConnector?: typeof handleInstallConnector;
  handleDocs?: typeof handleDocs;
  handleVerifyConnector?: typeof handleVerifyConnector;
  handleImportPreview?: typeof handleImportPreview;
  handlePublishExport?: typeof handlePublishExport;
  handleRefactorPlan?: typeof handleRefactorPlan;
  waitForShutdown?: (signal: AbortSignal) => Promise<void>;
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
  options: ServeOptions = {},
  dependencies: StartServerDependencies = {}
): Promise<ServeResult> {
  const port = options.port ?? 3000;
  const isDev = process.env.NODE_ENV !== "production";
  const runtimeResult = await (
    dependencies.startBackgroundRuntime ?? startBackgroundRuntime
  )({
    mode: "serve",
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
  const gatewayConfig = resolveHttpGatewayConfig(runtime.config.gateway, {
    host: options.host,
    port,
    tokenFile: options.tokenFile,
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    enableWrite: options.enableWrite,
  });
  if (!isHttpGatewayLoopbackBind(gatewayConfig.host)) {
    await runtime.dispose();
    return {
      success: false,
      error:
        "gno serve remains loopback-only because Web and REST share its listener; use gno daemon for authenticated non-loopback MCP",
    };
  }
  let gateway: Awaited<ReturnType<typeof createMcpHttpGateway>>;
  try {
    gateway = await (dependencies.createMcpHttpGateway ?? createMcpHttpGateway)(
      runtime as ResidentRuntime,
      gatewayConfig
    );
  } catch (error) {
    await runtime.dispose();
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Shutdown controller for clean lifecycle
  const shutdownController = new AbortController();

  // Graceful shutdown handler
  const shutdown = () => {
    console.log("\nShutting down...");
    shutdownController.abort();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const removeShutdownHandlers = (): void => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };

  // Start server with try/catch for port-in-use etc.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = (dependencies.serve ?? Bun.serve)({
      port,
      hostname: gatewayConfig.host,

      // Enable development mode for HMR and console logging
      development: isDev,

      // Static routes - Bun handles HTML bundling and /_bun/* assets automatically
      routes: {
        "/mcp": gateway.route,
        // SPA routes - all serve the same React app
        "/": homepage,
        "/search": homepage,
        "/browse": homepage,
        "/doc": homepage,
        "/edit": homepage,
        "/collections": homepage,
        "/connectors": homepage,
        "/traces": homepage,
        "/ask": homepage,
        "/graph": homepage,

        // API routes with CSRF protection wrapper
        "/api/health": {
          GET: () => withSecurityHeaders(handleHealth(), isDev),
        },
        "/api/status": {
          GET: async (req: Request) =>
            withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleStatus(ctxHolder.current, {
                  getResidentStatus: () =>
                    (runtime as ResidentRuntime).getStatus(),
                })
              ),
              isDev
            ),
        },
        "/api/traces/export": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTraceExport(store, req)
              ),
              isDev
            );
          },
        },
        "/api/traces/:traceId/judgments": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const traceId = decodeURIComponent(
              new URL(req.url).pathname.split("/")[3] ?? ""
            );
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTraceLabel(store, traceId, req)
              ),
              isDev
            );
          },
        },
        "/api/traces/:traceId": {
          GET: async (req: Request) => {
            const traceId = decodeURIComponent(
              new URL(req.url).pathname.split("/")[3] ?? ""
            );
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTraceShow(store, traceId, req)
              ),
              isDev
            );
          },
          DELETE: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const traceId = decodeURIComponent(
              new URL(req.url).pathname.split("/")[3] ?? ""
            );
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTraceDelete(store, traceId)
              ),
              isDev
            );
          },
        },
        "/api/traces": {
          GET: async (req: Request) =>
            withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTraceList(store, req)
              ),
              isDev
            ),
          DELETE: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTracePurge(store)
              ),
              isDev
            );
          },
        },
        "/api/resident/status": {
          GET: () =>
            withSecurityHeaders(
              handleResidentStatus(() =>
                (runtime as ResidentRuntime).getStatus()
              ),
              isDev
            ),
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
          GET: async (req: Request) =>
            withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleConnectors(ctxHolder.config)
              ),
              isDev
            ),
        },
        "/api/connectors/install": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await (
                dependencies.handleInstallConnector ?? handleInstallConnector
              )(req, {
                indexName: options.index,
                configPath: runtime.actualConfigPath,
              }),
              isDev
            );
          },
        },
        "/api/connectors/verify": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                (dependencies.handleVerifyConnector ?? handleVerifyConnector)(
                  ctxHolder.config,
                  store,
                  req
                )
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                (dependencies.handleImportPreview ?? handleImportPreview)(
                  ctxHolder,
                  req
                )
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                (dependencies.handlePublishExport ?? handlePublishExport)(
                  ctxHolder.config,
                  store,
                  req
                )
              ),
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
        "/api/capture": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleCreateCapture(ctxHolder, store, req),
              isDev
            );
          },
        },
        "/api/docs": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                (dependencies.handleDocs ?? handleDocs)(store, url)
              ),
              isDev
            );
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocsAutocomplete(store, url)
              ),
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
          GET: async (req: Request) =>
            withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleBrowseTree(store)
              ),
              isDev
            ),
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
              await handleDeactivateDoc(ctxHolder, store, id, req),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                (dependencies.handleRefactorPlan ?? handleRefactorPlan)(
                  ctxHolder,
                  store,
                  id,
                  req
                )
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDoc(store, ctxHolder.config, url, req)
              ),
              isDev
            );
          },
        },
        "/api/doc-asset": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocAsset(store, ctxHolder.config, url)
              ),
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
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleTags(store, url)
              ),
              isDev
            );
          },
        },
        "/api/search": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleSearch(ctxHolder.current, req)
              ),
              isDev
            );
          },
        },
        "/api/query": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleQuery(ctxHolder.current, req)
              ),
              isDev
            );
          },
        },
        "/api/context": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleContextBuild(ctxHolder.current, req)
              ),
              isDev
            );
          },
        },
        "/api/context/verify": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleContextVerify(ctxHolder.current, req)
              ),
              isDev
            );
          },
        },
        "/api/query/diagnose": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleQueryDiagnose(ctxHolder.current, req)
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleAsk(ctxHolder.current, req)
              ),
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
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleModelPull(ctxHolder)
              ),
              isDev
            );
          },
        },
        "/api/jobs/active": {
          GET: () =>
            withSecurityHeaders(handleActiveJob(ctxHolder.jobManager), isDev),
        },
        "/api/jobs/:id": {
          GET: (req: Request) => {
            const url = new URL(req.url);
            const id = decodeURIComponent(url.pathname.split("/").pop() || "");
            return withSecurityHeaders(
              handleJob(id, ctxHolder.jobManager),
              isDev
            );
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocLinks(store, id, url)
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocSections(store, id, req)
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocBacklinks(store, id)
              ),
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
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDocSimilar(ctxHolder.current, id, url)
              ),
              isDev
            );
          },
        },
        "/api/graph": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleGraph(store, url)
              ),
              isDev
            );
          },
        },
        "/api/graph/query": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleGraphQuery(store, ctxHolder.config, req)
              ),
              isDev
            );
          },
        },
      },
    });
  } catch (e) {
    removeShutdownHandlers();
    await Promise.allSettled([gateway.close()]);
    await Promise.allSettled([runtime.dispose()]);
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  (runtime as Partial<ResidentRuntime>).setListenerPort?.(server.port ?? port);

  console.log(
    `GNO server running at http://${gatewayConfig.host}:${server.port}`
  );
  console.log("Press Ctrl+C to stop");

  // Block until shutdown signal
  if (dependencies.waitForShutdown) {
    await dependencies.waitForShutdown(shutdownController.signal);
  } else {
    await new Promise<void>((resolve) => {
      shutdownController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  removeShutdownHandlers();
  try {
    await server.stop(true);
  } finally {
    await Promise.allSettled([gateway.close()]);
    await Promise.allSettled([runtime.dispose()]);
  }
  return { success: true };
}
