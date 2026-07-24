import type { SearchResult } from "../../src/pipeline/types";
import type { ProjectAffinityPromotionArtifact } from "./project-affinity-promotion";

import { fingerprintContentTypeRules } from "../../src/config/content-types";
import { applyContentTypeBoost } from "../../src/pipeline/content-type-boost";
import { canonicalFingerprint } from "./canonical";

export interface ContentTypeBoostPromotionReceipt {
  taskId: string;
  requiredEvidenceCount: number;
  requiredEvidenceRetained: boolean;
  baselineUris: string[];
  candidateUris: string[];
  baselineHash: string;
  candidateHash: string;
  equal: boolean;
}

export interface ContentTypeBoostPromotionArtifact {
  schemaVersion: "1.0";
  benchmarkId: "content-type-boost-promotion@1";
  canonicalFingerprint: string;
  source: {
    benchmarkId: "project-affinity-promotion@1";
    canonicalFingerprint: string;
    taskCount: 24;
  };
  rulesFingerprint: string;
  methodology: string[];
  limitations: string[];
  receipts: ContentTypeBoostPromotionReceipt[];
  metrics: {
    taskCount: 24;
    evidenceAccuracy: { baseline: number; candidate: number; loss: number };
    evidenceCoverage: { baseline: number; candidate: number; loss: number };
  };
  gates: {
    passed: boolean;
    failures: string[];
    exactNoOpReceipts: boolean;
    evidenceAccuracyLoss: number;
    evidenceCoverageLoss: number;
  };
}

const syntheticResult = (uri: string, rank: number): SearchResult => {
  const slash = uri.indexOf("/", "gno://".length);
  const relPath = slash < 0 ? uri : uri.slice(slash + 1);
  return {
    docid: `#fn97-${rank}`,
    score: Math.max(0, 1 - (rank - 1) * 0.01),
    uri,
    snippet: "fn-97 ranking receipt",
    source: {
      relPath,
      mime: "text/markdown",
      ext: ".md",
    },
  };
};

const projectNoOpCandidate = (uris: readonly string[]): string[] =>
  uris.map((uri, index) => {
    const result = syntheticResult(uri, index + 1);
    const slash = uri.indexOf("/", "gno://".length);
    const collection =
      slash < 0 ? "unknown" : uri.slice("gno://".length, slash);
    return applyContentTypeBoost(result, collection, [], undefined).uri;
  });

