import type {
  AdapterPreparation,
  AgentAdapter,
  AgentAdapterFactory,
} from "../adapter";
import type { AgentTask } from "../types";

import {
  CANONICAL_AGENT_TOOLS,
  AgenticHarnessError,
  AgenticProductError,
  measuredTiming,
  unavailableTiming,
} from "../adapter";
import {
  cleanupGnoMcpHandle,
  GNO_MCP_ADAPTER_ID,
  gnoMcpConfigFingerprint,
  prepareGnoMcpHandle,
  startRealGnoMcpConnection,
  validateGnoProductTools,
  type GnoMcpConnection,
  type GnoMcpConnectionFactory,
  type GnoMcpPreparedHandle,
  type PrepareGnoMcpOptions,
} from "../lifecycle/gno-mcp";
import { normalizeGnoMcpResult } from "./gno-mcp-normalize";

const PRODUCT_TOOL_NAMES = {
  search: "gno_query",
  get: "gno_get",
  multi_get: "gno_multi_get",
} as const;

type CanonicalToolName = keyof typeof PRODUCT_TOOL_NAMES;

const FILTER_KEYS = new Set([
  "since",
  "until",
  "author",
  "categories",
  "tagsAll",
  "tagsAny",
]);

const mergeSearchFilters = (
  arguments_: Record<string, unknown>
): Record<string, unknown> => {
  const mapped = { ...arguments_ };
  const filters = mapped.filters;
  delete mapped.filters;
  if (filters === undefined) return mapped;
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new AgenticProductError(
      "gno_filter_unsupported",
      "GNO search filters must be an object"
    );
  }
  for (const [key, value] of Object.entries(filters)) {
    if (!FILTER_KEYS.has(key) || key in mapped) {
      throw new AgenticProductError(
        "gno_filter_unsupported",
        `GNO MCP cannot map canonical filter ${key}`
      );
    }
    mapped[key] = value;
  }
  return mapped;
};

const taskUris = (
  task: Readonly<AgentTask>,
  handle: GnoMcpPreparedHandle
): Set<string> =>
  new Set(
    handle.snapshot.files
      .filter((file) => file.taskId === task.taskId)
      .map((file) => `gno://${file.collection}/${file.relPath}`)
  );

const stableTaskRef = (ref: string): string =>
  ref.replace(/\?index=agentic$/, "");

const scopeCanonicalCall = (
  task: Readonly<AgentTask>,
  handle: GnoMcpPreparedHandle,
  toolName: string,
  arguments_: Record<string, unknown>
): Record<string, unknown> => {
  const scoped = { ...arguments_ };
  if (toolName === "search") {
    if (typeof scoped.collection === "string") {
      if (!task.corpus.collections.includes(scoped.collection)) {
        throw new AgenticProductError(
          "gno_corpus_scope_violation",
          "GNO search requested a collection outside the visible task corpus"
        );
      }
    } else if (task.corpus.collections.length === 1) {
      scoped.collection = task.corpus.collections[0];
    } else {
      throw new AgenticProductError(
        "gno_collection_scope_required",
        "GNO search must select one collection for a multi-collection task"
      );
    }
    return scoped;
  }
  const allowed = taskUris(task, handle);
  const refs =
    toolName === "get"
      ? [scoped.uri]
      : Array.isArray(scoped.uris)
        ? scoped.uris
        : [];
  if (
    refs.length === 0 ||
    refs.some(
      (ref) => typeof ref !== "string" || !allowed.has(stableTaskRef(ref))
    )
  ) {
    throw new AgenticProductError(
      "gno_corpus_scope_violation",
      "GNO read requested a source outside the visible task corpus"
    );
  }
  return scoped;
};

export const mapCanonicalGnoMcpCall = (
  toolName: string,
  arguments_: Record<string, unknown>
): { name: string; arguments: Record<string, unknown> } => {
  if (!(toolName in PRODUCT_TOOL_NAMES)) {
    throw new AgenticProductError(
      "gno_tool_unsupported",
      `Unsupported normalized GNO tool: ${toolName}`
    );
  }
  if (toolName === "search") {
    return {
      name: PRODUCT_TOOL_NAMES.search,
      arguments: mergeSearchFilters(arguments_),
    };
  }
  if (toolName === "get") {
    const { uri, ...rest } = arguments_;
    return {
      name: PRODUCT_TOOL_NAMES.get,
      arguments: { ref: uri, ...rest, lineNumbers: false },
    };
  }
  const { uris, ...rest } = arguments_;
  return {
    name: PRODUCT_TOOL_NAMES.multi_get,
    arguments: { refs: uris, ...rest, lineNumbers: false },
  };
};

