import type { LoadedAgenticFixture } from "./fixture-db";
import type { ProjectAffinityCasesFixture } from "./project-affinity-contract";
import type {
  ProjectAffinityPromotionArtifact,
  ProjectAffinityStoreCallName,
} from "./project-affinity-promotion";

import { canonicalFingerprint, canonicalJson } from "./canonical";
import {
  bindProjectAffinityCases,
  loadProjectAffinityCases,
  projectAffinityBindingFingerprint,
} from "./project-affinity-contract";
import {
  evaluateProjectAffinityPromotion,
  PROJECT_AFFINITY_STORE_CALL_LIMITS,
} from "./project-affinity-promotion";
import { projectAffinityProvenance } from "./project-affinity-provenance";

const MULTILINGUAL_TASK_IDS = [
  "t012ab3c",
  "t123bc4d",
  "te8f901a",
  "tf901a2b",
] as const;

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const expectedAuxiliaryReceipts = () => [
  {
    caseId: "project_match",
    contributions: [0.03],
    requested: 0.03,
    applied: 0.03,
    finalScore: 0.53,
  },
  {
    caseId: "combined_exact_cap",
    contributions: [0.03, 0.05],
    requested: 0.08,
    applied: 0.08,
    finalScore: 0.58,
  },
  {
    caseId: "positive_over_cap",
    contributions: [0.08, 0.03],
    requested: 0.11,
    applied: 0.08,
    finalScore: 0.58,
  },
  {
    caseId: "negative_over_cap",
    contributions: [-0.08, -0.05],
    requested: -0.13,
    applied: -0.08,
    finalScore: 0.42,
  },
  {
    caseId: "overlap_no_stack",
    contributions: [0.03, 0.03],
    requested: 0.03,
    applied: 0.03,
    finalScore: 0.53,
  },
];

const expectedStructuralCaseIds = (
  cases: ProjectAffinityCasesFixture,
  taskIds: readonly string[]
): string[] => [
  ...cases.cases.flatMap((item) => [
    `${item.caseId}:disabled`,
    `${item.caseId}:enabled`,
  ]),
  ...taskIds.flatMap((taskId) => [
    `regression:${taskId}:disabled`,
    `regression:${taskId}:enabled`,
  ]),
  "filter:c015-vs-c115",
  "zero:absent",
  "zero:disabled",
  "zero:unavailable",
  "zero:untrusted_remote",
];

const structuralReceiptPassed = (
  receipt: ProjectAffinityPromotionArtifact["receipts"]["structural"][number]
): boolean =>
  Object.entries(PROJECT_AFFINITY_STORE_CALL_LIMITS).every(
    ([method, maximum]) =>
      receipt.calls[method as ProjectAffinityStoreCallName] <= maximum
  ) &&
  receipt.unexpectedCalls.length === 0 &&
  receipt.maxCandidateBound === receipt.outputLimit * 3 &&
  receipt.candidateRequested <= receipt.maxCandidateBound &&
  receipt.candidateReturned <= receipt.candidateRequested &&
  receipt.candidateReturned <= receipt.maxCandidateBound;