export const buildContentTypeBoostPromotion = (
  source: ProjectAffinityPromotionArtifact
): ContentTypeBoostPromotionArtifact => {
  const disabled = source.receipts.regression.filter(
    (receipt) => receipt.lane === "disabled"
  );
  const receipts = disabled.map((receipt) => {
    const baselineUris = [...receipt.resultUris];
    const candidateUris = projectNoOpCandidate(baselineUris);
    const baselineProjection = {
      resultUris: baselineUris,
      requiredEvidenceCount: receipt.requiredEvidenceCount,
      requiredEvidenceRetained: receipt.requiredEvidenceRetained,
    };
    const candidateProjection = {
      ...baselineProjection,
      resultUris: candidateUris,
    };
    const baselineHash = canonicalFingerprint(baselineProjection);
    const candidateHash = canonicalFingerprint(candidateProjection);
    return {
      taskId: receipt.taskId,
      requiredEvidenceCount: receipt.requiredEvidenceCount,
      requiredEvidenceRetained: receipt.requiredEvidenceRetained,
      baselineUris,
      candidateUris,
      baselineHash,
      candidateHash,
      equal: baselineHash === candidateHash,
    };
  });
  const baselineAccuracy = receipts.filter(
    (receipt) => receipt.requiredEvidenceRetained
  ).length;
  const baselineCoverage = receipts.reduce(
    (sum, receipt) =>
      sum +
      (receipt.requiredEvidenceRetained ? receipt.requiredEvidenceCount : 0),
    0
  );
  const candidateAccuracy = receipts.filter(
    (receipt) => receipt.equal && receipt.requiredEvidenceRetained
  ).length;
  const candidateCoverage = receipts.reduce(
    (sum, receipt) =>
      sum +
      (receipt.equal && receipt.requiredEvidenceRetained
        ? receipt.requiredEvidenceCount
        : 0),
    0
  );
  const evidenceAccuracyLoss = Math.max(
    0,
    baselineAccuracy - candidateAccuracy
  );
  const evidenceCoverageLoss = Math.max(
    0,
    baselineCoverage - candidateCoverage
  );
  const exactNoOpReceipts =
    receipts.length === 24 && receipts.every((receipt) => receipt.equal);
  const failures = [
    ...(exactNoOpReceipts ? [] : ["fn97_noop_receipt_mismatch"]),
    ...(evidenceAccuracyLoss === 0 ? [] : ["evidence_accuracy_regression"]),
    ...(evidenceCoverageLoss === 0 ? [] : ["evidence_coverage_regression"]),
  ];
  const withoutFingerprint = {
    schemaVersion: "1.0" as const,
    benchmarkId: "content-type-boost-promotion@1" as const,
    source: {
      benchmarkId: "project-affinity-promotion@1" as const,
      canonicalFingerprint: source.canonicalFingerprint,
      taskCount: 24 as const,
    },
    rulesFingerprint: fingerprintContentTypeRules([]),
    methodology: [
      "The authoritative fn-97 24-task production retrieval receipts are replayed through the shipped content-type ranking seam with no configured rules.",
      "Each before/after receipt freezes ordered result URIs and required-evidence retention; all hashes must remain byte-identical.",
      "Active positive, negative, tie, keyword-stuffing, filter, conflicting-metadata, and affinity-composition behavior is gated separately by deterministic adversarial tests.",
    ],
    limitations: [
      "The fn-97 corpus has no configured content-type rules, so this lane proves backward-compatible zero-regression behavior rather than active-rule quality gains.",
      "The active-rule suite uses controlled scores to isolate the bounded ranking contract; it does not claim general retrieval superiority.",
      "Egress policy is not yet an available retrieval capability; no egress-bypass claim is made.",
    ],
    receipts,
    metrics: {
      taskCount: 24 as const,
      evidenceAccuracy: {
        baseline: baselineAccuracy,
        candidate: candidateAccuracy,
        loss: evidenceAccuracyLoss,
      },
      evidenceCoverage: {
        baseline: baselineCoverage,
        candidate: candidateCoverage,
        loss: evidenceCoverageLoss,
      },
    },
    gates: {
      passed: failures.length === 0,
      failures,
      exactNoOpReceipts,
      evidenceAccuracyLoss,
      evidenceCoverageLoss,
    },
  };
  return {
    ...withoutFingerprint,
    canonicalFingerprint: canonicalFingerprint(withoutFingerprint),
  };
};

export const renderContentTypeBoostPromotionMarkdown = (
  artifact: ContentTypeBoostPromotionArtifact
): string =>
  `${[
    "# Content-type search-boost promotion",
    "",
    `Verdict: **${artifact.gates.passed ? "PASS" : "FAIL"}**`,
    `fn-97 receipts: ${artifact.receipts.length}`,
    `Exact before/after receipts: ${artifact.gates.exactNoOpReceipts ? "PASS" : "FAIL"}`,
    `Evidence accuracy (before/after/loss): ${artifact.metrics.evidenceAccuracy.baseline}/${artifact.metrics.evidenceAccuracy.candidate}/${artifact.metrics.evidenceAccuracy.loss}`,
    `Evidence coverage (before/after/loss): ${artifact.metrics.evidenceCoverage.baseline}/${artifact.metrics.evidenceCoverage.candidate}/${artifact.metrics.evidenceCoverage.loss}`,
    `Failures: ${artifact.gates.failures.join(", ") || "none"}`,
    "",
    "## Methodology",
    "",
    ...artifact.methodology.map((item) => `- ${item}`),
    "",
    "## Limitations",
    "",
    ...artifact.limitations.map((item) => `- ${item}`),
  ].join("\n")}\n`;
