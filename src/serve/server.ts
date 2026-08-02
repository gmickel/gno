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
import {
  createDocAssetRouteHandlers,
  handlePdfjsVendorRequest,
  isPdfjsVendorPath,
} from "./fn112-routes";
// HTML import - Bun handles bundling TSX/CSS automatically via routes
import homepage from "./public/index.html";
import { handleResidentRead } from "./resident-request";
import {
  handleActiveJob,
  handleAsk,
  handleBrowseTree,
  handleCapabilities,
  handleClearCollectionEmbeddings,
  handleCollectionEgressCheck,
  handleCollectionEgressPolicy,
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
  handleDocSections,
  handleDocsAutocomplete,
  handleDocs,
  handleDuplicateDoc,
  handleEmbed,
  handleEmbedStatus,
  handleEgressAuditDelete,
  handleEgressAuditList,
  handleEgressAuditPurge,
  handleEgressAuditShow,
  handleEgressAuditStatus,
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
  handleUpdateCollectionEgressPolicy,
  handleUpdateDoc,
  handleVerifyConnector,
} from "./routes/api";
import { handleChanges, handleDiff, handleImpact } from "./routes/changes";
import {
  clipperRoutesForBind,
  createClipperRouteGateway,
} from "./routes/clipper";
import { handleGraph, handleGraphQuery } from "./routes/graph";
import {
  handleDocBacklinks,
  handleDocLinks,
  handleDocSimilar,
} from "./routes/links";
import { createMcpHttpGateway } from "./routes/mcp";
import {
  handleCreateSectionTarget,
  handleResolveSectionTarget,
} from "./routes/section-targets";
import {
  handleTraceDelete,
  handleTraceExport,
  handleTraceLabel,
  handleTraceList,
  handleTracePurge,
  handleTraceShow,
} from "./routes/traces";
import { forbiddenResponse, isRequestAllowed } from "./security";
import {
  createSpaBundleSource,
  type SpaBundleSource,
} from "./spa-bundle-source";

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
  createClipperRouteGateway?: typeof createClipperRouteGateway;
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
/** Exported for security tests (CSP contract). */
export function getCspHeader(isDev: boolean): string {
  // Local fonts only - no Google Fonts for true offline-first
  const base = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "worker-src 'self'", // explicit for PDF.js module worker (fn-112)
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
 * Exported for unit tests that assert the envelope on specific responses.
 *
 * Mutates headers on the original Response when possible. Re-wrapping via
 * `new Response(response.body, …)` breaks Bun.file().slice() range bodies
 * (the stream re-reads the full file), which would corrupt HTTP 206 slices.
 */
export function withSecurityHeaders(
  response: Response,
  isDev: boolean
): Response {
  const apply = (headers: Headers): void => {
    headers.set("Content-Security-Policy", getCspHeader(isDev));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
  };

  try {
    apply(response.headers);
    return response;
  } catch {
    // Headers locked — fall back to a new envelope. Prefer cloning via
    // arrayBuffer only when body is already consumed is not possible here
    // (sync API); empty-body responses (HEAD/416) are the common case.
    const headers = new Headers(response.headers);
    apply(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Build a loopback origin with correct IPv6 authority formatting. */
export function loopbackHttpOrigin(host: string, port: number): string {
  const normalizedHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const authority = normalizedHost.includes(":")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `http://${authority}:${port}`;
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
  const hasSqliteClipperStore =
    typeof Reflect.get(store, "getRawDb") === "function";
  const clipperGateway = hasSqliteClipperStore
    ? (dependencies.createClipperRouteGateway ?? createClipperRouteGateway)(
        ctxHolder,
        store,
        {
          host: gatewayConfig.host,
          port: gatewayConfig.port,
        }
      )
    : { routes: {} };

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
  // Bun HTMLBundle route values cannot carry custom headers. In production,
  // host it on a private Unix socket (ephemeral loopback on Windows), then
  // proxy bytes through this public listener's security envelope. Injected
  // server tests keep an in-listener bundle route because their fake Bun
  // server cannot host the private source.
  let spaBundleSource: SpaBundleSource | null = null;
  const usesInjectedServer = dependencies.serve !== undefined;
  try {
    if (!usesInjectedServer) {
      spaBundleSource = createSpaBundleSource(homepage, isDev);
    }
  } catch (error) {
    removeShutdownHandlers();
    await Promise.allSettled([gateway.close()]);
    await Promise.allSettled([runtime.dispose()]);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const spaInternalPath =
    spaBundleSource?.entryPath ??
    `/__gno_spa_${crypto.randomUUID().replaceAll("-", "")}`;
  let spaHtmlCache: {
    body: ArrayBuffer;
    contentType: string;
    etag: string | null;
  } | null = null;

  const serveSpaHtml = async (): Promise<Response> => {
    if (!isDev && spaHtmlCache) {
      const headers = new Headers({
        "Content-Type": spaHtmlCache.contentType,
      });
      if (spaHtmlCache.etag) {
        headers.set("ETag", spaHtmlCache.etag);
      }
      return withSecurityHeaders(
        new Response(spaHtmlCache.body.slice(0), { headers }),
        isDev
      );
    }
    const boundPort = server.port ?? port;
    const internalRequest = new Request(
      `${loopbackHttpOrigin(gatewayConfig.host, boundPort)}${spaInternalPath}`
    );
    const raw = spaBundleSource
      ? await spaBundleSource.fetch(internalRequest)
      : await fetch(internalRequest);
    if (!raw.ok) {
      return withSecurityHeaders(
        new Response("SPA unavailable", { status: 503 }),
        isDev
      );
    }
    if (!isDev) {
      spaHtmlCache = {
        body: await raw.arrayBuffer(),
        contentType:
          raw.headers.get("content-type") ?? "text/html;charset=utf-8",
        etag: raw.headers.get("etag"),
      };
      const headers = new Headers({
        "Content-Type": spaHtmlCache.contentType,
      });
      if (spaHtmlCache.etag) {
        headers.set("ETag", spaHtmlCache.etag);
      }
      return withSecurityHeaders(
        new Response(spaHtmlCache.body.slice(0), { headers }),
        isDev
      );
    }
    return withSecurityHeaders(raw, isDev);
  };

  const spaPageRoute = {
    GET: serveSpaHtml,
  };

  try {
    server = (dependencies.serve ?? Bun.serve)({
      port,
      hostname: gatewayConfig.host,

      // Enable development mode for HMR and console logging
      development: isDev,

      // Static routes - Bun handles HTML bundling and /_bun/* assets automatically
      routes: {
        "/mcp": gateway.route,
        ...clipperRoutesForBind(
          isHttpGatewayLoopbackBind(gatewayConfig.host),
          clipperGateway
        ),
        // Injected-server tests only. Real runs keep the raw HTMLBundle off the
        // public listener in createSpaBundleSource above.
        ...(spaBundleSource ? {} : { [spaInternalPath]: homepage }),
        // SPA routes - same React app, security envelope on every document
        "/": spaPageRoute,
        "/search": spaPageRoute,
        "/browse": spaPageRoute,
        "/doc": spaPageRoute,
        "/edit": spaPageRoute,
        "/collections": spaPageRoute,
        "/connectors": spaPageRoute,
        "/traces": spaPageRoute,
        "/ask": spaPageRoute,
        "/graph": spaPageRoute,
        "/clipper/pair": spaPageRoute,

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
                handleTraceExport(store, req, ctxHolder.config.collections)
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
        "/api/egress/check": {
          POST: async (req: Request) =>
            withSecurityHeaders(
              await handleCollectionEgressCheck(ctxHolder, req),
              isDev
            ),
        },
        "/api/egress/audits/status": {
          GET: async () =>
            withSecurityHeaders(await handleEgressAuditStatus(store), isDev),
        },
        "/api/egress/audits": {
          GET: async (req: Request) =>
            withSecurityHeaders(await handleEgressAuditList(store, req), isDev),
          DELETE: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            return withSecurityHeaders(
              await handleEgressAuditPurge(store),
              isDev
            );
          },
        },
        "/api/egress/audits/:auditId": {
          GET: async (req: Request) => {
            const auditId = decodeURIComponent(
              new URL(req.url).pathname.split("/").at(-1) ?? ""
            );
            return withSecurityHeaders(
              await handleEgressAuditShow(store, auditId),
              isDev
            );
          },
          DELETE: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const auditId = decodeURIComponent(
              new URL(req.url).pathname.split("/").at(-1) ?? ""
            );
            return withSecurityHeaders(
              await handleEgressAuditDelete(store, auditId),
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
        // fn-112: production factories shared with route-level tests (I1-04)
        "/api/doc-asset": createDocAssetRouteHandlers({
          store,
          getConfig: () => ctxHolder.config,
          runtime: runtime as ResidentRuntime,
          isDev,
          withSecurityHeaders,
        }),
        // Vendor assets are NOT mounted as valid-only patterns here.
        // ALL /vendor/pdfjs/* traffic is handled by handlePdfjsVendorRequest
        // in the fetch fallback below (same production dispatcher tests use).
        "/api/events": {
          GET: (req: Request) => {
            const residentRuntime = runtime as ResidentRuntime;
            const admitted = residentRuntime.admitRequest(req.signal);
            if (!admitted || !residentRuntime.eventBus) {
              admitted?.finish();
              return withSecurityHeaders(
                Response.json(
                  {
                    error: {
                      code: "UNAVAILABLE",
                      message: "Document event stream unavailable",
                    },
                  },
                  { status: 503 }
                ),
                isDev
              );
            }
            try {
              return withSecurityHeaders(
                residentRuntime.eventBus.createResponse({
                  authorizationEpoch:
                    admitted.authorizationEpoch ??
                    residentRuntime.authorizationEpoch,
                  isAuthorizationEpochCurrent: () =>
                    admitted.isAuthorizationEpochCurrent?.() ?? true,
                  onClose: () => admitted.finish(),
                  signal: admitted.signal,
                }),
                isDev
              );
            } catch (error) {
              admitted.finish();
              throw error;
            }
          },
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
        "/api/collections/:name/egress-policy": {
          GET: (req: Request) => {
            const parts = new URL(req.url).pathname.split("/");
            const name = decodeURIComponent(parts.at(-2) ?? "");
            return withSecurityHeaders(
              handleCollectionEgressPolicy(ctxHolder, name),
              isDev
            );
          },
          PUT: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const parts = new URL(req.url).pathname.split("/");
            const name = decodeURIComponent(parts.at(-2) ?? "");
            return withSecurityHeaders(
              await handleUpdateCollectionEgressPolicy(
                ctxHolder,
                store,
                name,
                req
              ),
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
        "/api/doc/:id/section-targets": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const parts = new URL(req.url).pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleCreateSectionTarget(store, id, req)
              ),
              isDev
            );
          },
        },
        "/api/doc/:id/section-targets/resolve": {
          POST: async (req: Request) => {
            if (!isRequestAllowed(req, port)) {
              return withSecurityHeaders(forbiddenResponse(), isDev);
            }
            const parts = new URL(req.url).pathname.split("/");
            const id = decodeURIComponent(parts[3] || "");
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleResolveSectionTarget(store, id, req)
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
        "/api/changes": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleChanges(store, url)
              ),
              isDev
            );
          },
        },
        "/api/diff": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleDiff(store, url)
              ),
              isDev
            );
          },
        },
        "/api/impact": {
          GET: async (req: Request) => {
            const url = new URL(req.url);
            return withSecurityHeaders(
              await handleResidentRead(runtime as ResidentRuntime, req, () =>
                handleImpact(store, url)
              ),
              isDev
            );
          },
        },
      },
      // Production vendor dispatcher for the entire /vendor/pdfjs prefix.
      // Covers valid worker/cMap/font AND malformed/unknown/POST — same function
      // that tests invoke (no test-only fallback path).
      fetch: async (req: Request): Promise<Response> => {
        const pathname = new URL(req.url).pathname;
        if (isPdfjsVendorPath(pathname)) {
          return handlePdfjsVendorRequest(req, {
            isDev,
            withSecurityHeaders,
          });
        }
        if (
          spaBundleSource &&
          (req.method === "GET" || req.method === "HEAD")
        ) {
          const asset = await spaBundleSource.fetch(req);
          if (asset.status !== 404) {
            return withSecurityHeaders(asset, isDev);
          }
        }
        return withSecurityHeaders(
          new Response("Not Found", { status: 404 }),
          isDev
        );
      },
    });
  } catch (e) {
    removeShutdownHandlers();
    if (spaBundleSource) {
      await Promise.allSettled([spaBundleSource.close()]);
    }
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
    if (spaBundleSource) {
      await Promise.allSettled([spaBundleSource.close()]);
    }
    await Promise.allSettled([gateway.close()]);
    await Promise.allSettled([runtime.dispose()]);
  }
  return { success: true };
}
