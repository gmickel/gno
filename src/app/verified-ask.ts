/** Shared closed-evidence Ask synthesis boundary. */

import type {
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";
import type { RetrievalTraceSession } from "../core/retrieval-trace-session";
import type { GenerationPort } from "../llm/types";
import type { AskOptions, AskResult, Citation } from "../pipeline/types";
import type { ContextCapsuleRuntimeDeps } from "./context-runtime";

import { buildAnswerPrompt } from "../pipeline/answer-prompt";
import { CLAIM_ABSTENTION_TEXT } from "../pipeline/claim-verification";
import { verifyClaimsSemantically } from "../pipeline/claim-verifier";
import { attachCitationTraceMetadata } from "../pipeline/trace-metadata";
import { CITATION_TRACE_METADATA } from "../pipeline/types";
import {
  buildContextCapsule,
  getContextCapsuleExplain,
  verifyContextCapsuleRuntime,
} from "./context-runtime";
import { contextRuntimeConfigFingerprint } from "./context-runtime-contract";

const DEFAULT_CONTEXT_BUDGET_TOKENS = 12_000;
const DEFAULT_MAX_ANSWER_TOKENS = 512;
const DEFAULT_VERIFIED_ASK_LIMIT = 5;
const NUMERIC_CITATION_PATTERN = /\[(\d+)\]/g;

export interface VerifiedAskDeps extends ContextCapsuleRuntimeDeps {
  genPort: GenerationPort;
  traceSession?: RetrievalTraceSession;
}

const generationSources = (capsule: ContextCapsuleV1) => {
  const guidanceById = new Map(
    capsule.guidance.configuredContexts.map((item) => [
      item.contextId,
      item.text,
    ])
  );
  return capsule.evidence.map((evidence, index) => ({
    index: index + 1,
    docid: evidence.docid,
    uri: evidence.uri,
    content: evidence.text,
    guidance: evidence.contextIds
      .flatMap((contextId) => {
        const text = guidanceById.get(contextId);
        return text ? [text] : [];
      })
      .join("\n"),
  }));
};

/** Map model-facing numeric citations to immutable Capsule evidence IDs. */
export const mapAnswerCitationsToEvidence = (
  answer: string,
  capsule: ContextCapsuleV1
): string =>
  answer
    .replace(NUMERIC_CITATION_PATTERN, (_marker, rawIndex: string) => {
      const evidence = capsule.evidence[Number(rawIndex) - 1];
      return evidence ? `[evidence:${evidence.evidenceId}]` : "";
    })
    .replace(/ {2,}/g, " ")
    .trim();

const retainedCitations = (
  capsule: ContextCapsuleV1,
  evidenceIds: ReadonlySet<string>
): Citation[] =>
  capsule.evidence.flatMap((evidence) => {
    if (!evidenceIds.has(evidence.evidenceId)) return [];
    return [
      attachCitationTraceMetadata(
        {
          evidenceId: evidence.evidenceId,
          docid: evidence.docid,
          uri: evidence.uri,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
        },
        {
          sourceHash: evidence.sourceHash,
          mirrorHash: evidence.mirrorHash,
          passageHash: evidence.passageHash,
          rank: evidence.selectionRank,
          plannerRank: evidence.retrievalRank,
          ...(evidence.retrievalSources === undefined
            ? {}
            : { sources: evidence.retrievalSources }),
          ...(evidence.graphExpanded === undefined
            ? {}
            : { graphExpanded: evidence.graphExpanded }),
        }
      ),
    ];
  });

const recordRetainedCitations = async (
  traceSession: RetrievalTraceSession | undefined,
  citations: readonly Citation[]
): Promise<void> => {
  if (!traceSession || citations.length === 0) return;
  const evidence = citations.flatMap((citation) => {
    const metadata = citation[CITATION_TRACE_METADATA];
    if (
      !metadata ||
      citation.startLine === undefined ||
      citation.endLine === undefined
    ) {
      return [];
    }
    return [
      {
        docid: citation.docid,
        uri: citation.uri,
        sourceHash: metadata.sourceHash,
        mirrorHash: metadata.mirrorHash,
        passageHash: metadata.passageHash,
        startLine: citation.startLine,
        endLine: citation.endLine,
        rank: metadata.rank,
        ...(metadata.plannerRank === undefined
          ? {}
          : { plannerRank: metadata.plannerRank }),
        ...(metadata.sources === undefined
          ? {}
          : { sources: metadata.sources }),
        ...(metadata.graphExpanded === undefined
          ? {}
          : { graphExpanded: metadata.graphExpanded }),
      },
    ];
  });
  if (evidence.length === 0) return;
  const recorded = await traceSession.recordEvidence("cite", evidence);
  if (!recorded.ok) {
    throw new Error(`Trace recording failed: ${recorded.error.message}`);
  }
};

const citationEvidenceIds = (
  verification: Awaited<ReturnType<typeof verifyClaimsSemantically>>,
  statuses: ReadonlySet<"supported" | "contradicted">
): Set<string> =>
  new Set(
    verification.verification.claims.flatMap((claim) =>
      statuses.has(claim.status as "supported" | "contradicted")
        ? claim.evidence.map((evidence) => evidence.evidenceId)
        : []
    )
  );

const recordCapability = async (
  traceSession: RetrievalTraceSession | undefined,
  capability: string,
  status: "attempted" | "used" | "unavailable" | "failed",
  reasonCode?: string
): Promise<void> => {
  const recorded = await traceSession?.recordCapability(
    capability,
    status,
    reasonCode
  );
  if (recorded && !recorded.ok) {
    throw new Error(`Trace recording failed: ${recorded.error.message}`);
  }
};

export const buildVerifiedAsk = async (
  query: string,
  options: AskOptions,
  deps: VerifiedAskDeps
): Promise<AskResult> => {
  const collection = options.collection;
  const capsule = await buildContextCapsule(
    {
      goal: query,
      query,
      indexName: deps.indexName,
      collections: collection ? [collection] : [],
      queryModes: options.queryModes,
      tagsAll: options.tagsAll,
      tagsAny: options.tagsAny,
      categories: options.categories,
      author: options.author,
      lang: options.lang,
      intent: options.intent,
      exclude: options.exclude,
      minScore: options.minScore,
      since: options.since,
      until: options.until,
      graph: Boolean(options.graph && !options.noGraph),
      noRerank: options.noRerank,
      limit: options.limit ?? DEFAULT_VERIFIED_ASK_LIMIT,
      candidateLimit: options.candidateLimit,
      budgetTokens:
        options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      budgetBytes: options.contextBudgetBytes,
      depthPolicy: "balanced",
    },
    { ...deps, explain: options.explain }
  );
  const freshness = await verifyContextCapsuleRuntime(capsule, deps);
  return synthesizeVerifiedAsk(query, options, capsule, freshness, deps);
};

export const synthesizeVerifiedAsk = async (
  query: string,
  options: AskOptions,
  capsule: ContextCapsuleV1,
  freshness: ContextCapsuleVerification,
  deps: Pick<
    VerifiedAskDeps,
    "config" | "genPort" | "indexName" | "traceSession"
  >
): Promise<AskResult> => {
  await recordCapability(deps.traceSession, "answer_generation", "attempted");
  const generated = await deps.genPort.generate(
    buildAnswerPrompt(query, generationSources(capsule)),
    {
      temperature: 0,
      maxTokens: options.maxAnswerTokens ?? DEFAULT_MAX_ANSWER_TOKENS,
    }
  );
  await recordCapability(
    deps.traceSession,
    "answer_generation",
    generated.ok ? "used" : "failed",
    generated.ok ? undefined : "generation_failed"
  );
  const draftAnswer = generated.ok
    ? mapAnswerCitationsToEvidence(generated.value, capsule)
    : CLAIM_ABSTENTION_TEXT;
  const verification = await verifyClaimsSemantically({
    answer: draftAnswer,
    capsule,
    freshness,
    genPort: generated.ok ? deps.genPort : null,
    configFingerprint: contextRuntimeConfigFingerprint(deps),
  });
  await recordCapability(
    deps.traceSession,
    "claim_verification",
    verification.semanticVerification.status === "completed"
      ? "used"
      : verification.semanticVerification.status,
    verification.semanticVerification.reason
  );
  const citations = verification.verification.abstained
    ? []
    : retainedCitations(
        capsule,
        citationEvidenceIds(verification, new Set(["supported"]))
      );
  const traceCitations = retainedCitations(
    capsule,
    citationEvidenceIds(verification, new Set(["supported", "contradicted"]))
  );
  await recordRetainedCitations(deps.traceSession, traceCitations);
  const retrievalExplain = options.explain
    ? getContextCapsuleExplain(capsule)
    : undefined;
  return {
    query,
    mode: capsule.capabilities.semanticSearch ? "hybrid" : "bm25_only",
    queryLanguage: capsule.retrieval.request.lang ?? "und",
    answer: verification.verification.abstained
      ? (verification.verification.abstentionText ?? CLAIM_ABSTENTION_TEXT)
      : draftAnswer,
    citations,
    results: [],
    meta: {
      expanded: false,
      reranked: capsule.capabilities.reranking,
      vectorsUsed: capsule.capabilities.semanticSearch,
      intent: capsule.retrieval.request.intent ?? undefined,
      candidateLimit: capsule.retrieval.request.candidateLimit,
      exclude: capsule.retrieval.request.exclude,
      answerGenerated: generated.ok,
      totalResults: capsule.evidence.length,
      ...(retrievalExplain ? { explain: retrievalExplain } : {}),
      verificationRequested: true,
      abstained: verification.verification.abstained,
    },
    verification: {
      schemaVersion: "1.0",
      mode: "closed_capsule",
      capsule,
      freshness,
      claims: verification.verification,
      semantic: verification.semanticVerification,
    },
  };
};
