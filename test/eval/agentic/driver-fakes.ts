import type {
  AgentAdapter,
  AdapterPreparation,
  AgentToolDefinition,
} from "../../../evals/agentic/adapter";
import type {
  AgentTask,
  CorpusSnapshot,
  NormalizedToolEvidence,
  NormalizedToolResult,
} from "../../../evals/agentic/types";

import {
  CANONICAL_AGENT_TOOLS,
  measuredTiming,
  unavailableTiming,
} from "../../../evals/agentic/adapter";
import {
  canonicalFingerprint,
  normalizeNewlines,
  sha256Bytes,
} from "../../../evals/agentic/canonical";

export const NORMALIZED_TOOLS: readonly AgentToolDefinition[] = structuredClone(
  CANONICAL_AGENT_TOOLS
);

export interface FakeAdapterMetrics {
  instances: number;
  preparations: number;
  attaches: number;
  readinessProbes: number;
  scoredResets: number;
  calls: number;
  disposals: number;
  visibleTasks: AgentTask[];
}

export interface FakeAdapterOptions {
  adapterId?: string;
  backendInvocations?: number;
  resultOverride?: NormalizedToolResult;
  searchResultRole?: NormalizedToolResult["resultRole"];
  throwOnCall?: Error;
  throwOnPrepare?: Error;
  throwOnReset?: Error;
  throwOnReadiness?: Error;
  tools?: readonly AgentToolDefinition[];
  capabilities?: AgentAdapter["capabilities"];
}

const lineEvidence = (
  snapshot: CorpusSnapshot,
  taskId: string,
  collection: string | null,
  uris: readonly string[] | null
): NormalizedToolEvidence[] =>
  snapshot.files
    .filter(
      (file) =>
        file.taskId === taskId &&
        (!collection || file.collection === collection) &&
        (!uris || uris.includes(`gno://${file.collection}/${file.relPath}`))
    )
    .flatMap((file) => {
      const uri = `gno://${file.collection}/${file.relPath}`;
      return normalizeNewlines(file.content)
        .replace(/\n$/, "")
        .split("\n")
        .map((text, index) => ({
          uri,
          sourceHash: file.sourceHash,
          startLine: index + 1,
          endLine: index + 1,
          spanHash: sha256Bytes(text),
          sourceHashProvenance: "harness_observed" as const,
          spanHashProvenance: "harness_observed" as const,
          text,
          backendSourceHash: null,
          backendSpanHash: null,
          backendHashUnavailableReason:
            "fake adapter exposes observed hashes only",
        }));
    });

export const createPerfectAdapterFactory = (
  snapshot: CorpusSnapshot,
  options: FakeAdapterOptions = {}
): { factory: () => AgentAdapter; metrics: FakeAdapterMetrics } => {
  const adapterId = options.adapterId ?? "perfect";
  const metrics: FakeAdapterMetrics = {
    instances: 0,
    preparations: 0,
    attaches: 0,
    readinessProbes: 0,
    scoredResets: 0,
    calls: 0,
    disposals: 0,
    visibleTasks: [],
  };
  const indexFingerprint = canonicalFingerprint({
    adapterId,
    corpus: snapshot.fingerprint,
  });
  const factory = (): AgentAdapter => {
    metrics.instances += 1;
    let task: Readonly<AgentTask> | null = null;
    return {
      adapterId,
      capabilities: options.capabilities ?? {
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
      },
      configFingerprint: canonicalFingerprint({ adapterId, config: "fake-v1" }),
      async prepare({ prepared }) {
        if (options.throwOnPrepare) throw options.throwOnPrepare;
        if (prepared) metrics.attaches += 1;
        else metrics.preparations += 1;
        const value: AdapterPreparation = {
          adapterId,
          corpusFingerprint: snapshot.fingerprint,
          indexFingerprint,
          preparation: measuredTiming(5),
          observations: { fixture: true },
          tempPaths: ["/tmp/fake-index"],
          handle: prepared?.handle ?? { immutable: true },
        };
        return value;
      },
      async listTools() {
        return structuredClone(options.tools ?? NORMALIZED_TOOLS);
      },
      async reset(context) {
        if (context.readinessProbe && options.throwOnReadiness) {
          throw options.throwOnReadiness;
        }
        if (!context.readinessProbe && options.throwOnReset) {
          throw options.throwOnReset;
        }
        task = context.task;
        metrics.visibleTasks.push(structuredClone(context.task));
        if (context.readinessProbe) metrics.readinessProbes += 1;
        else metrics.scoredResets += 1;
        return {
          startup: measuredTiming(2),
          modelLoad: unavailableTiming("fake adapter has no model"),
          diagnostics: [],
        };
      },
      async callTool(toolName, arguments_) {
        metrics.calls += 1;
        if (options.throwOnCall) throw options.throwOnCall;
        if (!task) throw new Error("fake adapter was not reset");
        const collection =
          typeof arguments_.collection === "string"
            ? arguments_.collection
            : null;
        const uris =
          toolName === "get" && typeof arguments_.uri === "string"
            ? [arguments_.uri]
            : toolName === "multi_get" && Array.isArray(arguments_.uris)
              ? arguments_.uris.filter(
                  (uri): uri is string => typeof uri === "string"
                )
              : null;
        let evidence = lineEvidence(snapshot, task.taskId, collection, uris);
        if (
          toolName === "get" &&
          Number.isInteger(arguments_.fromLine) &&
          Number.isInteger(arguments_.lineCount)
        ) {
          const fromLine = arguments_.fromLine as number;
          const throughLine = fromLine + (arguments_.lineCount as number) - 1;
          evidence = evidence.filter(
            (item) => item.startLine >= fromLine && item.endLine <= throughLine
          );
        }
        if (
          toolName === "search" &&
          task.budgets.maxAgentCalls === 1 &&
          typeof arguments_.query === "string"
        ) {
          const terms =
            arguments_.query
              .toLowerCase()
              .match(/[a-z0-9]+/g)
              ?.filter((term) => term.length >= 5) ?? [];
          evidence = evidence.filter(
            (item) =>
              !item.text.startsWith("#") &&
              terms.filter((term) => item.text.toLowerCase().includes(term))
                .length >= 2
          );
        }
        return {
          result:
            options.resultOverride ??
            ({
              status: "ok",
              resultRole:
                toolName === "search"
                  ? (options.searchResultRole ?? "evidence_bundle")
                  : "source",
              content: evidence.map((item) => item.text).join("\n"),
              evidence,
              errorCode: null,
            } satisfies NormalizedToolResult),
          backendInvocations: options.backendInvocations ?? 1,
          timing: measuredTiming(3),
          diagnostics: [],
        };
      },
      async dispose() {
        metrics.disposals += 1;
      },
    };
  };
  return { factory, metrics };
};
