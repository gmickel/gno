/** Deterministic readable projections for Context Capsule surfaces. */

import type {
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";

const nullable = (value: string | number | null): string =>
  value === null ? "unavailable" : String(value);

const evidenceBlock = (
  item: ContextCapsuleV1["evidence"][number]
): string[] => [
  `## Evidence ${item.selectionRank}: ${item.title ?? item.uri}`,
  "",
  `- Evidence ID: \`${item.evidenceId}\``,
  `- URI: \`${item.uri}\``,
  `- Lines: ${item.startLine}-${item.endLine}`,
  `- Heading: ${item.heading ?? "unavailable"}`,
  `- Facets: ${item.facets.length > 0 ? item.facets.join(", ") : "none"}`,
  `- Source hash: \`${item.sourceHash}\``,
  `- Mirror hash: \`${item.mirrorHash}\``,
  `- Passage hash: \`${item.passageHash}\``,
  "",
  `<!-- GNO_EVIDENCE_START ${item.evidenceId} -->`,
  ...item.text.split("\n").map((line) => `    ${line}`),
  `<!-- GNO_EVIDENCE_END ${item.evidenceId} -->`,
  "",
];

export const formatContextCapsuleMarkdown = (
  capsule: ContextCapsuleV1
): string => {
  const lines = [
    `# Context Capsule: ${capsule.goal}`,
    "",
    `- Capsule ID: \`${capsule.capsuleId}\``,
    `- Query: ${capsule.query}`,
    `- Index: \`${capsule.scope.indexName}\``,
    `- Collections: ${
      capsule.scope.collections.length > 0
        ? capsule.scope.collections.join(", ")
        : "all"
    }`,
    `- Budget: ${capsule.budget.usedTokens}/${capsule.budget.requestedTokens} tokens; ${capsule.budget.usedBytes}/${capsule.budget.requestedBytes} bytes`,
    `- Safety margin: ${capsule.budget.safetyMarginTokens} tokens; ${capsule.budget.safetyMarginBytes} bytes`,
    `- Coverage: ${
      capsule.coverage.complete
        ? "complete"
        : `incomplete (${capsule.coverage.unresolvedFacets.join(", ")})`
    }`,
    "",
    ...capsule.evidence.flatMap(evidenceBlock),
    "## Gaps and omissions",
    "",
    ...(capsule.coverage.gaps.length === 0
      ? ["- Gaps: none"]
      : capsule.coverage.gaps.map(
          (gap) => `- Gap: ${gap.facet} (${gap.code})`
        )),
    `- Omitted candidates: ${capsule.omissions.total}`,
    ...Object.entries(capsule.omissions.reasonCounts)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `  - ${reason}: ${count}`),
    "",
  ];
  return lines.join("\n");
};

export const formatContextCapsuleVerificationMarkdown = (
  receipt: ContextCapsuleVerification
): string => {
  const lines = [
    `# Context Capsule verification: ${receipt.capsuleId}`,
    "",
    `- Content: ${receipt.contentStatus} (${receipt.contentCode})`,
    `- Ranking: ${receipt.rankingStatus} (${receipt.rankingCode})`,
    `- Fingerprints: ${receipt.fingerprintStatus}`,
    `- Fingerprint reasons: ${
      receipt.fingerprintReasons.length > 0
        ? receipt.fingerprintReasons.join(", ")
        : "none"
    }`,
    `- Current index fingerprint: \`${receipt.currentFingerprints.index}\``,
    "",
    "## Evidence",
    "",
    ...receipt.evidence.flatMap((item) => [
      `### ${item.uri}`,
      "",
      `- Evidence ID: \`${item.evidenceId}\``,
      `- Content: ${item.contentStatus} (${item.contentCode})`,
      `- Ranking: ${item.rankingStatus} (${item.rankingCode})`,
      `- Current rank: ${nullable(item.currentRetrievalRank)}`,
      `- Current source hash: ${
        item.currentSourceHash ? `\`${item.currentSourceHash}\`` : "unavailable"
      }`,
      `- Current mirror hash: ${
        item.currentMirrorHash ? `\`${item.currentMirrorHash}\`` : "unavailable"
      }`,
      `- Current passage hash: ${
        item.currentPassageHash
          ? `\`${item.currentPassageHash}\``
          : "unavailable"
      }`,
      "",
    ]),
  ];
  return lines.join("\n");
};
