/** MCP verified Ask tool over the shared closed-evidence application boundary. */

import { z } from "zod";

import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type { QueryModeInput } from "../../pipeline/types";
import type { ToolContext } from "../server";
import type { ToolResult } from "./index";

import { buildVerifiedAsk } from "../../app/verified-ask";
import { resolveRemoteProjectAffinity } from "../../core/project-affinity-surface";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { attachRetrievalTraceMetadata } from "../../core/retrieval-trace-session";
import { normalizeStructuredQueryInput } from "../../core/structured-query";
import { resolveModelUri } from "../../llm/registry";
import { answerTraceTerminalStatus } from "../../pipeline/answer";
import { createMcpModelPorts, type McpModelPortFactory } from "./context";
import { normalizeTagFilters, runTool } from "./index";

const queryModeSchema = z
  .object({
    mode: z.enum(["term", "intent", "hyde"]),
    text: z.string().trim().min(1),
  })
  .strict();

export const askInputSchema = z
  .object({
    query: z.string().trim().min(1),
    projectHints: z.array(z.string()).max(16).optional(),
    verify: z.literal(true),
    collection: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(5),
    minScore: z.number().min(0).max(1).optional(),
    lang: z.string().optional(),
    intent: z.string().optional(),
    candidateLimit: z.number().int().min(1).max(100).optional(),
    exclude: z.array(z.string()).optional(),
    queryModes: z.array(queryModeSchema).optional(),
    tagsAll: z.array(z.string()).optional(),
    tagsAny: z.array(z.string()).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    categories: z.array(z.string()).optional(),
    author: z.string().optional(),
    graph: z.boolean().optional(),
    noGraph: z.boolean().optional(),
    noRerank: z.boolean().optional(),
    explain: z.boolean().optional(),
    maxAnswerTokens: z.number().int().positive().optional(),
    contextBudgetTokens: z.number().int().positive().optional(),
    contextBudgetBytes: z.number().int().positive().optional(),
  })
  .strict();

type AskInput = z.infer<typeof askInputSchema>;

export interface HandleAskDependencies {
  modelPortFactory?: McpModelPortFactory;
}

const exactSpan = (uri: string, startLine: number, endLine: number): string =>
  `${uri}:L${startLine}${startLine === endLine ? "" : `-L${endLine}`}`;

export const formatVerifiedAskReadable = (
  result: Awaited<ReturnType<typeof buildVerifiedAsk>>
): string => {
  const numbers = new Map(
    (result.citations ?? []).flatMap((citation, index) =>
      citation.evidenceId ? [[citation.evidenceId, index + 1] as const] : []
    )
  );
  const answer = (result.answer ?? "").replace(
    /\[evidence:([a-f0-9]{64})\]/g,
    (_marker, evidenceId: string) => {
      const number = numbers.get(evidenceId);
      return number === undefined ? "" : `[${number}]`;
    }
  );
  const claims = result.verification?.claims;
  const lines = [
    answer || "No verified answer.",
    "",
    `Verification: ${claims?.answerStatus ?? "unavailable"}`,
  ];
  if (claims?.abstentionReason) {
    lines.push(`Reason: ${claims.abstentionReason}`);
  }
  if (claims) {
    lines.push(
      `Claims: ${claims.coverage.supportedClaims}/${claims.coverage.totalClaims} supported`
    );
  }
  const semantic = result.verification?.semantic;
  if (semantic) {
    lines.push(`Semantic verifier: ${semantic.status} (${semantic.reason})`);
  }
  for (const claim of claims?.claims ?? []) {
    lines.push(`- ${claim.status}: ${claim.text}`);
    for (const evidence of claim.evidence) {
      lines.push(
        `  ${exactSpan(evidence.uri, evidence.startLine, evidence.endLine)} (${evidence.evidenceId})`
      );
    }
  }
  for (const gap of result.verification?.capsule.coverage.gaps ?? []) {
    lines.push(`Gap: ${gap.facet} (${gap.code})`);
  }
  for (const facet of result.verification?.capsule.coverage.unresolvedFacets ??
    []) {
    lines.push(`Unresolved facet: ${facet}`);
  }
  for (const [name, state] of Object.entries(
    result.verification?.capsule.retrieval.capabilityStates ?? {}
  )) {
    if (state.requested && state.outcome !== "used") {
      lines.push(
        `Capability: ${name} ${state.outcome}${state.fallbackReasons.length > 0 ? ` (${state.fallbackReasons.join(", ")})` : ""}`
      );
    }
  }
  for (const [index, citation] of (result.citations ?? []).entries()) {
    const span =
      citation.startLine === undefined || citation.endLine === undefined
        ? citation.uri
        : exactSpan(citation.uri, citation.startLine, citation.endLine);
    lines.push(`[${index + 1}] ${span} (${citation.evidenceId ?? "unknown"})`);
  }
  return lines.join("\n");
};