const assertPreparedHandle = (
  preparation: AdapterPreparation
): GnoMcpPreparedHandle => {
  const handle = preparation.handle as Partial<GnoMcpPreparedHandle> | null;
  if (
    !handle ||
    typeof handle !== "object" ||
    !handle.snapshot ||
    !handle.native ||
    !handle.configPath ||
    !handle.productToolsFingerprint
  ) {
    throw new AgenticHarnessError(
      "gno_prepared_handle_invalid",
      "GNO MCP prepared handle differs from its contract"
    );
  }
  return handle as GnoMcpPreparedHandle;
};

export interface GnoMcpAdapterOptions extends PrepareGnoMcpOptions {
  connectionFactory?: GnoMcpConnectionFactory;
  prepareHandle?: typeof prepareGnoMcpHandle;
  cleanupHandle?: typeof cleanupGnoMcpHandle;
  now?: () => number;
}

export class GnoMcpAdapter implements AgentAdapter {
  readonly adapterId = GNO_MCP_ADAPTER_ID;
  readonly configFingerprint = gnoMcpConfigFingerprint();
  readonly capabilities = Object.freeze({
    backendInvocationAccounting: true,
    startupTiming: true,
    modelLoadTiming: false,
    toolTiming: true,
    tools: {
      search: "supported",
      get: "supported",
      multi_get: "supported",
    },
    exactLineSpans: "supported",
    measuredTokens: "unavailable",
    backendHashes: "unavailable",
    lifecycle: { cold: "supported", warm: "supported" },
  } as const);

  private readonly connectionFactory: GnoMcpConnectionFactory;
  private readonly prepareHandle: typeof prepareGnoMcpHandle;
  private readonly cleanupHandle: typeof cleanupGnoMcpHandle;
  private readonly now: () => number;
  private handle: GnoMcpPreparedHandle | null = null;
  private connection: GnoMcpConnection | null = null;
  private currentTask: Readonly<AgentTask> | null = null;
  private ownsHandle = false;

  constructor(private readonly options: GnoMcpAdapterOptions = {}) {
    this.connectionFactory =
      options.connectionFactory ?? startRealGnoMcpConnection;
    this.prepareHandle = options.prepareHandle ?? prepareGnoMcpHandle;
    this.cleanupHandle = options.cleanupHandle ?? cleanupGnoMcpHandle;
    this.now = options.now ?? (() => performance.now());
  }

  async prepare(
    context: Parameters<AgentAdapter["prepare"]>[0]
  ): Promise<AdapterPreparation> {
    if (context.prepared) {
      this.handle = assertPreparedHandle(context.prepared);
      return {
        ...context.prepared,
        handle: this.handle,
      };
    }
    const started = this.now();
    const handle = await this.prepareHandle(context.snapshot, {
      modelDir: this.options.modelDir,
      connectionFactory: this.connectionFactory,
      embed: this.options.embed,
      signal: context.signal,
    });
    if (context.signal.aborted) {
      await this.cleanupHandle(handle);
      throw context.signal.reason;
    }
    this.handle = handle;
    this.ownsHandle = true;
    return {
      adapterId: this.adapterId,
      corpusFingerprint: context.snapshot.fingerprint,
      indexFingerprint: this.handle.native.indexFingerprint,
      preparation: measuredTiming(this.now() - started),
      observations: {
        documents: this.handle.native.documentCount,
        collections: this.handle.native.collectionCount,
        filesProcessed: this.handle.native.observations.filesProcessed,
        filesErrored: this.handle.native.observations.filesErrored,
        productToolsFingerprint: this.handle.productToolsFingerprint,
        embedded: this.options.embed !== false,
      },
      tempPaths: [this.handle.native.rootPath],
      handle: this.handle,
    };
  }

  listTools() {
    return Promise.resolve(structuredClone(CANONICAL_AGENT_TOOLS));
  }

