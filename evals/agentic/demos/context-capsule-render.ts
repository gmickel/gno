import type { ContextCapsuleDemoArtifact } from "./context-capsule-types";

import { canonicalJson } from "../canonical";

const metric = (value: number | null): string =>
  value === null ? "unavailable" : String(value);

export const renderContextCapsuleDemoMarkdown = (
  artifact: ContextCapsuleDemoArtifact
): string => {
  const tableRows = artifact.lanes.map(({ label, metrics }) => [
    label,
    metrics.stopOutcome,
    String(metrics.success),
    String(metrics.substantiveClaimEvidenceCoverage),
    String(metrics.agentCalls),
    String(metrics.modelVisibleUtf8Bytes),
    metric(metrics.measuredTokens),
    metric(metrics.endToEnd.valueMs),
  ]);
  const headers = [
    "Lane",
    "Stop outcome",
    "Success",
    "Evidence coverage",
    "Agent calls",
    "Context bytes",
    "Tokens",
    "Cold end-to-end ms",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index]!.length))
  );
  const formatRow = (row: readonly string[]): string =>
    `| ${row
      .map((value, index) =>
        index < 2
          ? value.padEnd(widths[index]!)
          : value.padStart(widths[index]!)
      )
      .join(" | ")} |`;
  const separator = widths.map((width, index) =>
    index < 2 ? "-".repeat(width) : `${"-".repeat(width - 1)}:`
  );
  const rows = [
    formatRow(headers),
    formatRow(separator),
    ...tableRows.map(formatRow),
  ].join("\n");
  const evidence = artifact.frozenInput.expected.evidence[0];
  const verified = artifact.verifiedAsk.metrics;
  return `# Context Capsule: one frozen agent outcome

Canonical fingerprint: \`${artifact.canonicalFingerprint}\`

This is one controlled exact-identifier task, not a general superiority claim.
Selection disclosure: this is the sole cold-lifecycle current-GNO failure / Capsule success case among the authoritative ${artifact.sourceBenchmark.selection.cohortTaskCount}-task cohort.
Prototype boundary: the Capsule lane is an evaluation-only lexical prototype; its latency is not the shipped Context Capsule path and is not product-equivalent.

## Frozen task

> ${artifact.frozenInput.task.brief.goal}

Expected answer: \`${String((artifact.frozenInput.expected.value as { value?: unknown }).value)}\`

Exact evidence: \`${evidence?.uri}:${evidence?.startLine}-${evidence?.endLine}\`  
Source SHA-256: \`${evidence?.sourceHash}\`  
Span SHA-256: \`${evidence?.spanHash}\`

## Measured outcome

${rows}

Tokens are unavailable because this run did not use one pinned comparable tokenizer.
Latency is the single matching cold-lifecycle observation on the recorded environment, not shipped-product latency.

## Methodology

${artifact.methodology.map((item) => `- ${item}`).join("\n")}

Variance: ${artifact.variance.unavailableReason}

## Capsule retrieval contract

- Request: \`${canonicalJson(artifact.capsuleRetrieval.request)}\`
- Effective index: \`${artifact.capsuleRetrieval.effectiveIndexFingerprint}\`
- Fallbacks: \`${canonicalJson(artifact.capsuleRetrieval.fallbacks)}\`
- Capability states and the complete normalized payload are retained in the JSON artifact.

## Separate Verified Ask answer-enforcement proof

This is not a retrieval lane and its answer metrics are not retrieval metrics.

- Frozen paired cohort: ${artifact.verifiedAsk.pairCount}
- Excluded missing-evidence tasks: ${artifact.verifiedAsk.excludedTasks.map(({ taskId }) => taskId).join(", ")}
- Answer accuracy, raw/verified: ${verified.baselineAnswerAccuracy} / ${verified.candidateAnswerAccuracy}
- Unsupported substantive claims, raw/verified: ${verified.baselineUnsupportedSubstantiveClaims} / ${verified.candidateUnsupportedSubstantiveClaims}
- Unsupported-claim reduction: ${verified.unsupportedSubstantiveClaimReduction}

## Limitations

${artifact.limitations.map((item) => `- ${item}`).join("\n")}
`;
};
