/** Deterministic readable projections for Context Capsule surfaces. */

import type {
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";

import { canonicalContextCapsuleJson } from "../core/context-capsule";
import { canonicalContextCapsuleVerificationJson } from "../core/context-verifier";

const nullable = (value: string | number | null): string =>
  value === null ? "unavailable" : String(value);
const json = (value: unknown): string => JSON.stringify(value);
const indentedJson = (value: unknown): string[] =>
  JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`);

const capabilityLines = (capsule: ContextCapsuleV1): string[] =>
  Object.entries(capsule.retrieval.capabilityStates).flatMap(
    ([capability, state]) => [
      `- ${capability}: ${state.outcome}`,
      `  - requested: ${state.requested}`,
      `  - attempted: ${state.attempted}`,
      `  - fallback reasons: ${
        state.fallbackReasons.length > 0
          ? state.fallbackReasons.join(", ")
          : "none"
      }`,
    ]
  );

const configuredContextLines = (
  capsule: ContextCapsuleV1,
  contextIds: readonly string[]
): string[] => {
  const contexts = capsule.guidance.configuredContexts.filter((context) =>
    contextIds.includes(context.contextId)
  );
  return contexts.length === 0
    ? ["    []"]
    : indentedJson(
        contexts.map(({ contextId, scopeType, scopeKey, text }) => ({
          contextId,
          scopeType,
          scopeKey,
          text,
        }))
      );
};

const evidenceBlock = (
  capsule: ContextCapsuleV1,
  item: ContextCapsuleV1["evidence"][number]
): string[] => [
  `## Evidence ${item.selectionRank}`,
  "",
  `- Evidence ID: \`${item.evidenceId}\``,
  `- URI: \`${item.uri}\``,
  `- Docid: \`${item.docid}\``,
  `- Collection: \`${item.collection}\``,
  `- Lines: ${item.startLine}-${item.endLine}`,
  `- Retrieval rank: ${item.retrievalRank}`,
  `- Selection rank: ${item.selectionRank}`,
  `- Modified: ${nullable(item.modifiedAt)}`,
  `- Document date: ${nullable(item.documentDate)}`,
  `- Observed: ${nullable(item.observedAt)}`,
  `- Facets: ${item.facets.length > 0 ? item.facets.join(", ") : "none"}`,
  `- Trust: ${item.trust}`,
  `- Egress: ${item.egress}`,
  `- Source hash: \`${item.sourceHash}\``,
  `- Mirror hash: \`${item.mirrorHash}\``,
  `- Passage hash: \`${item.passageHash}\``,
  "",
  `<!-- GNO_UNTRUSTED_METADATA_START ${item.evidenceId} -->`,
  `    {"title":${json(item.title)},"heading":${json(item.heading)}}`,
  "    configuredContexts:",
  ...configuredContextLines(capsule, item.contextIds),
  `<!-- GNO_UNTRUSTED_METADATA_END ${item.evidenceId} -->`,
  "",
  `<!-- GNO_EVIDENCE_TEXT_START ${item.evidenceId} -->`,
  item.text,
  `<!-- GNO_EVIDENCE_TEXT_END ${item.evidenceId} -->`,
  "",
];

const omissionLines = (capsule: ContextCapsuleV1): string[] => [
  `- Total: ${capsule.omissions.total}`,
  `- Visible items: ${capsule.omissions.items.length}`,
  `- Bounded-list truncated: ${capsule.omissions.truncated}`,
  ...Object.entries(capsule.omissions.reasonCounts).map(
    ([reason, count]) => `- ${reason}: ${count}`
  ),
];