const deriveRegression = (
  artifact: ProjectAffinityPromotionArtifact,
  taskIds: readonly string[]
): {
  regression: ProjectAffinityPromotionArtifact["regression"];
  evidenceAccuracyLoss: number;
  evidenceCoverageLoss: number;
  multilingualLoss: number;
} => {
  const byIdentity = new Map(
    artifact.receipts.regression.map((receipt) => [
      `${receipt.taskId}:${receipt.lane}`,
      receipt,
    ])
  );
  let disabledAccuracy = 0;
  let enabledAccuracy = 0;
  let disabledCoverage = 0;
  let enabledCoverage = 0;
  let evidenceAccuracyLoss = 0;
  let evidenceCoverageLoss = 0;
  let multilingualDisabledCorrect = 0;
  let multilingualEnabledCorrect = 0;
  for (const taskId of taskIds) {
    const disabled = byIdentity.get(`${taskId}:disabled`)!;
    const enabled = byIdentity.get(`${taskId}:enabled`)!;
    if (disabled.requiredEvidenceRetained) {
      disabledAccuracy += 1;
      disabledCoverage += disabled.requiredEvidenceCount;
    }
    if (enabled.requiredEvidenceRetained) {
      enabledAccuracy += 1;
      enabledCoverage += enabled.requiredEvidenceCount;
    }
    if (!same(disabled.resultUris, enabled.resultUris)) {
      evidenceAccuracyLoss += 1;
    }
    if (
      disabled.requiredEvidenceRetained &&
      !enabled.requiredEvidenceRetained
    ) {
      evidenceCoverageLoss += 1;
    }
    if (MULTILINGUAL_TASK_IDS.includes(taskId as never)) {
      if (disabled.requiredEvidenceRetained) multilingualDisabledCorrect += 1;
      if (enabled.requiredEvidenceRetained) multilingualEnabledCorrect += 1;
    }
  }
  const multilingualLoss = Math.max(
    0,
    multilingualDisabledCorrect - multilingualEnabledCorrect
  );
  return {
    regression: {
      taskCount: 24,
      evidenceAccuracy: {
        disabled: disabledAccuracy,
        enabled: enabledAccuracy,
        loss: Math.max(0, disabledAccuracy - enabledAccuracy),
      },
      evidenceCoverage: {
        disabled: disabledCoverage,
        enabled: enabledCoverage,
        loss: Math.max(0, disabledCoverage - enabledCoverage),
      },
      multilingual: {
        taskIds: [...MULTILINGUAL_TASK_IDS],
        taskCount: 4,
        disabledCorrect: multilingualDisabledCorrect,
        enabledCorrect: multilingualEnabledCorrect,
        loss: multilingualLoss,
      },
    },
    evidenceAccuracyLoss,
    evidenceCoverageLoss,
    multilingualLoss,
  };
};

