import type { ProjectAffinityScoringInput } from "../../src/pipeline/project-affinity";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { ProjectAffinityPromotionArtifact } from "./project-affinity-promotion";
import type { CallObservation } from "./project-affinity-runtime";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import {
  resolveCliProjectAffinity,
  resolveRemoteProjectAffinity,
} from "../../src/core/project-affinity-surface";
import {
  applyAuxiliaryScore,
  scoreProjectAffinity,
} from "../../src/pipeline/project-affinity";
import { SqliteAdapter } from "../../src/store";
import { canonicalJson, sha256Bytes } from "./canonical";
import {
  cleanupNativeIndexPreparation,
  prepareGnoNativeIndex,
} from "./fixture-db";
import {
  bindProjectAffinityCases,
  loadProjectAffinityCases,
  projectAffinityBindingFingerprint,
} from "./project-affinity-contract";
import { evaluateProjectAffinityPromotion } from "./project-affinity-promotion";
import {
  corpusVectorCandidates,
  exactSearchProjection,
  isStructurallyBounded,
  projectAffinityEntries,
  projectAffinityEvalConfig,
  requiredEvidenceRetained,
  runProjectAffinitySearch,
} from "./project-affinity-runtime";

interface LabeledObservation {
  caseId: string;
  observation: CallObservation;
}

const structuralReceipts = (
  observations: LabeledObservation[]
): ProjectAffinityPromotionArtifact["receipts"]["structural"] =>
  observations.map(({ caseId, observation }) => ({
    caseId,
    calls: {
      getDocumentsByMirrorHashes:
        observation.calls.getDocumentsByMirrorHashes ?? 0,
      getChunksBatch: observation.calls.getChunksBatch ?? 0,
      getCollections: observation.calls.getCollections ?? 0,
      listDocuments: observation.calls.listDocuments ?? 0,
    },
    candidateRequested: observation.requestedCount,
    candidateReturned: observation.candidateCount,
    outputLimit: observation.outputLimit,
    maxCandidateBound: observation.outputLimit * 3,
    passed: isStructurallyBounded(observation),
  }));

const auxiliaryReceipts =
  (): ProjectAffinityPromotionArtifact["receipts"]["auxiliary"] => {
    const stable = (value: number): number => Number(value.toFixed(12));
    const overlap = scoreProjectAffinity(0.5, "project", {
      resolution: {
        matches: ["root_a", "root_b"].map((rootAlias) => ({
          collection: "project",
          collectionAlias: "collection_overlap",
          distance: 0,
          relation: "exact" as const,
          rootAlias,
          source: "cli_explicit" as const,
        })),
        roots: [],
      },
    });
    return [
      {
        caseId: "project_match",
        contributions: [0.03],
        ...applyAuxiliaryScore(0.5, [0.03]),
      },
      {
        caseId: "combined_exact_cap",
        contributions: [0.03, 0.05],
        ...applyAuxiliaryScore(0.5, [0.03, 0.05]),
      },
      {
        caseId: "positive_over_cap",
        contributions: [0.08, 0.03],
        ...applyAuxiliaryScore(0.5, [0.08, 0.03]),
      },
      {
        caseId: "negative_over_cap",
        contributions: [-0.08, -0.05],
        ...applyAuxiliaryScore(0.5, [-0.08, -0.05]),
      },
      {
        caseId: "overlap_no_stack",
        contributions: [0.03, 0.03],
        requested: overlap.affinityRequested,
        applied: overlap.affinityApplied,
        finalScore: overlap.finalScore,
      },
    ].map((receipt) => ({
      ...receipt,
      requested: stable(receipt.requested),
      applied: stable(receipt.applied),
      finalScore: stable(receipt.finalScore),
    }));
  };

