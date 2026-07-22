import type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterCapabilities,
} from "../adapter";
import type { CapsuleCandidate } from "../capsule-selection";
import type { AgentTask, NormalizedToolEvidence } from "../types";

import {
  AgenticProductError,
  CANONICAL_AGENT_TOOLS,
  measuredTiming,
} from "../adapter";
import {
  canonicalFingerprint,
  normalizeNewlines,
  sha256Bytes,
} from "../canonical";
import { matchingCapsuleFacets, planCapsuleQuery } from "../capsule-query";
import {
  omitRedundantCapsuleCandidates,
  selectCapsuleEvidence,
} from "../capsule-selection";
import { NativeFixtureStoreLifecycle } from "../native-fixture-store";
import {
  conservativeCapsuleResultFits,
  finalizeCapsuleResult,
  type CapsulePayloadContext,
} from "./capsule-prototype-payload";
import {
  assertTaskScopedUris,
  runLexicalRead,
  runLexicalSearch,
  taskScopedSearchOptions,
} from "./lexical-core";

export const CAPSULE_PROTOTYPE_ADAPTER_ID = "capsule" as const;

const CAPSULE_CAPABILITIES = Object.freeze({
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

const CAPSULE_CONFIG = Object.freeze({
  adapter: CAPSULE_PROTOTYPE_ADAPTER_ID,
  version: 1,
  evalOnly: true,
  retrieval: "production-searchBm25-query-variants",
  selection: "marginal-facet-coverage-v1",
  budget: "complete-model-visible-utf8-v1",
  synthesis: false,
});

const lineCandidates = (
  evidence: NormalizedToolEvidence,
  retrievalRank: number,
  facets: readonly string[]
): CapsuleCandidate[] => {
  const normalized = normalizeNewlines(evidence.text);
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  return lines.flatMap((text, index) => {
    if (!text.trim()) return [];
    const startLine = evidence.startLine + index;
    return [
      {
        ...evidence,
        startLine,
        endLine: startLine,
        spanHash: sha256Bytes(text),
        text,
        retrievalRank: retrievalRank + index,
        facets: matchingCapsuleFacets(text, facets),
      },
    ];
  });
};

class CapsulePrototypeAdapter implements AgentAdapter {
  readonly adapterId = CAPSULE_PROTOTYPE_ADAPTER_ID;
  readonly capabilities = CAPSULE_CAPABILITIES;
  readonly configFingerprint = canonicalFingerprint(CAPSULE_CONFIG);
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
        "Capsule prototype has no active task"
      );
    }
    const started = performance.now();
    if (toolName !== "search") {
      const uris =
        toolName === "get"
          ? [arguments_.uri as string]
          : (arguments_.uris as string[]);
      try {
        assertTaskScopedUris(this.task, uris);
      } catch (cause) {
        throw new AgenticProductError(
          "task_scope_violation",
          "Capsule read scope is outside the active task corpus",
          { cause }
        );
      }
    }
    const outcome =
      toolName === "search"
        ? await this.buildCapsule(arguments_, signal)
        : toolName === "get"
          ? await runLexicalRead({
              store: this.native.getStore(),
              uris: [arguments_.uri as string],
              fromLine: arguments_.fromLine as number | undefined,
              lineCount: arguments_.lineCount as number | undefined,
            })
          : await runLexicalRead({
              store: this.native.getStore(),
              uris: arguments_.uris as string[],
              maxBytes: arguments_.maxBytes as number | undefined,
            });
    return {
      ...outcome,
      timing: measuredTiming(performance.now() - started),
      diagnostics:
        toolName === "search"
          ? ["eval-only Capsule prototype; no production API contract"]
          : [],
    };
  }

  dispose(): Promise<void> {
    return this.native.dispose();
  }

  private async buildCapsule(
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ) {
    const task = this.task as Readonly<AgentTask>;
    const query = arguments_.query;
    if (typeof query !== "string") {
      throw new AgenticProductError(
        "invalid_search_query",
        "Capsule query must be a string"
      );
    }
    const plan = planCapsuleQuery(task, query);
    let scopes: ReturnType<typeof taskScopedSearchOptions>;
    try {
      scopes = taskScopedSearchOptions(task, arguments_);
    } catch (cause) {
      throw new AgenticProductError(
        "task_scope_violation",
        "Capsule search scope is outside the active task corpus",
        { cause }
      );
    }
    const uris: string[] = [];
    let backendInvocations = 1;
    for (const variant of plan.variants) {
      if (signal.aborted) throw signal.reason;
      for (const options of scopes) {
        const search = await runLexicalSearch({
          store: this.native.getStore(),
          snapshot: this.native.getSnapshot(),
          taskId: task.taskId,
          query: variant,
          options,
        });
        backendInvocations += search.backendInvocations;
        for (const evidence of search.result.evidence) {
          if (!uris.includes(evidence.uri)) uris.push(evidence.uri);
        }
      }
    }

    const candidates: CapsuleCandidate[] = [];
    for (const [uriIndex, uri] of uris.entries()) {
      const read = await runLexicalRead({
        store: this.native.getStore(),
        uris: [uri],
      });
      backendInvocations += read.backendInvocations;
      for (const evidence of read.result.evidence) {
        candidates.push(
          ...lineCandidates(evidence, uriIndex * 1000, plan.facets)
        );
      }
    }

    backendInvocations += 2;
    const payloadContext: CapsulePayloadContext = {
      taskId: task.taskId,
      goal: task.brief.goal,
      query: plan.requestedQuery,
      variants: plan.variants,
      facets: plan.facets,
      backendInvocations,
      backendInvocationStages: {
        queryPlanning: 1,
        lexicalSearch: plan.variants.length * scopes.length,
        sourceRead: uris.length * 2,
        selection: 1,
        finalization: 1,
      },
      indexFingerprint: this.native.getIndexFingerprint(),
      configFingerprint: this.configFingerprint,
      maxModelVisibleUtf8Bytes: task.budgets.maxModelVisibleBytes,
    };
    const maxFacetCoverage = Math.max(
      0,
      ...candidates.map((candidate) => candidate.facets.length)
    );
    const selectionCandidates =
      task.budgets.maxAgentCalls === 1
        ? candidates.filter(
            (candidate) => candidate.facets.length === maxFacetCoverage
          )
        : candidates;
    const selection = selectCapsuleEvidence(selectionCandidates, (selected) =>
      conservativeCapsuleResultFits(payloadContext, selected, candidates)
    );
    if (selectionCandidates.length !== candidates.length) {
      selection.omitted.push(
        ...omitRedundantCapsuleCandidates(candidates, selectionCandidates)
      );
    }
    const finalized = finalizeCapsuleResult(payloadContext, selection);
    return { result: finalized.result, backendInvocations };
  }
}

export const createCapsulePrototypeAdapterFactory =
  (): AgentAdapterFactory => () =>
    new CapsulePrototypeAdapter();

export {
  canonicalCapsulePayloadJson,
  capsulePayloadFingerprint,
} from "./capsule-prototype-payload";
export type { CapsulePrototypePayload } from "./capsule-prototype-payload";
