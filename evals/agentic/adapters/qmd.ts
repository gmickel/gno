import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterPreparation,
  AdapterToolCallResult,
} from "../adapter";
import type { QmdPreflightOptions } from "../qmd-preflight";
import type { AgentTask, CorpusSnapshot } from "../types";

import {
  AgenticHarnessError,
  CANONICAL_AGENT_TOOLS,
  measuredTiming,
  unavailableTiming,
} from "../adapter";
import { canonicalFingerprint, canonicalJson, sha256Bytes } from "../canonical";
import {
  validateQmdMcpContract,
  type QmdMcpConnection,
} from "../lifecycle/qmd-mcp";
import {
  defaultQmdNativeServices,
  cloneQmdPreparedRuntime,
  prepareQmdNativeIndex,
  type QmdNativeServices,
  type QmdPreparedHandle,
  type QmdRuntimeClone,
} from "../lifecycle/qmd-native";
import { assertQmdCheckoutStillClean } from "../qmd-preflight";
import { mapQmdToolCall, normalizeQmdToolResult } from "./qmd-normalize";

export const QMD_ADAPTER_ID = "qmd";
const QMD_LOCK_FILE_SHA256 =
  "3e9e06ef272667b3e6ad1d33b536c31d49b96a8e36335fd92e761f52e937c25d";

export const QMD_CAPABILITIES: AdapterCapabilities = Object.freeze({
  backendInvocationAccounting: false,
  startupTiming: true,
  modelLoadTiming: false,
  toolTiming: true,
  tools: {
    search: "supported",
    get: "supported",
    multi_get: "supported",
  } as const,
  exactLineSpans: "supported",
  measuredTokens: "unavailable",
  backendHashes: "unavailable",
  lifecycle: { cold: "supported", warm: "supported" } as const,
});

export interface QmdAdapterOptions extends QmdPreflightOptions {
  services?: QmdNativeServices;
}

const isPreparedHandle = (value: unknown): value is QmdPreparedHandle => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const handle = value as Partial<QmdPreparedHandle>;
  return (
    typeof handle.rootPath === "string" &&
    typeof handle.dbPath === "string" &&
    typeof handle.indexFingerprint === "string" &&
    typeof handle.preflight?.entrypointPath === "string" &&
    !!handle.env
  );
};

