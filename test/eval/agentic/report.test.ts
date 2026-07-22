import { describe, expect, test } from "bun:test";

import { createLexicalAdapterFactory } from "../../../evals/agentic/adapters/lexical";
import { FixtureAgentFactory } from "../../../evals/agentic/fixture-agent";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  benchmarkCanonicalProjection,
  buildBenchmarkReport,
} from "../../../evals/agentic/report";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { validateAgenticSchema } from "../../../evals/agentic/validation";

const environment = {
  packageVersion: "1.15.0",
  bunVersion: Bun.version,
  platform: process.platform,
  architecture: process.arch,
  git: {
    commit: "0".repeat(40),
    dirty: false,
    unavailableReason: null,
  },
  fixtureVersion: "2026-07-22.1",
  agentId: "fixture-agent-v1",
  trials: [{ trialId: "fixture-01", seed: 20260722 }],
};

describe("agentic benchmark reports", () => {
  test("binds every requested identity to one receipt and score", async () => {
    const fixture = await loadAgenticFixture();
    const agentFactory = new FixtureAgentFactory();
    const trials = [...agentFactory.trials()];
    const result = await runAgenticBenchmark({
      adapters: { lexical: createLexicalAdapterFactory() },
      agentFactory,
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      recordedAt: () => "2026-07-22T00:00:00.000Z",
    });
    const report = buildBenchmarkReport({
      result,
      fixture,
      environment,
      expected: {
        adapterIds: ["lexical"],
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"],
        trials,
      },
    });
    expect(validateAgenticSchema("benchmark-report", report)).toBeTrue();
    expect(report.attemptedPairs).toBe(1);
    expect(report.scores).toHaveLength(1);
    expect(report.scores[0]).toMatchObject({
      taskId: "t0a1b2c3",
      adapterId: "lexical",
      trialId: "fixture-01",
      lifecycle: "cold",
      agentId: "fixture-agent-v1",
    });
    expect(report.promotion).toBeNull();
  });

  test("canonical projection excludes receipt observations only", async () => {
    const fixture = await loadAgenticFixture();
    const agentFactory = new FixtureAgentFactory();
    const trials = [...agentFactory.trials()];
    const result = await runAgenticBenchmark({
      adapters: { lexical: createLexicalAdapterFactory() },
      agentFactory,
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });
    const input = {
      fixture,
      environment,
      expected: {
        adapterIds: ["lexical"],
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"] as const,
        trials,
      },
    };
    const first = buildBenchmarkReport({ ...input, result });
    result.receipts[0]!.observations.recordedAt = "2099-01-01T00:00:00.000Z";
    result.receipts[0]!.observations.tempPaths = ["/different/temp"];
    const second = buildBenchmarkReport({ ...input, result });
    expect(second.canonicalFingerprint).toBe(first.canonicalFingerprint);
    expect(second.receipts[0]?.observations.recordedAt).not.toBe(
      first.receipts[0]?.observations.recordedAt
    );
    const { canonicalFingerprint: _first, ...firstWithout } = first;
    const { canonicalFingerprint: _second, ...secondWithout } = second;
    expect(benchmarkCanonicalProjection(firstWithout)).toEqual(
      benchmarkCanonicalProjection(secondWithout)
    );
  });

  test("refuses duplicate or missing requested matrix identities", async () => {
    const fixture = await loadAgenticFixture();
    const agentFactory = new FixtureAgentFactory();
    const trials = [...agentFactory.trials()];
    const result = await runAgenticBenchmark({
      adapters: { lexical: createLexicalAdapterFactory() },
      agentFactory,
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });
    result.receipts.push(structuredClone(result.receipts[0]!));
    expect(() =>
      buildBenchmarkReport({
        result,
        fixture,
        environment,
        expected: {
          adapterIds: ["lexical"],
          taskIds: ["t0a1b2c3"],
          lifecycles: ["cold"],
          trials,
        },
      })
    ).toThrow("exact matrix");
  });
});
