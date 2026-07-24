import { describe, expect, test } from "bun:test";

import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  bindProjectAffinityCases,
  loadProjectAffinityCases,
} from "../../../evals/agentic/project-affinity-contract";
import { runProjectAffinityOutcomeBenchmark } from "../../../evals/agentic/project-affinity-outcome";
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
});