export const createQmdAdapterFactory = (
  options: QmdAdapterOptions = {}
): (() => AgentAdapter) => {
  const services = options.services ?? defaultQmdNativeServices;
  return () => {
    let prepared: QmdPreparedHandle | null = null;
    let connection: QmdMcpConnection | null = null;
    let runtime: QmdRuntimeClone | null = null;
    let corpusSnapshot: CorpusSnapshot | null = null;
    let activeTask: Readonly<AgentTask> | null = null;
    let ownsPreparation = false;
    const adapter: AgentAdapter = {
      adapterId: QMD_ADAPTER_ID,
      capabilities: QMD_CAPABILITIES,
      configFingerprint: canonicalFingerprint({
        adapter: QMD_ADAPTER_ID,
        lockFileSha256: QMD_LOCK_FILE_SHA256,
      }),
      async prepare(context): Promise<AdapterPreparation> {
        corpusSnapshot = context.snapshot;
        if (context.prepared) {
          if (!isPreparedHandle(context.prepared.handle)) {
            throw new AgenticHarnessError(
              "qmd_preparation_invalid",
              "Attached qmd preparation handle is invalid"
            );
          }
          prepared = context.prepared.handle;
          runtime = await cloneQmdPreparedRuntime(prepared, context.signal);
        } else {
          prepared = await prepareQmdNativeIndex(
            context.snapshot,
            { ...options, signal: context.signal },
            services
          );
          ownsPreparation = true;
        }
        return {
          adapterId: QMD_ADAPTER_ID,
          corpusFingerprint: context.snapshot.fingerprint,
          indexFingerprint: prepared.indexFingerprint,
          preparation: ownsPreparation
            ? measuredTiming(prepared.preparationMs)
            : unavailableTiming("qmd native index reused"),
          observations: {
            documentCount: prepared.documentCount,
            collectionCount: prepared.collectionCount,
            qmdRepositoryFingerprint: prepared.preflight.repositoryFingerprint,
            qmdLockFingerprint: prepared.preflight.lockFingerprint,
            qmdIndexFileSha256: prepared.indexFileSha256,
            isolationFingerprint: canonicalFingerprint({
              config: prepared.configDir,
              xdgConfig: prepared.xdgConfigHome,
              xdgCache: prepared.xdgCacheHome,
              data: prepared.dataPath,
            }),
          },
          tempPaths: [
            prepared.rootPath,
            prepared.configDir,
            prepared.xdgConfigHome,
            prepared.xdgCacheHome,
            prepared.dataPath,
          ],
          handle: prepared,
        };
      },
      async listTools() {
        return structuredClone(CANONICAL_AGENT_TOOLS);
      },
      async reset(context) {
        if (!prepared)
          throw new AgenticHarnessError(
            "qmd_not_prepared",
            "qmd adapter was not prepared"
          );
        activeTask = context.task;
        let startup = unavailableTiming("warm qmd MCP process already active");
        if (!connection) {
          const started = performance.now();
          connection = await services.connector({
            runtimePath: process.execPath,
            entrypointPath: prepared.preflight.entrypointPath,
            cwd: runtime?.rootPath ?? prepared.rootPath,
            env: runtime?.env ?? prepared.env,
            signal: context.signal,
          });
          await validateQmdMcpContract(
            connection,
            prepared.preflight.lock,
            context.signal
          );
          startup = measuredTiming(performance.now() - started);
          await assertQmdCheckoutStillClean(
            prepared.preflight,
            services.commandRunner,
            context.signal
          );
        }
        if (context.readinessProbe) {
          const query = await connection.callTool(
            "query",
            {
              query: context.task.brief.goal,
              collections: context.task.corpus.collections,
              intent: "gno agentic warm readiness probe",
              rerank: true,
            },
            context.signal
          );
          const readinessResults = query.structuredContent?.results;
          if (
            query.isError ||
            !Array.isArray(readinessResults) ||
            readinessResults.length === 0 ||
            !readinessResults.every((result) => {
              if (!result || typeof result !== "object") return false;
              const file = (result as { file?: unknown }).file;
              if (typeof file !== "string" || !file.startsWith("qmd://"))
                return false;
              const collection = file.slice("qmd://".length).split("/", 1)[0];
              return (
                !!collection &&
                context.task.corpus.collections.includes(collection)
              );
            })
          ) {
            throw new AgenticHarnessError(
              "qmd_readiness_failed",
              "qmd full warm readiness query failed"
            );
          }
          await assertQmdCheckoutStillClean(
            prepared.preflight,
            services.commandRunner,
            context.signal
          );
        }
        return {
          startup,
          modelLoad: unavailableTiming(
            "qmd does not separate model-load timing from first tool execution"
          ),
          diagnostics: context.readinessProbe
            ? ["discarded full qmd query readiness probe"]
            : [],
        };
      },
      async callTool(
        toolName,
        arguments_,
        signal
      ): Promise<AdapterToolCallResult> {
        if (!connection)
          throw new AgenticHarnessError(
            "qmd_not_started",
            "qmd MCP process is not started"
          );
        if (!prepared || !corpusSnapshot || !activeTask) {
          throw new AgenticHarnessError(
            "qmd_task_scope_missing",
            "qmd adapter has no active snapshot task scope"
          );
        }
        const mapped = mapQmdToolCall(
          toolName,
          arguments_,
          corpusSnapshot,
          activeTask
        );
        const started = performance.now();
        const raw = await connection.callTool(
          mapped.name,
          mapped.arguments,
          signal
        );
        await assertQmdCheckoutStillClean(
          prepared.preflight,
          services.commandRunner,
          signal
        );
        const diagnostics: string[] = [];
        const scope = {
          snapshot: corpusSnapshot,
          task: activeTask,
          diagnostics,
        };
        const volatilePaths = [
          prepared.rootPath,
          runtime?.rootPath ?? "",
          prepared.preflight.repoPath,
          prepared.preflight.modelCachePath,
        ];
        const sanitize = (value: string): string => {
          let sanitized = value;
          for (const path of volatilePaths) {
            if (path)
              sanitized = sanitized.split(path).join("<qmd-isolated-path>");
          }
          return sanitized;
        };
        return {
          result: normalizeQmdToolResult(toolName, raw, scope, sanitize),
          backendInvocations: 0,
          timing: measuredTiming(performance.now() - started),
          diagnostics: [
            `qmd request ${mapped.name} ${sha256Bytes(canonicalJson(mapped.arguments))}`,
            "qmd internal backend invocation count unavailable",
            ...diagnostics,
          ],
        };
      },
      async dispose() {
        let failure: unknown = null;
        if (connection) {
          try {
            await connection.close();
          } catch (error) {
            failure = error;
          }
        }
        connection = null;
        if (prepared) {
          try {
            await assertQmdCheckoutStillClean(
              prepared.preflight,
              services.commandRunner
            );
          } catch (error) {
            failure ??= error;
          }
        }
        if (ownsPreparation && prepared) {
          try {
            await services.cleanup(prepared.rootPath);
          } catch (error) {
            failure ??= error;
          }
        }
        if (runtime) {
          try {
            await services.cleanup(runtime.rootPath);
          } catch (error) {
            failure ??= error;
          }
        }
        prepared = null;
        corpusSnapshot = null;
        activeTask = null;
        runtime = null;
        ownsPreparation = false;
        if (failure) throw failure;
      },
    };
    return adapter;
  };
};
