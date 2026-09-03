import type { CollectionSyncResult } from "../../ingestion";
import type { HttpGatewayOverrides } from "../../mcp/http-security";
import type { BackgroundRuntimeResult } from "../../serve/background-runtime";
import type { FindingsPassResult } from "../../serve/findings-pass";
import type { ResidentRuntime } from "../../serve/resident-runtime";

import {
  enforceCollectionEgress,
  EGRESS_DENIED_MESSAGE,
  EgressDeniedError,
} from "../../core/egress-enforcement";
import {
  DEFAULT_HTTP_GATEWAY_PORT,
  isHttpGatewayLoopbackBind,
  resolveHttpGatewayConfig,
} from "../../mcp/http-security";
import { startBackgroundRuntime } from "../../serve/background-runtime";
import { handleResidentStatus, handleStatus } from "../../serve/routes/api";
import { createMcpHttpGateway } from "../../serve/routes/mcp";

export interface DaemonOptions extends HttpGatewayOverrides {
  configPath?: string;
  index?: string;
  offline?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  noSyncOnStart?: boolean;
  signal?: AbortSignal;
}

export type DaemonResult =
  | { success: true }
  | { success: false; error: string };

type DaemonLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

type DaemonDeps = {
  startBackgroundRuntime?: typeof startBackgroundRuntime;
  createMcpHttpGateway?: typeof createMcpHttpGateway;
  serve?: typeof Bun.serve;
  logger?: DaemonLogger;
};

/** Silent when clean: only failures, and non-empty writes when not quiet, reach the log. */
export function logFindingsPassResult(
  result: FindingsPassResult,
  logger: DaemonLogger,
  options: { quiet?: boolean; verbose?: boolean }
): void {
  if (result.outcome === "failed") {
    logger.error(`findings pass failed: ${result.error ?? "unknown error"}`);
    return;
  }
  if (result.outcome === "skipped_lease") {
    if (options.verbose) logger.log(`findings pass skipped: ${result.error}`);
    return;
  }
  const { counts } = result;
  const changed =
    counts.written + counts.reopened + counts.resolved + counts.deleted;
  if (changed === 0 || options.quiet) return;
  logger.log(
    `findings pass: ${counts.written} new, ${counts.reopened} reopened, ${counts.resolved} resolved, ${counts.deleted} expired (${counts.open} open)`
  );
}

function formatCollectionSyncSummary(result: CollectionSyncResult): string {
  return `${result.collection}: ${result.filesAdded} added, ${result.filesUpdated} updated, ${result.filesUnchanged} unchanged, ${result.filesErrored} errors`;
}

export const authorizeDaemonStatus = async (
  runtime: ResidentRuntime,
  gateway: Awaited<ReturnType<typeof createMcpHttpGateway>>,
  request: Request,
  server: Parameters<typeof gateway.route>[1]
): Promise<Response> => {
  const authorization = await gateway.security.authorize(request, server);
  if (!authorization.ok) return authorization.response;
  try {
    enforceCollectionEgress({
      collections: runtime.config.collections,
      action: "serve",
      destinationZone: authorization.value.peerClassification.zone,
      caller: {
        authenticated: authorization.value.authenticated,
        operationAuthorized: true,
      },
      contentClass: "metadata",
    });
    return handleResidentStatus(() => runtime.getStatus());
  } catch (error) {
    if (!(error instanceof EgressDeniedError)) throw error;
    return Response.json(
      {
        error: "EGRESS_DENIED",
        message: EGRESS_DENIED_MESSAGE,
        reason: error.decision.reason,
        audit: error.decision.audit,
      },
      { status: 403 }
    );
  }
};

export function handleDaemonAppStatus(
  runtime: ResidentRuntime,
  host: string
): Promise<Response> | Response {
  if (!isHttpGatewayLoopbackBind(host)) {
    return new Response(null, { status: 404 });
  }
  return handleStatus(runtime.ctxHolder.current, {
    getResidentStatus: () => runtime.getStatus(),
  });
}

