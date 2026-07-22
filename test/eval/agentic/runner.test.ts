import { describe, expect, test } from "bun:test";

import type {
  OuterAgentFactory,
  OuterAgentRuntime,
  OuterAgentSession,
} from "../../../evals/agentic/agent";
import type { NormalizedToolResult } from "../../../evals/agentic/types";

import {
  CANONICAL_AGENT_TOOLS,
  fingerprintTools,
} from "../../../evals/agentic/adapter";
import {
  canonicalJson,
  modelVisibleUtf8Bytes,
  projectModelVisibleToolResult,
  receiptCanonicalJson,
} from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { createPerfectAdapterFactory } from "./driver-fakes";

class DisallowedToolAgentFactory implements OuterAgentFactory {
  readonly agentId = "disallowed-tool-agent";

  trials() {
    return [{ trialId: "agent-error-01", seed: 41 }];
  }

  async open() {
    const runtime: OuterAgentRuntime = {
      async createSession() {
        const session: OuterAgentSession = {
          agentId: "disallowed-tool-agent",
          promptFingerprint: "3".repeat(64),
          modelFingerprint: "4".repeat(64),
          tokenizerFingerprint: null,
          async next() {
            return {
              kind: "tool" as const,
              toolName: "not_allowed",
              arguments: {},
            };
          },
          countTokens() {
            return null;
          },
          async dispose() {},
        };
        return session;
      },
      async dispose() {},
    };
    return { runtime, modelLoadMs: null };
  }
}

describe("canonical adapter contract", () => {
  test("is deeply immutable with one stable fingerprint", () => {
    const fingerprint = fingerprintTools(CANONICAL_AGENT_TOOLS);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(CANONICAL_AGENT_TOOLS)).toBe(true);
    expect(Object.isFrozen(CANONICAL_AGENT_TOOLS[0]?.inputSchema)).toBe(true);
    expect(fingerprintTools(structuredClone(CANONICAL_AGENT_TOOLS))).toBe(
      fingerprint
    );
  });

  test("records explicit unsupported and unavailable capabilities", async () => {
    const fixture = await loadAgenticFixture();
    const capabilities = {
      backendInvocationAccounting: true,
      startupTiming: false,
      modelLoadTiming: false,
      toolTiming: true,
      tools: {
        search: "supported" as const,
        get: "supported" as const,
        multi_get: "unsupported" as const,
      },
      exactLineSpans: "supported" as const,
      measuredTokens: "unavailable" as const,
      backendHashes: "unavailable" as const,
      lifecycle: { cold: "supported" as const, warm: "unsupported" as const },
    };
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      capabilities,
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });
    expect(result.receipts[0]?.canonical.capabilities).toEqual(capabilities);
  });
});

describe("runner lifecycle", () => {
  test("reuses one prepared index with no cold probe and one warm probe", async () => {
    const fixture = await loadAgenticFixture();
    const { factory, metrics } = createPerfectAdapterFactory(fixture.snapshot);
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
    });

    expect(result.receipts).toHaveLength(2);
    expect(metrics.preparations).toBe(1);
    expect(metrics.attaches).toBe(2);
    expect(metrics.readinessProbes).toBe(1);
    expect(metrics.scoredResets).toBe(2);
    expect(result.receipts[0]?.canonical.fingerprints.index).toBe(
      result.receipts[1]?.canonical.fingerprints.index
    );
    expect(result.receipts[1]?.observations.timings.startup.valueMs).toBeNull();
  });

  test("baseline candidates require a read while a complete bundle stops once", async () => {
    const fixture = await loadAgenticFixture();
    const baseline = createPerfectAdapterFactory(fixture.snapshot, {
      searchResultRole: "candidates",
    });
    const bundle = createPerfectAdapterFactory(fixture.snapshot, {
      adapterId: "bundle",
      searchResultRole: "evidence_bundle",
    });
    const baselineResult = await runAgenticBenchmark({
      adapters: { perfect: baseline.factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });
    const bundleResult = await runAgenticBenchmark({
      adapters: { bundle: bundle.factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });

    const baselineReceipt = baselineResult.receipts[0];
    expect(
      baselineReceipt?.canonical.calls.map((call) => call.result.resultRole)
    ).toEqual(["candidates", "source"]);
    expect(baselineReceipt?.canonical.agentCalls).toBe(2);
    expect(bundleResult.receipts[0]?.canonical.agentCalls).toBe(1);
    expect(
      baselineReceipt?.canonical.finalEnvelope?.claims[0]?.citations[0]
        ?.spanHash
    ).toBe(
      baselineReceipt?.canonical.calls[1]?.result.evidence.find((item) =>
        item.text.includes("INC-4827")
      )?.spanHash
    );
  });

  test("one-call tasks may finalize exact candidate evidence", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      searchResultRole: "candidates",
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t7891a03"],
      lifecycles: ["cold"],
    });
    expect(result.receipts[0]?.canonical.agentCalls).toBe(1);
    expect(result.receipts[0]?.canonical.finalEnvelope?.stopReason).toBe(
      "complete"
    );
  });

  test("empty candidate results abstain without an unnecessary read", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      resultOverride: {
        status: "ok",
        resultRole: "candidates",
        content: "",
        evidence: [],
        errorCode: null,
      },
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t234cd5e"],
      lifecycles: ["cold"],
    });
    expect(result.receipts[0]?.canonical.agentCalls).toBe(1);
    expect(result.receipts[0]?.canonical.finalEnvelope?.stopReason).toBe(
      "abstained"
    );
  });
});