  async reset(context: Parameters<AgentAdapter["reset"]>[0]) {
    const handle = this.requireHandle();
    this.currentTask = context.task;
    let startup = unavailableTiming("GNO MCP process already resident");
    const diagnostics: string[] = [];
    if (!this.connection) {
      const started = this.now();
      this.connection = await this.connectionFactory(handle, context.signal);
      startup = measuredTiming(this.now() - started);
      if (this.connection.serverName !== "gno") {
        throw new AgenticHarnessError(
          "gno_mcp_server_identity_mismatch",
          `Expected GNO MCP server, received ${this.connection.serverName ?? "unknown"}`
        );
      }
      const productToolsFingerprint = validateGnoProductTools(
        await this.connection.listTools(context.signal)
      );
      if (productToolsFingerprint !== handle.productToolsFingerprint) {
        throw new AgenticHarnessError(
          "gno_mcp_tool_contract_drift",
          "Scored GNO MCP process differs from the prepared product tool contract"
        );
      }
      diagnostics.push(
        `GNO MCP ${this.connection.serverVersion ?? "unknown"} pid=${this.connection.pid ?? "unavailable"}`
      );
    }
    if (context.readinessProbe) {
      const response = await this.connection.callTool(
        PRODUCT_TOOL_NAMES.search,
        {
          query: context.task.brief.goal,
          collection: context.task.corpus.collections[0],
          limit: 1,
          fast: true,
          graph: false,
        },
        context.signal
      );
      const structured = response.structuredContent as
        | { meta?: { vectorsUsed?: unknown } }
        | undefined;
      if (response.isError === true || structured?.meta?.vectorsUsed !== true) {
        throw new AgenticHarnessError(
          "gno_mcp_readiness_failed",
          "Warm GNO readiness probe did not prove hybrid vector availability"
        );
      }
      diagnostics.push("Discarded readiness probe proved vectorsUsed=true");
    }
    return {
      startup,
      modelLoad: unavailableTiming(
        "GNO MCP does not expose model-load timing separately from tool latency"
      ),
      diagnostics,
    };
  }

  async callTool(
    toolName: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal
  ) {
    const connection = this.requireConnection();
    const task = this.requireTask();
    const started = this.now();
    const scopedArguments = scopeCanonicalCall(
      task,
      this.requireHandle(),
      toolName,
      arguments_
    );
    const mapped = mapCanonicalGnoMcpCall(toolName, scopedArguments);
    const response = await connection.callTool(
      mapped.name,
      mapped.arguments,
      signal
    );
    const normalized = normalizeGnoMcpResult(
      toolName as CanonicalToolName,
      response,
      this.requireHandle().snapshot,
      task
    );
    return {
      ...normalized,
      timing: measuredTiming(this.now() - started),
    };
  }

  async dispose(): Promise<void> {
    const connection = this.connection;
    const handle = this.ownsHandle ? this.handle : null;
    this.connection = null;
    this.handle = null;
    this.ownsHandle = false;
    let closeFailure: unknown;
    try {
      await connection?.close();
    } catch (error) {
      closeFailure = error;
    }
    try {
      if (handle) await this.cleanupHandle(handle);
    } catch (cleanupFailure) {
      if (closeFailure) {
        throw new AggregateError(
          [closeFailure, cleanupFailure],
          "GNO MCP connection close and fixture cleanup both failed"
        );
      }
      throw cleanupFailure;
    }
    if (closeFailure) throw closeFailure;
  }

  private requireHandle(): GnoMcpPreparedHandle {
    if (!this.handle) {
      throw new AgenticHarnessError(
        "gno_not_prepared",
        "GNO MCP adapter is not prepared"
      );
    }
    return this.handle;
  }

  private requireConnection(): GnoMcpConnection {
    if (!this.connection) {
      throw new AgenticHarnessError(
        "gno_not_started",
        "GNO MCP process is not started"
      );
    }
    return this.connection;
  }

  private requireTask(): Readonly<AgentTask> {
    if (!this.currentTask) {
      throw new AgenticHarnessError(
        "gno_task_not_set",
        "GNO MCP task is not set"
      );
    }
    return this.currentTask;
  }
}

export const createGnoMcpAdapterFactory =
  (options: GnoMcpAdapterOptions = {}): AgentAdapterFactory =>
  () =>
    new GnoMcpAdapter(options);
