import type { BenchmarkReport } from "./types";

import { canonicalJson } from "./canonical";
import { benchmarkCanonicalProjection } from "./report";

const stablePrettyJson = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

const identity = (report: BenchmarkReport, index: number) => {
  const receipt = report.receipts[index];
  if (!receipt) throw new Error("Report receipt disappeared");
  return {
    taskId: receipt.canonical.taskId,
    adapterId: receipt.canonical.adapterId,
    trialId: receipt.canonical.trialId,
    seed: receipt.canonical.seed,
    lifecycle: receipt.canonical.lifecycle,
    agentId: receipt.canonical.agentId,
  };
};

export const renderBenchmarkMarkdown = (report: BenchmarkReport): string => {
  const promotion = report.promotion;
  const adapters = [
    ...new Set(report.receipts.map((receipt) => receipt.canonical.adapterId)),
  ].sort();
  const successful = report.scores.filter(
    (score) => score.score.scored && score.score.success === 1
  ).length;
  const lines = [
    `# Agentic Retrieval Benchmark — ${report.environment.agentId}`,
    "",
    `Canonical fingerprint: \`${report.canonicalFingerprint}\``,
    `Fixture: \`${report.environment.fixtureVersion}\` / \`${report.fixtureFingerprint}\``,
    `Adapters: ${adapters.map((adapter) => `\`${adapter}\``).join(", ")}`,
    `Attempted/scored/successful: ${report.attemptedPairs}/${report.scoredPairs}/${successful}`,
    `Excluded: ${report.exclusions.length}`,
    "",
    "## Capsule promotion",
    "",
  ];
  if (!promotion) {
    lines.push(
      "Not evaluated: report does not contain both gno-mcp and capsule."
    );
  } else {
    lines.push(
      `Verdict: **${promotion.passed ? "PASS" : "FAIL"}**`,
      `Pairs: ${promotion.pairCount}`,
      `Baseline/Capsule success: ${String(promotion.metrics.baselineSuccessRate)} / ${String(promotion.metrics.candidateSuccessRate)}`,
      `Agent-call reduction: ${String(promotion.metrics.agentCallReduction)}`,
      `Context-byte reduction: ${String(promotion.metrics.contextByteReduction)}`,
      `Claim linkage: ${String(promotion.metrics.claimLinkageRate)}`,
      `Failures: ${promotion.failures.length > 0 ? promotion.failures.join(", ") : "none"}`
    );
  }
  lines.push("", "## Adapter-native indexes", "");
  for (const preparation of report.preparations) {
    lines.push(
      `- \`${preparation.adapterId}\`: \`${preparation.indexFingerprint}\` (corpus \`${preparation.corpusFingerprint}\`)`
    );
  }
  lines.push("", "## Methodology", "");
  for (const item of report.methodology) lines.push(`- ${item}`);
  lines.push("", "## Limitations", "");
  for (const item of report.limitations) lines.push(`- ${item}`);
  if (report.exclusions.length > 0) {
    lines.push("", "## Exclusions", "");
    for (const exclusion of report.exclusions) {
      lines.push(
        `- \`${exclusion.adapterId}/${exclusion.taskId}/${exclusion.trialId}/${exclusion.lifecycle}\`: ${exclusion.failureClass} — ${exclusion.reason}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

export interface BenchmarkArtifacts {
  reportJson: string;
  canonicalJson: string;
  observationsJson: string;
  reportMarkdown: string;
}

export const createBenchmarkArtifacts = (
  report: BenchmarkReport
): BenchmarkArtifacts => {
  const projectedReport: BenchmarkReport = {
    ...report,
    receipts: report.receipts.map((receipt) => ({
      ...receipt,
      observations: {
        ...receipt.observations,
        tempPaths: receipt.observations.tempPaths.map(() => "<temp>"),
      },
    })),
  };
  const { canonicalFingerprint: _fingerprint, ...withoutFingerprint } =
    projectedReport;
  return {
    reportJson: stablePrettyJson(projectedReport),
    canonicalJson: stablePrettyJson({
      canonicalFingerprint: projectedReport.canonicalFingerprint,
      projection: benchmarkCanonicalProjection(withoutFingerprint),
    }),
    observationsJson: stablePrettyJson({
      environment: projectedReport.environment,
      preparations: projectedReport.preparations.map((preparation) => ({
        adapterId: preparation.adapterId,
        observations: preparation.observations,
      })),
      receipts: projectedReport.receipts.map((receipt, index) => ({
        ...identity(projectedReport, index),
        observations: receipt.observations,
      })),
    }),
    reportMarkdown: renderBenchmarkMarkdown(projectedReport),
  };
};
