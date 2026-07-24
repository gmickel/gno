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
  });
});