export const formatContextCapsuleMarkdown = (
  capsule: ContextCapsuleV1
): string => {
  const lines = [
    "# GNO Context Capsule",
    "",
    `- Schema: ${capsule.schemaVersion}`,
    `- Coordinate space: ${capsule.coordinateSpace}`,
    `- Capsule ID: \`${capsule.capsuleId}\``,
    `- Goal: ${json(capsule.goal)}`,
    `- Query: ${json(capsule.query)}`,
    `- Index: \`${capsule.scope.indexName}\``,
    `- Collections: ${
      capsule.scope.collections.length > 0
        ? capsule.scope.collections.join(", ")
        : "all"
    }`,
    `- URI prefix: ${nullable(capsule.scope.uriPrefix)}`,
    `- Tags all: ${json(capsule.scope.tagsAll)}`,
    `- Tags any: ${json(capsule.scope.tagsAny)}`,
    `- Categories: ${json(capsule.scope.categories)}`,
    `- Since/until: ${nullable(capsule.scope.since)} / ${nullable(capsule.scope.until)}`,
    "",
    "## Budget and retrieval",
    "",
    `- Budget: ${capsule.budget.usedTokens}/${capsule.budget.requestedTokens} tokens; ${capsule.budget.usedBytes}/${capsule.budget.requestedBytes} bytes`,
    `- Safety margin: ${capsule.budget.safetyMarginTokens} tokens; ${capsule.budget.safetyMarginBytes} bytes`,
    `- Estimator: ${capsule.budget.estimator}`,
    `- Tokenizer fingerprint: ${nullable(capsule.budget.tokenizerFingerprint)}`,
    `- Depth: ${capsule.retrieval.depthPolicy}`,
    `- Facets: ${json(capsule.retrieval.facets)}`,
    `- Query variants: ${json(capsule.retrieval.queryVariants)}`,
    `- Request: ${json(capsule.retrieval.request)}`,
    `- Index snapshot: ${json(capsule.retrieval.indexSnapshot)}`,
    "",
    "## Capabilities and fallbacks",
    "",
    ...capabilityLines(capsule),
    `- Effective capabilities: ${json(capsule.capabilities)}`,
    `- Fallbacks: ${json(capsule.fallbacks)}`,
    "",
    "## Fingerprints",
    "",
    ...Object.entries(capsule.fingerprints).map(
      ([name, value]) => `- ${name}: ${nullable(value)}`
    ),
    "",
    ...capsule.evidence.flatMap((item) => evidenceBlock(capsule, item)),
    "## Coverage, omissions, and truncation",
    "",
    `- Coverage complete: ${capsule.coverage.complete}`,
    `- Requested facets: ${json(capsule.coverage.requestedFacets)}`,
    `- Covered facets: ${json(capsule.coverage.coveredFacets)}`,
    `- Unresolved facets: ${json(capsule.coverage.unresolvedFacets)}`,
    `- Gaps: ${json(capsule.coverage.gaps)}`,
    `- Capsule truncated: ${capsule.truncated}`,
    `- Warnings: ${json(capsule.warnings)}`,
    ...omissionLines(capsule),
    `- Omission items: ${json(capsule.omissions.items)}`,
    "",
    "## Canonical manifest",
    "",
    "<!-- GNO_UNTRUSTED_MANIFEST_START -->",
    ...indentedJson(JSON.parse(canonicalContextCapsuleJson(capsule))),
    "<!-- GNO_UNTRUSTED_MANIFEST_END -->",
    "",
  ];
  return lines.join("\n");
};

export const formatContextCapsuleVerificationMarkdown = (
  receipt: ContextCapsuleVerification
): string => {
  const lines = [
    "# GNO Context Capsule verification",
    "",
    `- Schema: ${receipt.schemaVersion}`,
    `- Coordinate space: ${receipt.coordinateSpace}`,
    `- Capsule ID: \`${receipt.capsuleId}\``,
    `- Operation: ${receipt.operationStatus}`,
    `- Content: ${receipt.contentStatus} (${receipt.contentCode})`,
    `- Ranking: ${receipt.rankingStatus} (${receipt.rankingCode})`,
    `- Fingerprints: ${receipt.fingerprintStatus}`,
    `- Fingerprint reasons: ${
      receipt.fingerprintReasons.length > 0
        ? receipt.fingerprintReasons.join(", ")
        : "none"
    }`,
    `- Index snapshot: ${json(receipt.indexSnapshot)}`,
    "",
    "## Current fingerprints",
    "",
    ...Object.entries(receipt.currentFingerprints).map(
      ([name, value]) => `- ${name}: ${nullable(value)}`
    ),
    "",
    "## Evidence",
    "",
    ...receipt.evidence.flatMap((item) => [
      `### \`${item.evidenceId}\``,
      "",
      `- URI: \`${item.uri}\``,
      `- Content: ${item.contentStatus} (${item.contentCode})`,
      `- Ranking: ${item.rankingStatus} (${item.rankingCode})`,
      `- Current rank: ${nullable(item.currentRetrievalRank)}`,
      `- Current source hash: ${nullable(item.currentSourceHash)}`,
      `- Current mirror hash: ${nullable(item.currentMirrorHash)}`,
      `- Current passage hash: ${nullable(item.currentPassageHash)}`,
      "",
    ]),
    "## Canonical receipt",
    "",
    ...indentedJson(
      JSON.parse(canonicalContextCapsuleVerificationJson(receipt))
    ),
    "",
  ];
  return lines.join("\n");
};