export const handleAsk = (
  args: AskInput,
  context: ToolContext,
  dependencies: HandleAskDependencies = {}
): Promise<ToolResult> =>
  runTool(
    context,
    "gno_ask",
    async () => {
      if (
        args.collection &&
        !context.collections.some(
          (collection) => collection.name === args.collection
        )
      ) {
        throw new Error(`Collection not found: ${args.collection}`);
      }
      const normalized = normalizeStructuredQueryInput(
        args.query,
        (args.queryModes ?? []) as QueryModeInput[]
      );
      if (!normalized.ok) throw new Error(normalized.error.message);
      const query = normalized.value.query;
      const { projectHints, ...askInput } = args;
      const projectAffinity = await resolveRemoteProjectAffinity(
        context.config,
        projectHints
      );
      const options = {
        ...askInput,
        projectAffinity,
        queryModes:
          normalized.value.queryModes.length > 0
            ? normalized.value.queryModes
            : undefined,
        tagsAll: normalizeTagFilters(args.tagsAll),
        tagsAny: normalizeTagFilters(args.tagsAny),
      };
      let traceSession: RetrievalTraceSession | undefined;
      let modelPorts: Awaited<ReturnType<typeof createMcpModelPorts>> | null =
        null;
      try {
        const started = await startRetrievalTraceRequest({
          store: context.store,
          config: context.config,
          query,
          filters: retrievalTraceFilters(options),
          pipeline: "ask",
          indexName: context.indexName,
          modelUris: [
            resolveModelUri(
              context.config,
              "embed",
              undefined,
              args.collection
            ),
            resolveModelUri(
              context.config,
              "rerank",
              undefined,
              args.collection
            ),
            resolveModelUri(context.config, "gen", undefined, args.collection),
          ],
        });
        if (!started.ok) throw new Error(started.error.message);
        traceSession = started.value ?? undefined;
        modelPorts = await createMcpModelPorts(
          context,
          args.collection,
          dependencies.modelPortFactory,
          { generation: true }
        );
        if (!modelPorts.genPort) {
          throw new Error(
            "Answer generation requested but no generation model is available"
          );
        }
        const result = await buildVerifiedAsk(query, options, {
          store: context.store,
          config: context.config,
          indexName: context.indexName,
          vectorIndex: modelPorts.vectorIndex,
          embedPort: modelPorts.embedPort,
          rerankPort: modelPorts.rerankPort,
          genPort: modelPorts.genPort,
          projectAffinity,
          traceSession,
        });
        const finished = await traceSession?.finish(
          answerTraceTerminalStatus(result.citations)
        );
        if (finished && !finished.ok) throw new Error(finished.error.message);
        return attachRetrievalTraceMetadata(result, traceSession);
      } catch (error) {
        await finishRetrievalTraceAfterError(traceSession, error);
        throw error;
      } finally {
        await modelPorts?.dispose();
      }
    },
    formatVerifiedAskReadable
  );
