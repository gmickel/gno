import { beforeAll, describe, expect, test } from "bun:test";

import type { LoadedAgenticFixture } from "../../../evals/agentic/fixture-db";

import { createLexicalAdapterFactory } from "../../../evals/agentic/adapters/lexical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { scoreTrajectory } from "../../../evals/agentic/scoring";

const RECORDED_AT = "2026-07-22T00:00:00.000Z";

describe("agentic lexical adapter", () => {
  let fixture: LoadedAgenticFixture;

  beforeAll(async () => {
    fixture = await loadAgenticFixture();
  });

  test("runs the direct production lexical path for all deterministic tasks", async () => {
    const run = await runAgenticBenchmark({
      fixture,
      adapters: { lexical: createLexicalAdapterFactory() },
      adapterIds: ["lexical"],
      lifecycles: ["cold"],
      recordedAt: () => RECORDED_AT,
    });

    expect(run.receipts).toHaveLength(24);
    expect(run.preparations).toHaveLength(1);
    expect(run.preparations[0]?.corpusFingerprint).toBe(
      fixture.snapshot.fingerprint
    );
    const scores = [];
    for (const receipt of run.receipts) {
      expect(receipt.canonical.failure.class).toBe("none");
      expect(receipt.canonical.capabilities.tools).toEqual({
        search: "supported",
        get: "supported",
        multi_get: "supported",
      });
      expect(receipt.canonical.capabilities.backendHashes).toBe("unsupported");
      expect(receipt.canonical.capabilities.measuredTokens).toBe("unavailable");
      expect(receipt.canonical.agentCalls).toBeGreaterThanOrEqual(1);
      expect(receipt.canonical.backendInvocations).toBeGreaterThanOrEqual(
        receipt.canonical.agentCalls
      );
      expect(receipt.canonical.calls[0]?.toolName).toBe("search");
      expect(receipt.canonical.calls[0]?.result.resultRole).toBe("candidates");
      expect(
        receipt.canonical.calls.every(
          (call) => call.result.resultRole !== "evidence_bundle"
        )
      ).toBe(true);
      expect(receipt.observations.diagnostics).toContain(
        "lexical-only: expansion, vectors, reranking, and graph disabled"
      );
      const task = fixture.tasks.get(receipt.canonical.taskId);
      const oracle = fixture.oracles.get(receipt.canonical.taskId);
      if (!task || !oracle) throw new Error("Missing fixture pair");
      scores.push(scoreTrajectory(task, oracle, receipt));
    }
    expect(scores.every((score) => score.scored)).toBe(true);
    expect(
      scores.filter((score) => score.success === 1).length
    ).toBeGreaterThan(0);
    expect(scores.some((score) => score.success === 0)).toBe(true);
  });

  test("cold and warm cohorts reuse one immutable prepared index", async () => {
    const run = await runAgenticBenchmark({
      fixture,
      adapters: { lexical: createLexicalAdapterFactory() },
      adapterIds: ["lexical"],
      taskIds: ["t1b2c3d4", "te8f901a"],
      lifecycles: ["cold", "warm"],
      recordedAt: () => RECORDED_AT,
    });

    expect(run.preparations).toHaveLength(1);
    const indexFingerprints = new Set(
      run.receipts.map((receipt) => receipt.canonical.fingerprints.index)
    );
    expect(indexFingerprints.size).toBe(1);
    expect(
      indexFingerprints.has(run.preparations[0]?.indexFingerprint ?? "")
    ).toBe(true);
    expect(
      run.receipts.filter((receipt) => receipt.canonical.lifecycle === "warm")
    ).toHaveLength(2);
  });

  test("enforces active task scope for unscoped search and every read", async () => {
    const factory = createLexicalAdapterFactory();
    const owner = factory();
    const preparation = await owner.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    const adapter = factory();
    try {
      await adapter.prepare({
        snapshot: fixture.snapshot,
        prepared: preparation,
        signal: new AbortController().signal,
      });
      const task = fixture.tasks.get("t0a1b2c3");
      if (!task) throw new Error("Missing task");
      await adapter.reset({
        task,
        lifecycle: "cold",
        readinessProbe: false,
        signal: new AbortController().signal,
      });
      const search = await adapter.callTool(
        "search",
        { query: "owner" },
        new AbortController().signal
      );
      expect(search.result.content).not.toContain("gno://c00c/");
      expect(
        search.result.evidence.every((item) =>
          item.uri.startsWith("gno://c001/")
        )
      ).toBe(true);
      for (const [toolName, arguments_] of [
        ["get", { uri: "gno://c00c/d001.md" }],
        ["multi_get", { uris: ["gno://c00c/d001.md"] }],
        ["search", { query: "owner", collection: "c00c" }],
      ] as const) {
        let rejected = false;
        try {
          await adapter.callTool(
            toolName,
            arguments_,
            new AbortController().signal
          );
        } catch (error) {
          rejected = true;
          expect((error as { code?: string }).code).toBe(
            "task_scope_violation"
          );
        }
        expect(rejected).toBe(true);
      }
    } finally {
      await adapter.dispose();
      await owner.dispose();
    }
  });
});