describe("runner accounting and failures", () => {
  test("meters the exact Unicode agent-visible payload and not backend metadata", async () => {
    const fixture = await loadAgenticFixture();
    const resultOverride: NormalizedToolResult = {
      status: "ok",
      resultRole: "evidence_bundle",
      content: "蓝鲸 🐋",
      evidence: [],
      errorCode: null,
    };
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      resultOverride,
      backendInvocations: 7,
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t123bc4d"],
      lifecycles: ["cold"],
    });
    const call = result.receipts[0]?.canonical.calls[0];
    expect(call?.modelVisibleUtf8Bytes).toBe(
      modelVisibleUtf8Bytes(projectModelVisibleToolResult(resultOverride))
    );
    expect(call?.backendInvocations).toBe(7);
    expect(call?.measuredTokens).toBeNull();
  });

  test("keeps recovered normalized tool errors visible without poisoning failure", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      resultOverride: {
        status: "error",
        resultRole: "candidates",
        content: "temporarily unavailable",
        evidence: [],
        errorCode: "unavailable",
      },
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t234cd5e"],
      lifecycles: ["cold"],
    });
    expect(result.receipts[0]?.canonical.calls[0]?.result.status).toBe("error");
    expect(result.receipts[0]?.canonical.failure.class).toBe("none");
  });

  test("records preparation failures for every attempted lifecycle", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      throwOnPrepare: new Error("broken /tmp/preparation-a"),
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
    });
    expect(result.receipts).toHaveLength(2);
    expect(
      result.receipts.every(
        (receipt) => receipt.canonical.failure.class === "harness_error"
      )
    ).toBe(true);
    expect(
      result.receipts.every(
        (receipt) => receipt.canonical.agentId === "fixture-agent-v1"
      )
    ).toBe(true);
  });

  test("marks remaining warm pairs when a failed call may corrupt the cohort", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      throwOnCall: new Error("backend disconnected"),
    });
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3", "t1b2c3d4"],
      lifecycles: ["warm"],
    });
    expect(
      result.receipts.map((receipt) => receipt.canonical.failure.class)
    ).toEqual(["product_error", "harness_error"]);
    expect(result.receipts[1]?.canonical.failure.code).toBe(
      "warm_cohort_corrupted"
    );
  });

  test("continues warm pairs after an ordinary deterministic agent error", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot);
    const result = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3", "t1b2c3d4"],
      lifecycles: ["warm"],
      agentFactory: new DisallowedToolAgentFactory(),
    });
    expect(result.receipts).toHaveLength(2);
    expect(
      result.receipts.every(
        (receipt) => receipt.canonical.failure.class === "agent_error"
      )
    ).toBe(true);
  });

  test("keeps volatile failure text out of canonical JSON", async () => {
    const fixture = await loadAgenticFixture();
    const run = async (message: string) => {
      const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
        throwOnCall: new Error(message),
      });
      return runAgenticBenchmark({
        adapters: { perfect: factory },
        fixture,
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"],
        recordedAt: () => "2026-07-22T12:00:00.000Z",
      });
    };
    const first = await run("alpha failed at /tmp/run-one/model");
    const second = await run("beta failed at /tmp/run-two/model");
    expect(receiptCanonicalJson(first.receipts[0] as never)).toBe(
      receiptCanonicalJson(second.receipts[0] as never)
    );
    expect(canonicalJson(first.receipts[0]?.observations.diagnostics)).not.toBe(
      canonicalJson(second.receipts[0]?.observations.diagnostics)
    );
  });
});