export const validateProjectAffinityPromotionArtifact = async (
  artifact: ProjectAffinityPromotionArtifact,
  fixture: LoadedAgenticFixture
): Promise<string[]> => {
  const failures: string[] = [];
  const cases = await loadProjectAffinityCases();
  const bindings = bindProjectAffinityCases(fixture, cases.fixture);
  const taskIds = [...fixture.tasks.keys()].sort();
  const expectedProvenance = await projectAffinityProvenance();
  if (!same(artifact.provenance, expectedProvenance)) {
    failures.push("artifact_provenance_mismatch");
  }
  const expectedFixture = {
    fixtureVersion: cases.fixture.fixtureVersion,
    fixtureFingerprint: cases.fingerprint,
    corpusFingerprint: fixture.snapshot.fingerprint,
    bindingFingerprint: projectAffinityBindingFingerprint(bindings),
    bindings,
  };
  if (!same(artifact.fixture, expectedFixture)) {
    failures.push("artifact_fixture_binding_mismatch");
  }

  const expectedTargetIdentities = cases.fixture.cases.map((item, index) => ({
    caseId: item.caseId,
    taskId: item.taskId,
    query: item.query,
    targetUri: bindings[index]!.requiredEvidence[0]!.uri,
  }));
  const targetIdentities = artifact.targets.map((target) => ({
    caseId: target.caseId,
    taskId: target.taskId,
    query: target.query,
    targetUri: target.targetUri,
  }));
  const targetRankingsValid = artifact.targets.every(
    (target) =>
      target.disabled.length === 2 &&
      target.enabled.length === 2 &&
      same(
        target.disabled.map((entry) => entry.rank),
        [1, 2]
      ) &&
      same(
        target.enabled.map((entry) => entry.rank),
        [1, 2]
      ) &&
      new Set(target.disabled.map((entry) => entry.uri)).size === 2 &&
      new Set(target.enabled.map((entry) => entry.uri)).size === 2
  );
  if (
    !same(targetIdentities, expectedTargetIdentities) ||
    !targetRankingsValid
  ) {
    failures.push("artifact_target_identity_invalid");
  }

  const expectedRegressionIdentities = taskIds.flatMap((taskId) => [
    `${taskId}:disabled`,
    `${taskId}:enabled`,
  ]);
  const regressionIdentities = artifact.receipts.regression.map(
    (receipt) => `${receipt.taskId}:${receipt.lane}`
  );
  if (
    taskIds.length !== 24 ||
    !same(regressionIdentities, expectedRegressionIdentities)
  ) {
    failures.push("artifact_regression_identity_invalid");
  }

  const structuralIds = artifact.receipts.structural.map(
    (receipt) => receipt.caseId
  );
  const structuralOutcomes = artifact.receipts.structural.map(
    structuralReceiptPassed
  );
  if (
    !same(structuralIds, expectedStructuralCaseIds(cases.fixture, taskIds)) ||
    artifact.receipts.structural.some(
      (receipt, index) => receipt.passed !== structuralOutcomes[index]
    )
  ) {
    failures.push("artifact_structural_receipt_invalid");
  }

  const zeroLanes = artifact.receipts.zeroLanes;
  const zeroLanesExact =
    same(
      zeroLanes.map((receipt) => receipt.lane),
      ["absent", "disabled", "unavailable", "untrusted_remote"]
    ) &&
    zeroLanes.every(
      (receipt) =>
        receipt.equal && receipt.baselineHash === receipt.candidateHash
    );
  if (!zeroLanesExact) failures.push("artifact_zero_receipt_invalid");

  const auxiliaryReceiptsValid = same(
    artifact.receipts.auxiliary,
    expectedAuxiliaryReceipts()
  );
  if (!auxiliaryReceiptsValid) {
    failures.push("artifact_auxiliary_receipt_invalid");
  }

  const filter = artifact.receipts.filter;
  const firstCase = cases.fixture.cases[0]!;
  const filterHard =
    filter.caseId === firstCase.caseId &&
    filter.targetCollection === firstCase.targetCollection &&
    filter.distractorCollection === firstCase.distractorCollection &&
    filter.requiredEvidenceRetained &&
    filter.resultUris.every((uri) =>
      uri.startsWith(`gno://${filter.targetCollection}/`)
    ) &&
    filter.resultUris.every(
      (uri) => !uri.startsWith(`gno://${filter.distractorCollection}/`)
    );
  if (!filterHard) failures.push("artifact_filter_receipt_invalid");

  if (
    !failures.includes("artifact_regression_identity_invalid") &&
    !failures.includes("artifact_target_identity_invalid")
  ) {
    const derived = deriveRegression(artifact, taskIds);
    if (!same(artifact.regression, derived.regression)) {
      failures.push("artifact_regression_summary_mismatch");
    }
    const {
      canonicalFingerprint: _fingerprint,
      gates: _gates,
      ...base
    } = artifact;
    const expected = evaluateProjectAffinityPromotion(
      { ...base, regression: derived.regression },
      {
        evidenceAccuracyLoss: derived.evidenceAccuracyLoss,
        evidenceCoverageLoss: derived.evidenceCoverageLoss,
        multilingualLoss: derived.multilingualLoss,
        filterHard,
        zeroLanesExact,
        auxiliaryReceiptsValid,
        structuralCallsBounded: structuralOutcomes.every(Boolean),
      }
    );
    if (!same(artifact.gates, expected.gates)) {
      failures.push("artifact_gate_summary_mismatch");
    }
  }

  const { canonicalFingerprint: _fingerprint, ...withoutFingerprint } =
    artifact;
  if (
    canonicalFingerprint(withoutFingerprint) !== artifact.canonicalFingerprint
  ) {
    failures.push("artifact_fingerprint_mismatch");
  }
  return failures;
};