function createSignalPromise(
  signal: AbortSignal | undefined,
  logger: DaemonLogger,
  quiet: boolean
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const complete = (message?: string): void => {
      signal?.removeEventListener("abort", onAbort);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (message && !quiet) {
        logger.log(message);
      }
      resolve();
    };

    const onAbort = (): void => complete("Daemon stopped.");
    const onSigint = (): void => complete("Received SIGINT. Shutting down...");
    const onSigterm = (): void =>
      complete("Received SIGTERM. Shutting down...");

    signal?.addEventListener("abort", onAbort, { once: true });
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

export async function daemon(
  options: DaemonOptions = {},
  deps: DaemonDeps = {}
): Promise<DaemonResult> {
  const logger = deps.logger ?? {
    log: (message: string) => {
      console.log(message);
    },
    error: (message: string) => {
      console.error(message);
    },
  };

  const runtimeResult: BackgroundRuntimeResult = await (
    deps.startBackgroundRuntime ?? startBackgroundRuntime
  )({
    mode: "daemon",
    configPath: options.configPath,
    index: options.index,
    requireCollections: true,
    offline: options.offline,
    onFindingsResult: (result) =>
      logFindingsPassResult(result, logger, {
        quiet: options.quiet,
        verbose: options.verbose,
      }),
    watchCallbacks: {
      onSyncStart: ({ collection, relPaths }) => {
        if (!options.quiet) {
          logger.log(
            `watch sync started: ${collection} (${relPaths.length} path${relPaths.length === 1 ? "" : "s"})`
          );
        }
      },
      onSyncComplete: ({ result }) => {
        if (!options.quiet) {
          logger.log(formatCollectionSyncSummary(result));
        }
      },
      onSyncError: ({ collection, error }) => {
        logger.error(
          `watch sync failed: ${collection}: ${error instanceof Error ? error.message : String(error)}`
        );
      },
    },
  });
  if (!runtimeResult.success) {
    return { success: false, error: runtimeResult.error };
  }

  const { runtime } = runtimeResult;
  const gatewayConfig = resolveHttpGatewayConfig(runtime.config.gateway, {
    host: options.host,
    port: options.port ?? DEFAULT_HTTP_GATEWAY_PORT,
    tokenFile: options.tokenFile,
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    enableWrite: options.enableWrite,
    toolProfile: options.toolProfile,
  });
  let gateway: Awaited<ReturnType<typeof createMcpHttpGateway>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    gateway = await (deps.createMcpHttpGateway ?? createMcpHttpGateway)(
      runtime as ResidentRuntime,
      gatewayConfig
    );
    server = (deps.serve ?? Bun.serve)({
      port: gatewayConfig.port,
      hostname: gatewayConfig.host,
      development: false,
      routes: {
        "/mcp": gateway.route,
        "/api/status": {
          GET: () =>
            handleDaemonAppStatus(
              runtime as ResidentRuntime,
              gatewayConfig.host
            ),
        },
        "/api/resident/status": {
          GET: (request, peerServer) =>
            authorizeDaemonStatus(
              runtime as ResidentRuntime,
              gateway as Awaited<ReturnType<typeof createMcpHttpGateway>>,
              request,
              peerServer
            ),
        },
      },
    });
    (runtime as Partial<ResidentRuntime>).setListenerPort?.(
      server.port ?? gatewayConfig.port
    );
    if (!options.quiet) {
      logger.log(
        `GNO daemon started for index "${options.index ?? "default"}" using ${runtime.config.collections.length} collection${runtime.config.collections.length === 1 ? "" : "s"}.`
      );
      logger.log(
        `MCP gateway listening at http://${gatewayConfig.host}:${server.port}/mcp`
      );
      const watchState = runtime.watchService.getState();
      if (watchState.activeCollections.length > 0) {
        logger.log(`watching: ${watchState.activeCollections.join(", ")}`);
      }
      if (watchState.failedCollections.length > 0) {
        for (const failed of watchState.failedCollections) {
          logger.error(`watch failed: ${failed.collection}: ${failed.reason}`);
        }
      }
      const findings = (runtime as Partial<ResidentRuntime>).findingsScheduler;
      if (findings) {
        logger.log(
          `findings pass: every ${findings.state.cadence} into "${findings.state.collection}" (report-only)`
        );
      }
    }

    if (!options.noSyncOnStart) {
      if (!options.quiet) {
        logger.log("Running initial sync...");
      }
      const { syncResult, embedResult } = await runtime.syncAll({
        runUpdateCmd: true,
        triggerEmbed: true,
      });
      if (!options.quiet) {
        logger.log(
          `sync totals: ${syncResult.totalFilesAdded} added, ${syncResult.totalFilesUpdated} updated, ${syncResult.totalFilesErrored} errors, ${syncResult.totalFilesSkipped} skipped`
        );
      }
      if (!options.quiet && embedResult) {
        logger.log(
          `embed: ${embedResult.embedded} embedded, ${embedResult.errors} errors`
        );
      }
    } else if (!options.quiet) {
      logger.log("Skipping initial sync (--no-sync-on-start).");
    }

    await createSignalPromise(options.signal, logger, options.quiet ?? false);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.allSettled([server?.stop(true)]);
    await Promise.allSettled([gateway?.close()]);
    await Promise.allSettled([runtime.dispose()]);
  }
}