export const runProjectAffinityOutcomeBenchmark = async (
  fixture: LoadedAgenticFixture
): Promise<ProjectAffinityPromotionArtifact> => {
  const cases = await loadProjectAffinityCases();
  const bindings = bindProjectAffinityCases(fixture, cases.fixture);
  const native = await prepareGnoNativeIndex(fixture.snapshot);
  const store = new SqliteAdapter();
  try {
    const opened = await store.open(native.dbPath, DEFAULT_FTS_TOKENIZER);
    if (!opened.ok) throw new Error(opened.error.message);
    const documents = await store.listDocuments();
    if (!documents.ok) throw new Error(documents.error.message);
    const byUri = new Map(
      documents.value.map((document) => [document.uri, document])
    );
    const config = projectAffinityEvalConfig(fixture, native.rootPath);
    const targets: ProjectAffinityPromotionArtifact["targets"] = [];
    const observations: LabeledObservation[] = [];

    for (const item of cases.fixture.cases) {
      const binding = bindings.find((entry) => entry.caseId === item.caseId)!;
      const targetUri = binding.requiredEvidence[0]!.uri;
      const distractorSource = binding.corpus.find(
        (entry) => entry.collection === item.distractorCollection
      )!;
      const distractorUri = `gno://${distractorSource.collection}/${distractorSource.relPath}`;
      const target = byUri.get(targetUri);
      const distractor = byUri.get(distractorUri);
      if (!(target?.mirrorHash && distractor?.mirrorHash))
        throw new Error(`Indexed identity missing: ${item.caseId}`);
      const candidates = [
        {
          mirrorHash: distractor.mirrorHash,
          seq: 0,
          distance: item.distractorDistance,
        },
        {
          mirrorHash: target.mirrorHash,
          seq: 0,
          distance: item.targetDistance,
        },
      ];
      const disabled = await runProjectAffinitySearch(
        store,
        config,
        item.query,
        candidates,
        { limit: item.limit }
      );
      const affinity = await resolveCliProjectAffinity(config, {
        cwd: config.collections.find(
          (collection) => collection.name === item.targetCollection
        )!.path,
      });
      const enabled = await runProjectAffinitySearch(
        store,
        config,
        item.query,
        candidates,
        { affinity, limit: item.limit }
      );
      observations.push(
        {
          caseId: `${item.caseId}:disabled`,
          observation: disabled.observation,
        },
        { caseId: `${item.caseId}:enabled`, observation: enabled.observation }
      );
      targets.push({
        caseId: item.caseId,
        taskId: item.taskId,
        query: item.query,
        targetUri,
        requiredEvidenceRetained:
          requiredEvidenceRetained(disabled.output, binding.requiredEvidence) &&
          requiredEvidenceRetained(enabled.output, binding.requiredEvidence),
        disabled: projectAffinityEntries(disabled.output),
        enabled: projectAffinityEntries(enabled.output),
      });
    }

    let evidenceAccuracyLoss = 0;
    let evidenceCoverageLoss = 0;
    let disabledAccuracy = 0;
    let enabledAccuracy = 0;
    let disabledCoverage = 0;
    let enabledCoverage = 0;
    let multilingualDisabledCorrect = 0;
    let multilingualEnabledCorrect = 0;
    const multilingualIds = ["t012ab3c", "t123bc4d", "te8f901a", "tf901a2b"];
    for (const [taskId, task] of [...fixture.tasks.entries()].sort()) {
      const oracle = fixture.oracles.get(taskId)!;
      const collection = task.corpus.collections[0]!;
      const candidates = corpusVectorCandidates(documents, [collection]);
      const disabled = await runProjectAffinitySearch(
        store,
        config,
        task.brief.goal,
        candidates,
        { collection, limit: 5 }
      );
      const affinity = await resolveCliProjectAffinity(config, {
        cwd: config.collections.find((item) => item.name === collection)!.path,
      });
      const enabled = await runProjectAffinitySearch(
        store,
        config,
        task.brief.goal,
        candidates,
        { affinity, collection, limit: 5 }
      );
      const required = oracle.claims.flatMap((claim) => claim.requiredEvidence);
      const disabledRetained = requiredEvidenceRetained(
        disabled.output,
        required
      );
      const enabledRetained = requiredEvidenceRetained(
        enabled.output,
        required
      );
      if (disabledRetained) {
        disabledAccuracy += 1;
        disabledCoverage += required.length;
      }
      if (enabledRetained) {
        enabledAccuracy += 1;
        enabledCoverage += required.length;
      }
      if (disabledRetained && !enabledRetained) evidenceCoverageLoss += 1;
      const disabledUris = disabled.output.results.map((result) => result.uri);
      const enabledUris = enabled.output.results.map((result) => result.uri);
      if (canonicalJson(disabledUris) !== canonicalJson(enabledUris))
        evidenceAccuracyLoss += 1;
      if (multilingualIds.includes(taskId)) {
        if (disabledRetained) multilingualDisabledCorrect += 1;
        if (enabledRetained) multilingualEnabledCorrect += 1;
      }
      observations.push(
        {
          caseId: `regression:${taskId}:disabled`,
          observation: disabled.observation,
        },
        {
          caseId: `regression:${taskId}:enabled`,
          observation: enabled.observation,
        }
      );
    }
    const multilingualLoss = Math.max(
      0,
      multilingualDisabledCorrect - multilingualEnabledCorrect
    );

    const filterCase = cases.fixture.cases[0]!;
    const filterBinding = bindings[0]!;
    const filterCandidates = corpusVectorCandidates(documents, [
      filterCase.targetCollection,
      filterCase.distractorCollection,
    ]);
    const distractorAffinity = await resolveCliProjectAffinity(config, {
      cwd: config.collections.find(
        (item) => item.name === filterCase.distractorCollection
      )!.path,
    });
    const filtered = await runProjectAffinitySearch(
      store,
      config,
      filterCase.query,
      filterCandidates,
      {
        affinity: distractorAffinity,
        collection: filterCase.targetCollection,
        limit: 5,
      }
    );
    observations.push({
      caseId: "filter:c015-vs-c115",
      observation: filtered.observation,
    });
    const filterHard =
      filtered.output.results.every((result) =>
        result.uri.startsWith(`gno://${filterCase.targetCollection}/`)
      ) &&
      filtered.output.results.every(
        (result) =>
          !result.uri.startsWith(`gno://${filterCase.distractorCollection}/`)
      ) &&
      requiredEvidenceRetained(filtered.output, filterBinding.requiredEvidence);

    const zeroCandidates = corpusVectorCandidates(documents, [
      filterCase.targetCollection,
      filterCase.distractorCollection,
    ]).slice(0, 2);
    const zeroBaseline = await runProjectAffinitySearch(
      store,
      config,
      filterCase.query,
      zeroCandidates,
      { limit: 2 }
    );
    const zeroInputs: Array<{
      lane: ProjectAffinityPromotionArtifact["receipts"]["zeroLanes"][number]["lane"];
      affinity: ProjectAffinityScoringInput | undefined;
    }> = [
      { lane: "absent", affinity: undefined },
      {
        lane: "disabled",
        affinity: { enabled: false, resolution: { matches: [], roots: [] } },
      },
      {
        lane: "unavailable",
        affinity: await resolveCliProjectAffinity(config, {
          cwd: `${native.rootPath}/unavailable-project`,
        }),
      },
      {
        lane: "untrusted_remote",
        affinity: await resolveRemoteProjectAffinity(config, [
          "opaque-project-hint",
        ]),
      },
    ];
    const baselineProjection = exactSearchProjection(zeroBaseline.output);
    const zeroLanes: ProjectAffinityPromotionArtifact["receipts"]["zeroLanes"] =
      [];
    for (const input of zeroInputs) {
      const candidate = await runProjectAffinitySearch(
        store,
        config,
        filterCase.query,
        zeroCandidates,
        { affinity: input.affinity, limit: 2 }
      );
      observations.push({
        caseId: `zero:${input.lane}`,
        observation: candidate.observation,
      });
      const candidateProjection = exactSearchProjection(candidate.output);
      zeroLanes.push({
        lane: input.lane,
        baselineHash: sha256Bytes(baselineProjection),
        candidateHash: sha256Bytes(candidateProjection),
        equal: candidateProjection === baselineProjection,
      });
    }

    const auxiliary = auxiliaryReceipts();
    const structural = structuralReceipts(observations);
    const zeroLanesExact = zeroLanes.every((receipt) => receipt.equal);
    const auxiliaryReceiptsValid =
      auxiliary[0]?.applied === 0.03 &&
      auxiliary[1]?.applied === 0.08 &&
      auxiliary[2]?.applied === 0.08 &&
      auxiliary[3]?.applied === -0.08 &&
      auxiliary[4]?.applied === 0.03;

    return evaluateProjectAffinityPromotion(
      {
        schemaVersion: "1.0",
        benchmarkId: "project-affinity-promotion@1",
        fixture: {
          fixtureVersion: cases.fixture.fixtureVersion,
          fixtureFingerprint: cases.fingerprint,
          corpusFingerprint: fixture.snapshot.fingerprint,
          bindingFingerprint: projectAffinityBindingFingerprint(bindings),
          bindings,
        },
        methodology: [
          "Separate deterministic fn-97 lane; the authoritative 24-task adapter matrix is unchanged.",
          "Two controlled vector-distance pairs make the oracle collection lose by 0.02 before one trusted local +0.03 contribution.",
          "All 24 tasks run with their existing hard collection; the gate requires zero URI-rank and required-evidence coverage loss.",
          "Store calls are instrumented structurally; wall-clock latency is not a gate.",
        ],
        limitations: [
          "Controlled vector distances isolate the bounded promotion seam; they do not claim general retrieval superiority.",
          "The fixture agent still selects hard collections and MCP project hints remain untrusted zero-affinity inputs.",
          "Results apply only to this closed synthetic corpus and exact committed identities.",
        ],
        targets,
        receipts: { auxiliary, zeroLanes, structural },
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
            taskIds: multilingualIds,
            taskCount: 4,
            disabledCorrect: multilingualDisabledCorrect,
            enabledCorrect: multilingualEnabledCorrect,
            loss: multilingualLoss,
          },
        },
      },
      {
        evidenceAccuracyLoss,
        evidenceCoverageLoss,
        multilingualLoss,
        filterHard,
        zeroLanesExact,
        auxiliaryReceiptsValid,
        structuralCallsBounded: structural.every((receipt) => receipt.passed),
      }
    );
  } finally {
    await store.close();
    await cleanupNativeIndexPreparation(native);
  }
};
