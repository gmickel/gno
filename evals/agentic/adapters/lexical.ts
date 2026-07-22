import type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterCapabilities,
} from "../adapter";
import type { AgentTask } from "../types";

import {
  AgenticProductError,
  CANONICAL_AGENT_TOOLS,
  measuredTiming,
} from "../adapter";
import { canonicalFingerprint, canonicalJson } from "../canonical";
import { NativeFixtureStoreLifecycle } from "../native-fixture-store";
import {
  assertTaskScopedUris,
  runLexicalRead,
  runLexicalSearch,
  taskScopedSearchOptions,
} from "./lexical-core";

export const LEXICAL_ADAPTER_ID = "lexical" as const;

const LEXICAL_CAPABILITIES = Object.freeze({
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
  backendHashes: "unsupported",
  lifecycle: { cold: "supported", warm: "supported" },
} satisfies AdapterCapabilities);

const LEXICAL_CONFIG = Object.freeze({
  adapter: LEXICAL_ADAPTER_ID,
  version: 1,
  retrieval: "production-searchBm25",
  expansion: false,
  vectors: false,
  reranking: false,
  graph: false,
});

class LexicalAdapter implements AgentAdapter {
  readonly adapterId = LEXICAL_ADAPTER_ID;
  readonly capabilities = LEXICAL_CAPABILITIES;
  readonly configFingerprint = canonicalFingerprint(LEXICAL_CONFIG);
  private readonly native = new NativeFixtureStoreLifecycle(this.adapterId);
  private task: Readonly<AgentTask> | null = null;

  prepare(context: Parameters<AgentAdapter["prepare"]>[0]) {
    return this.native.prepare(context);
  }

  async listTools() {
    return structuredClone(CANONICAL_AGENT_TOOLS);
  }

  async reset(context: Parameters<AgentAdapter["reset"]>[0]) {
    this.task = context.task;
    return this.native.reset(context.signal);
  }

  async callTool(
    toolName: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (signal.aborted) throw signal.reason;
    if (!this.task) {
      throw new AgenticProductError(
        "adapter_not_reset",
        "Lexical adapter has no active task"
      );
    }
    const started = performance.now();
    const store = this.native.getStore();
    if (toolName === "search") {
      const query = arguments_.query;
      if (typeof query !== "string") {
        throw new AgenticProductError(
          "invalid_search_query",
          "Lexical query must be a string"
        );
      }
      let scopes: ReturnType<typeof taskScopedSearchOptions>;
      try {
        scopes = taskScopedSearchOptions(this.task, arguments_);
      } catch (cause) {
        throw new AgenticProductError(
          "task_scope_violation",
          "Lexical search scope is outside the active task corpus",
          { cause }
        );
      }
      const searches = [];
      for (const options of scopes) {
        searches.push(
          await runLexicalSearch({
            store,
            snapshot: this.native.getSnapshot(),
            taskId: this.task.taskId,
            query,
            options,
          })
        );
      }
      const first = searches[0];
      const outcome =
        searches.length === 1 && first
          ? first
          : {
              result: {
                status: "ok" as const,
                resultRole: "candidates" as const,
                content: canonicalJson({
                  scopes: searches.map((search) =>
                    JSON.parse(search.result.content)
                  ),
                }),
                evidence: searches.flatMap((search) => search.result.evidence),
                errorCode: null,
              },
              backendInvocations: searches.reduce(
                (sum, search) => sum + search.backendInvocations,
                0
              ),
            };
      return {
        ...outcome,
        timing: measuredTiming(performance.now() - started),
        diagnostics: [
          "lexical-only: expansion, vectors, reranking, and graph disabled",
        ],
      };
    }
    const uris =
      toolName === "get"
        ? [arguments_.uri as string]
        : (arguments_.uris as string[]);
    try {
      assertTaskScopedUris(this.task, uris);
    } catch (cause) {
      throw new AgenticProductError(
        "task_scope_violation",
        "Lexical read scope is outside the active task corpus",
        { cause }
      );
    }
    const outcome =
      toolName === "get"
        ? await runLexicalRead({
            store,
            uris,
            fromLine: arguments_.fromLine as number | undefined,
            lineCount: arguments_.lineCount as number | undefined,
          })
        : await runLexicalRead({
            store,
            uris,
            maxBytes: arguments_.maxBytes as number | undefined,
          });
    return {
      ...outcome,
      timing: measuredTiming(performance.now() - started),
      diagnostics: [],
    };
  }

  dispose(): Promise<void> {
    return this.native.dispose();
  }
}

export const createLexicalAdapterFactory = (): AgentAdapterFactory => () =>
  new LexicalAdapter();
