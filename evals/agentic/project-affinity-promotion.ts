import type { ProjectAffinityIdentityBinding } from "./project-affinity-contract";
import type { ProjectAffinityProvenance } from "./project-affinity-provenance";

import { canonicalFingerprint } from "./canonical";

export const PROJECT_AFFINITY_STORE_CALL_LIMITS = {
  getChunksBatch: 1,
  getCollections: 1,
  getContextGeneration: 2,
  getContexts: 1,
  getDocumentsByMirrorHashes: 1,
  getTagsBatch: 0,
  listDocuments: 0,
} as const;

export type ProjectAffinityStoreCallName =
  keyof typeof PROJECT_AFFINITY_STORE_CALL_LIMITS;

export type ProjectAffinityStoreCallMap = Record<
  ProjectAffinityStoreCallName,
  number
>;

export interface ProjectAffinityRankedEntry {
  rank: number;
  uri: string;
  score: number;
  baseScore: number;
  matched: boolean;
  affinityRequested: number;
  affinityApplied: number;
  collectionAlias: string | null;
  rootAlias: string | null;
}

export interface ProjectAffinityTargetReceipt {
  caseId: string;
  taskId: string;
  query: string;
  targetUri: string;
  requiredEvidenceRetained: boolean;
  disabled: ProjectAffinityRankedEntry[];
  enabled: ProjectAffinityRankedEntry[];
}

export interface ProjectAffinityPromotionArtifact {
  schemaVersion: "1.0";
  benchmarkId: "project-affinity-promotion@1";
  canonicalFingerprint: string;
  provenance: ProjectAffinityProvenance;
  fixture: {
    fixtureVersion: string;
    fixtureFingerprint: string;
    corpusFingerprint: string;
    bindingFingerprint: string;
    bindings: ProjectAffinityIdentityBinding[];
  };
  methodology: string[];
  limitations: string[];
  targets: ProjectAffinityTargetReceipt[];
  receipts: {
    auxiliary: Array<{
      caseId: string;
      contributions: number[];
      requested: number;
      applied: number;
      finalScore: number;
    }>;
    zeroLanes: Array<{
      lane: "absent" | "disabled" | "unavailable" | "untrusted_remote";
      baselineHash: string;
      candidateHash: string;
      equal: boolean;
    }>;
    filter: {
      caseId: string;
      targetCollection: string;
      distractorCollection: string;
      resultUris: string[];
      requiredEvidenceRetained: boolean;
    };
    regression: Array<{
      taskId: string;
      lane: "disabled" | "enabled";
      resultUris: string[];
      requiredEvidenceCount: number;
      requiredEvidenceRetained: boolean;
    }>;
    structural: Array<{
      caseId: string;
      calls: ProjectAffinityStoreCallMap;
      unexpectedCalls: Array<{ method: string; count: number }>;
      candidateRequested: number;
      candidateReturned: number;
      outputLimit: number;
      maxCandidateBound: number;
      passed: boolean;
    }>;
  };
  regression: {
    taskCount: 24;
    evidenceAccuracy: { disabled: number; enabled: number; loss: number };
    evidenceCoverage: { disabled: number; enabled: number; loss: number };
    multilingual: {
      taskIds: string[];
      taskCount: 4;
      disabledCorrect: number;
      enabledCorrect: number;
      loss: number;
    };
  };
  gates: {
    passed: boolean;
    failures: string[];
    targetCorrectTop1: { disabled: number; enabled: number; required: 2 };
    evidenceAccuracyLoss: number;
    evidenceCoverageLoss: number;
    multilingualLoss: number;
    filterHard: boolean;
    zeroLanesExact: boolean;
    auxiliaryReceiptsValid: boolean;
    structuralCallsBounded: boolean;
  };
}

