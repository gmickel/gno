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

const cohortRows = (report: BenchmarkReport): string[] => {
  const rows: string[] = [];
  const adapters = [
    ...new Set(report.receipts.map((receipt) => receipt.canonical.adapterId)),
  ].sort();
  for (const adapterId of adapters) {
    for (const lifecycle of ["cold", "warm"] as const) {
      const indexes = report.receipts.flatMap((receipt, index) =>
        receipt.canonical.adapterId === adapterId &&
        receipt.canonical.lifecycle === lifecycle
          ? [index]
          : []
      );
      if (indexes.length === 0) continue;
      const scores = indexes.map((index) => report.scores[index]!);
      const receipts = indexes.map((index) => report.receipts[index]!);
      rows.push(
        `| ${adapterId} | ${lifecycle} | ${indexes.length} | ${scores.filter((score) => score.score.scored).length} | ${scores.filter((score) => score.score.success === 1).length} | ${scores.filter((score) => !score.score.scored).length} | ${receipts.reduce((sum, receipt) => sum + receipt.canonical.agentCalls, 0)} | ${receipts.reduce((sum, receipt) => sum + receipt.canonical.backendInvocations, 0)} | ${receipts.reduce((sum, receipt) => sum + receipt.canonical.modelVisibleUtf8Bytes, 0)} |`
      );
    }
  }
  return rows;
};

const timingCell = (
  report: BenchmarkReport,
  indexes: readonly number[],
  key: keyof BenchmarkReport["receipts"][number]["observations"]["timings"]
): string => {
  const timings = indexes.map(
    (index) => report.receipts[index]!.observations.timings[key]
  );
  const measured = timings.flatMap((timing) =>
    timing.valueMs === null ? [] : [timing.valueMs]
  );
  const reasons = [
    ...new Set(
      timings.flatMap((timing) =>
        timing.unavailableReason ? [timing.unavailableReason] : []
      )
    ),
  ];
  const total = measured.reduce((sum, value) => sum + value, 0).toFixed(3);
  return `${total} ms / null ${timings.length - measured.length}${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}`;
};

const timingRows = (report: BenchmarkReport): string[] => {
  const groups = new Map<string, number[]>();
  for (const [index, receipt] of report.receipts.entries()) {
    const key = `${receipt.canonical.adapterId}/${receipt.canonical.lifecycle}`;
    const indexes = groups.get(key) ?? [];
    indexes.push(index);
    groups.set(key, indexes);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(
      ([key, indexes]) =>
        `| ${key} | ${timingCell(report, indexes, "startup")} | ${timingCell(report, indexes, "modelLoad")} | ${timingCell(report, indexes, "tool")} | ${timingCell(report, indexes, "driver")} | ${timingCell(report, indexes, "endToEnd")} |`
    );
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
      `- \`${preparation.adapterId}\`: \`${preparation.indexFingerprint}\` (corpus \`${preparation.corpusFingerprint}\`, preparation ${preparation.observations.preparationMs === null ? `null — ${preparation.observations.preparationUnavailableReason}` : `${preparation.observations.preparationMs} ms`})`
    );
  }
  lines.push(
    "",
    "## Cohort accounting",
    "",
    "| Adapter | Lifecycle | Attempted | Scored | Success | Excluded | agentCalls | backendInvocations | Model-visible bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...cohortRows(report),
    "",
    "## Lifecycle timings",
    "",
    "Measured totals and explicit unavailable counts/reasons; milliseconds.",
    "",
    "| Adapter/lifecycle | Startup | Model load | Tool | Driver | End-to-end |",
    "| --- | --- | --- | --- | --- | --- |",
    ...timingRows(report),
    "",
    "## Capsule replay hashes",
    "",
    "| Task/trial/lifecycle | First SHA-256 | Replay SHA-256 | Equal |",
    "| --- | --- | --- | --- |"
  );
  for (const replay of report.capsuleReplays) {
    lines.push(
      `| ${replay.taskId}/${replay.trialId}/${replay.lifecycle} | \`${replay.first.sha256}\` | \`${replay.second.sha256}\` | ${replay.first.sha256 === replay.second.sha256 && replay.first.canonicalJson === replay.second.canonicalJson ? "yes" : "no"} |`
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
