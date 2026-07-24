import type { ProjectAffinityScoringInput } from "../../src/pipeline/project-affinity";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { ProjectAffinityPromotionArtifact } from "./project-affinity-promotion";
import type { CallObservation } from "./project-affinity-runtime";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import {
  resolveCliProjectAffinity,
  resolveRemoteProjectAffinity,
} from "../../src/core/project-affinity-surface";
import { applyAuxiliaryScore } from "../../src/pipeline/project-affinity";
import { SqliteAdapter } from "../../src/store";
import { canonicalJson } from "./canonical";
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
    const observations: CallObservation[] = [];

    for (const item of cases.fixture.cases) {
      const binding = bindings.find((entry) => entry.caseId === item.caseId)!;
      const targetUri = binding.requiredEvidence[0]!.uri;
      const distractorSource = binding.corpus.find(
        (entry) => entry.collection === item.distractorCollection
      )!;
      const distractorUri = `gno://${distractorSource.collection}/${distractorSource.relPath}`;
      const target = byUri.get(targetUri);
      const distractor = byUri.get(distractorUri);
      if (!(target?.mirrorHash && distractor?.mirrorHash)) {
        throw new Error(
          `Project-affinity indexed identity missing: ${item.caseId}`
        );
      }
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
        {
          limit: item.limit,
        }
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
        {
          affinity,
          limit: item.limit,
        }
      );
      observations.push(disabled.observation, enabled.observation);
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
    let multilingualLoss = 0;
    const multilingualIds = new Set([
      "t012ab3c",
      "t123bc4d",
      "te8f901a",
      "tf901a2b",
    ]);
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
      const matched = await runProjectAffinitySearch(
        store,
        config,
        task.brief.goal,
        candidates,
        { affinity, collection, limit: 5 }
      );
      const required = oracle.claims.flatMap((claim) => claim.requiredEvidence);
      const disabledCoverage = requiredEvidenceRetained(
        disabled.output,
        required
      );
      const matchedCoverage = requiredEvidenceRetained(
        matched.output,
        required
      );
      if (disabledCoverage && !matchedCoverage) evidenceCoverageLoss += 1;
      const disabledUris = disabled.output.results.map((result) => result.uri);
      const matchedUris = matched.output.results.map((result) => result.uri);
      if (canonicalJson(disabledUris) !== canonicalJson(matchedUris)) {
        evidenceAccuracyLoss += 1;
        if (multilingualIds.has(taskId)) multilingualLoss += 1;
      }
      observations.push(disabled.observation, matched.observation);
    }

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
    observations.push(filtered.observation);
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
    const zeroInputs: Array<ProjectAffinityScoringInput | undefined> = [
      undefined,
      { enabled: false, resolution: { matches: [], roots: [] } },
      await resolveCliProjectAffinity(config, {
        cwd: `${native.rootPath}/unavailable-project`,
      }),
      await resolveRemoteProjectAffinity(config, ["opaque-project-hint"]),
    ];
    let zeroLanesExact = true;
    for (const affinity of zeroInputs) {
      const lane = await runProjectAffinitySearch(
        store,
        config,
        filterCase.query,
        zeroCandidates,
        { affinity, limit: 2 }
      );
      observations.push(lane.observation);
      zeroLanesExact =
        zeroLanesExact &&
        exactSearchProjection(lane.output) ===
          exactSearchProjection(zeroBaseline.output);
    }

    const directAuxiliary = [
      applyAuxiliaryScore(0.5, [0.03, 0.05]),
      applyAuxiliaryScore(0.5, [0.08, 0.03]),
      applyAuxiliaryScore(0.5, [-0.08, -0.05]),
    ];
    const auxiliaryReceiptsValid =
      canonicalJson(directAuxiliary) ===
      canonicalJson([
        { requested: 0.08, applied: 0.08, finalScore: 0.58 },
        { requested: 0.11, applied: 0.08, finalScore: 0.58 },
        { requested: -0.13, applied: -0.08, finalScore: 0.42 },
      ]);

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
      },
      {
        evidenceAccuracyLoss,
        evidenceCoverageLoss,
        multilingualLoss,
        filterHard,
        zeroLanesExact,
        auxiliaryReceiptsValid,
        structuralCallsBounded: observations.every(isStructurallyBounded),
      }
    );
  } finally {
    await store.close();
    await cleanupNativeIndexPreparation(native);
  }
};