export const evaluateProjectAffinityPromotion = (
  artifact: Omit<
    ProjectAffinityPromotionArtifact,
    "canonicalFingerprint" | "gates"
  >,
  supporting: Omit<
    ProjectAffinityPromotionArtifact["gates"],
    "passed" | "failures" | "targetCorrectTop1"
  >
): ProjectAffinityPromotionArtifact => {
  const disabled = artifact.targets.filter(
    (receipt) => receipt.disabled[0]?.uri === receipt.targetUri
  ).length;
  const enabled = artifact.targets.filter(
    (receipt) => receipt.enabled[0]?.uri === receipt.targetUri
  ).length;
  const failures: string[] = [];
  if (artifact.targets.length !== 2) failures.push("target_pair_count");
  if (!(enabled > disabled && enabled === 2))
    failures.push("target_top1_improvement");
  if (artifact.targets.some((receipt) => !receipt.requiredEvidenceRetained))
    failures.push("target_required_evidence");
  if (supporting.evidenceAccuracyLoss !== 0)
    failures.push("evidence_accuracy_regression");
  if (supporting.evidenceCoverageLoss !== 0)
    failures.push("evidence_coverage_regression");
  if (supporting.multilingualLoss !== 0)
    failures.push("multilingual_regression");
  if (!supporting.filterHard) failures.push("hard_filter_bypass");
  if (!supporting.zeroLanesExact) failures.push("zero_lane_mismatch");
  if (!supporting.auxiliaryReceiptsValid)
    failures.push("auxiliary_receipt_invalid");
  if (!supporting.structuralCallsBounded)
    failures.push("structural_call_bound_exceeded");
  const withoutFingerprint = {
    ...artifact,
    gates: {
      passed: failures.length === 0,
      failures,
      targetCorrectTop1: { disabled, enabled, required: 2 as const },
      ...supporting,
    },
  };
  return {
    ...withoutFingerprint,
    canonicalFingerprint: canonicalFingerprint(withoutFingerprint),
  };
};

export const renderProjectAffinityPromotionMarkdown = (
  artifact: ProjectAffinityPromotionArtifact
): string =>
  `${[
    "# Project-affinity promotion",
    "",
    `Verdict: **${artifact.gates.passed ? "PASS" : "FAIL"}**`,
    `Target correct top-1 (disabled/enabled): ${artifact.gates.targetCorrectTop1.disabled}/${artifact.gates.targetCorrectTop1.enabled}`,
    `Evidence accuracy/coverage loss: ${artifact.gates.evidenceAccuracyLoss}/${artifact.gates.evidenceCoverageLoss}`,
    `Multilingual loss: ${artifact.gates.multilingualLoss}`,
    `Hard filter: ${artifact.gates.filterHard ? "PASS" : "FAIL"}`,
    `Zero lanes: ${artifact.gates.zeroLanesExact ? "PASS" : "FAIL"}`,
    `Structural calls: ${artifact.gates.structuralCallsBounded ? "PASS" : "FAIL"}`,
    `Regression tasks: ${artifact.regression.taskCount}; evidence accuracy ${artifact.regression.evidenceAccuracy.disabled}/${artifact.regression.evidenceAccuracy.enabled}; coverage ${artifact.regression.evidenceCoverage.disabled}/${artifact.regression.evidenceCoverage.enabled}`,
    `Multilingual: ${artifact.regression.multilingual.disabledCorrect}/${artifact.regression.multilingual.enabledCorrect} across ${artifact.regression.multilingual.taskCount}`,
    `Failures: ${artifact.gates.failures.join(", ") || "none"}`,
    "",
    "## Methodology",
    "",
    ...artifact.methodology.map((item) => `- ${item}`),
    "",
    "## Raw bounded receipts",
    "",
    ...artifact.receipts.auxiliary.map(
      (receipt) =>
        `- Auxiliary \`${receipt.caseId}\`: requested ${receipt.requested}, applied ${receipt.applied}, final ${receipt.finalScore}`
    ),
    ...artifact.receipts.zeroLanes.map(
      (receipt) =>
        `- Zero \`${receipt.lane}\`: ${receipt.equal ? "equal" : "different"} (\`${receipt.baselineHash}\` / \`${receipt.candidateHash}\`)`
    ),
    `- Filter \`${artifact.receipts.filter.caseId}\`: ${artifact.receipts.filter.requiredEvidenceRetained ? "required evidence retained" : "required evidence missing"}; ${artifact.receipts.filter.resultUris.length} result(s)`,
    `- Regression: ${artifact.receipts.regression.length} disabled/enabled task receipts`,
    ...artifact.receipts.structural.map(
      (receipt) =>
        `- Structural \`${receipt.caseId}\`: candidates ${receipt.candidateReturned}/${receipt.candidateRequested}, limit ${receipt.outputLimit}, bound ${receipt.maxCandidateBound}, calls docs/chunks/collections/contexts/generation/tags/list ${receipt.calls.getDocumentsByMirrorHashes}/${receipt.calls.getChunksBatch}/${receipt.calls.getCollections}/${receipt.calls.getContexts}/${receipt.calls.getContextGeneration}/${receipt.calls.getTagsBatch}/${receipt.calls.listDocuments}; unexpected ${receipt.unexpectedCalls.length}`
    ),
    "",
    "## Limitations",
    "",
    ...artifact.limitations.map((item) => `- ${item}`),
  ].join("\n")}\n`;
