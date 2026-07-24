import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  bindProjectAffinityCases,
  loadProjectAffinityCases,
} from "../../../evals/agentic/project-affinity-contract";
import { runProjectAffinityOutcomeBenchmark } from "../../../evals/agentic/project-affinity-outcome";
import {
  isStructurallyBounded,
  type CallObservation,
} from "../../../evals/agentic/project-affinity-runtime";
import { validateProjectAffinityPromotionArtifact } from "../../../evals/agentic/project-affinity-validation";
import { validateAgenticSchema } from "../../../evals/agentic/validation";

describe("project-affinity promotion cases", () => {
  test("hash-bind fn-97 identities and flip both controlled losing targets", async () => {
    const fixture = await loadAgenticFixture();
    const cases = await loadProjectAffinityCases();
    const bindings = bindProjectAffinityCases(fixture, cases.fixture);
    expect(bindings).toHaveLength(2);
    expect(cases.fixture.cases.map((item) => item.taskId)).toEqual([
      "t456ef70",
      "t567f081",
    ]);
  });

  test("passes the real vector pipeline promotion and structural gates", async () => {
    const fixture = await loadAgenticFixture();
    const artifact = await runProjectAffinityOutcomeBenchmark(fixture);
    expect(
      validateAgenticSchema("project-affinity-promotion", artifact)
    ).toBeTrue();
    expect(artifact.gates).toMatchObject({
      passed: true,
      failures: [],
      targetCorrectTop1: { disabled: 0, enabled: 2, required: 2 },
      evidenceAccuracyLoss: 0,
      evidenceCoverageLoss: 0,
      multilingualLoss: 0,
      filterHard: true,
      zeroLanesExact: true,
      auxiliaryReceiptsValid: true,
      structuralCallsBounded: true,
    });
    expect(JSON.stringify(artifact)).not.toContain("gno-agentic-fixture-");
    expect(JSON.stringify(artifact)).not.toContain("opaque-project-hint");
    expect(artifact.receipts.auxiliary).toEqual([
      expect.objectContaining({
        caseId: "project_match",
        requested: 0.03,
        applied: 0.03,
      }),
      expect.objectContaining({
        caseId: "combined_exact_cap",
        requested: 0.08,
        applied: 0.08,
      }),
      expect.objectContaining({
        caseId: "positive_over_cap",
        requested: 0.11,
        applied: 0.08,
      }),
      expect.objectContaining({
        caseId: "negative_over_cap",
        requested: -0.13,
        applied: -0.08,
      }),
      expect.objectContaining({
        caseId: "overlap_no_stack",
        requested: 0.03,
        applied: 0.03,
      }),
    ]);
    expect(
      artifact.receipts.zeroLanes.every(
        (receipt) =>
          receipt.equal && receipt.baselineHash === receipt.candidateHash
      )
    ).toBeTrue();
    expect(
      artifact.receipts.structural.every(
        (receipt) =>
          receipt.passed &&
          receipt.calls.getDocumentsByMirrorHashes <= 1 &&
          receipt.calls.getChunksBatch <= 1 &&
          receipt.calls.getCollections <= 1 &&
          receipt.calls.getContexts <= 1 &&
          receipt.calls.getContextGeneration <= 2 &&
          receipt.unexpectedCalls.length === 0 &&
          receipt.candidateRequested <= receipt.maxCandidateBound &&
          receipt.candidateReturned <= receipt.candidateRequested &&
          receipt.calls.listDocuments === 0 &&
          receipt.candidateReturned <= receipt.maxCandidateBound
      )
    ).toBeTrue();
    expect(artifact.regression).toMatchObject({
      taskCount: 24,
      evidenceAccuracy: { loss: 0 },
      evidenceCoverage: { loss: 0 },
      multilingual: { taskCount: 4, loss: 0 },
    });
  });

  test("is byte-deterministic across independent temporary indexes", async () => {
    const fixture = await loadAgenticFixture();
    const first = await runProjectAffinityOutcomeBenchmark(fixture);
    const second = await runProjectAffinityOutcomeBenchmark(fixture);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(second.canonicalFingerprint).toBe(first.canonicalFingerprint);
  });

  test("rejects over-request and hidden StorePort calls independently", () => {
    const bounded: CallObservation = {
      calls: {
        getChunksBatch: 1,
        getCollections: 1,
        getContextGeneration: 2,
        getContexts: 1,
        getDocumentsByMirrorHashes: 1,
        getTagsBatch: 0,
        listDocuments: 0,
      },
      unexpectedCalls: {},
      candidateCount: 3,
      requestedCount: 3,
      outputLimit: 1,
    };
    expect(isStructurallyBounded(bounded)).toBeTrue();
    expect(
      isStructurallyBounded({ ...bounded, requestedCount: 4 })
    ).toBeFalse();
    expect(
      isStructurallyBounded({
        ...bounded,
        unexpectedCalls: { getContent: 1 },
      })
    ).toBeFalse();
    expect(
      isStructurallyBounded({
        ...bounded,
        calls: { ...bounded.calls, getContexts: 2 },
      })
    ).toBeFalse();
  });

  test("independently rejects ranking, receipt, gate, and fingerprint mutations", async () => {
    const fixture = await loadAgenticFixture();
    const artifact = await runProjectAffinityOutcomeBenchmark(fixture);
    expect(
      await validateProjectAffinityPromotionArtifact(artifact, fixture)
    ).toEqual([]);

    const reversed = structuredClone(artifact);
    reversed.targets[0]!.enabled.reverse();
    expect(
      await validateProjectAffinityPromotionArtifact(reversed, fixture)
    ).toContain("artifact_target_identity_invalid");

    const changedReceipt = structuredClone(artifact);
    changedReceipt.receipts.structural[0]!.candidateRequested =
      changedReceipt.receipts.structural[0]!.maxCandidateBound + 1;
    expect(
      await validateProjectAffinityPromotionArtifact(changedReceipt, fixture)
    ).toContain("artifact_structural_receipt_invalid");

    const forgedGate = structuredClone(artifact);
    forgedGate.gates.targetCorrectTop1.enabled = 0;
    expect(
      await validateProjectAffinityPromotionArtifact(forgedGate, fixture)
    ).toContain("artifact_gate_summary_mismatch");

    const forgedFingerprint = structuredClone(artifact);
    forgedFingerprint.canonicalFingerprint = "0".repeat(64);
    expect(
      await validateProjectAffinityPromotionArtifact(forgedFingerprint, fixture)
    ).toContain("artifact_fingerprint_mismatch");
  });
});
