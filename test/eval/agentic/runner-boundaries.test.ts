import { describe, expect, test } from "bun:test";

import type { AgentAdapter } from "../../../evals/agentic/adapter";
import type {
  AgentStep,
  OuterAgentFactory,
  OuterAgentSession,
} from "../../../evals/agentic/agent";

import { AgenticHarnessError } from "../../../evals/agentic/adapter";
import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { createPerfectAdapterFactory } from "./driver-fakes";

const TEST_AGENT_ID = "boundary-agent-v1";

const boundarySession = (step: unknown): OuterAgentSession => ({
  agentId: TEST_AGENT_ID,
  promptFingerprint: "3".repeat(64),
  modelFingerprint: "4".repeat(64),
  tokenizerFingerprint: null,
  async next() {
    return step as AgentStep;
  },
  countTokens() {
    return null;
  },
  async dispose() {},
});

const scriptedAgent = (
  step: unknown,
  options: {
    trials?: Array<{ trialId: string; seed: number }>;
    createSession?: () => Promise<OuterAgentSession>;
  } = {}
): OuterAgentFactory => ({
  agentId: TEST_AGENT_ID,
  trials() {
    return options.trials ?? [{ trialId: "boundary-01", seed: 17 }];
  },
  async open() {
    return {
      runtime: {
        async createSession() {
          return options.createSession
            ? options.createSession()
            : boundarySession(step);
        },
        async dispose() {},
      },
      modelLoadMs: null,
    };
  },
});

const rejectionCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof AgenticHarnessError
      ? error.code
      : `unexpected:${String(error)}`;
  }
};

describe("runner schedule boundaries", () => {
  test("rejects empty duplicate and malformed run matrices", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot);
    const base = { adapters: { perfect: factory }, fixture };

    expect(
      await rejectionCode(runAgenticBenchmark({ ...base, taskIds: [] }))
    ).toBe("invalid_task_schedule");
    expect(
      await rejectionCode(
        runAgenticBenchmark({
          ...base,
          taskIds: ["t0a1b2c3", "t0a1b2c3"],
        })
      )
    ).toBe("invalid_task_schedule");
    expect(
      await rejectionCode(runAgenticBenchmark({ ...base, adapterIds: [] }))
    ).toBe("invalid_adapter_schedule");
    expect(
      await rejectionCode(
        runAgenticBenchmark({
          ...base,
          adapterIds: ["perfect", "perfect"],
        })
      )
    ).toBe("invalid_adapter_schedule");
    expect(
      await rejectionCode(runAgenticBenchmark({ ...base, lifecycles: [] }))
    ).toBe("invalid_lifecycle_schedule");
    expect(
      await rejectionCode(
        runAgenticBenchmark({
          ...base,
          lifecycles: ["cold", "cold"],
        })
      )
    ).toBe("invalid_lifecycle_schedule");
    expect(
      await rejectionCode(
        runAgenticBenchmark({
          ...base,
          agentFactory: scriptedAgent(
            {},
            {
              trials: [
                { trialId: "duplicate", seed: 1 },
                { trialId: "duplicate", seed: 2 },
              ],
            }
          ),
        })
      )
    ).toBe("invalid_trial_schedule");
    expect(
      await rejectionCode(
        runAgenticBenchmark({ ...base, callTimeoutMs: Number.NaN })
      )
    ).toBe("invalid_runner_timeout");
  });
});

describe("runner agent boundaries", () => {
  test("classifies malformed final envelopes and tool arguments as agent errors", async () => {
    const fixture = await loadAgenticFixture();
    const adapter = createPerfectAdapterFactory(fixture.snapshot);
    const malformedFinal = await runAgenticBenchmark({
      adapters: { perfect: adapter.factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: scriptedAgent({
        kind: "final",
        envelope: { schemaVersion: "1.0", claims: [] },
      }),
    });
    expect(malformedFinal.receipts[0]?.canonical.failure).toMatchObject({
      class: "agent_error",
      code: "invalid_final_envelope",
    });

    const malformedAction = await runAgenticBenchmark({
      adapters: { perfect: adapter.factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: scriptedAgent({
        kind: "tool",
        toolName: "search",
        arguments: { query: 42 },
      }),
    });
    expect(malformedAction.receipts[0]?.canonical.failure).toMatchObject({
      class: "agent_error",
      code: "invalid_agent_action",
    });
    expect(adapter.metrics.calls).toBe(0);
  });

  test("bounds session creation and rejects invalid session identity", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot);
    const timeout = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      callTimeoutMs: 15,
      agentFactory: scriptedAgent(
        {},
        {
          createSession: () => new Promise(() => {}),
        }
      ),
    });
    expect(timeout.receipts[0]?.canonical.failure).toMatchObject({
      class: "harness_error",
      code: "agent_session_timeout",
    });

    const invalidIdentity = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: scriptedAgent(
        {},
        {
          createSession: async () => ({
            ...boundarySession({}),
            agentId: "drifted-agent",
          }),
        }
      ),
    });
    expect(invalidIdentity.receipts[0]?.canonical.failure).toMatchObject({
      class: "harness_error",
      code: "invalid_agent_session",
    });
  });

  test("rejects malformed runtime starts and token-meter results", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot);
    const invalidRuntimeFactory: OuterAgentFactory = {
      ...scriptedAgent({}),
      async open() {
        return { runtime: null, modelLoadMs: -1 } as never;
      },
    };
    const runtime = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: invalidRuntimeFactory,
    });
    expect(runtime.receipts[0]?.canonical.failure.class).toBe("harness_error");
    expect(runtime.receipts[0]?.observations.diagnostics.join(" ")).toContain(
      "runtime differs from the closed contract"
    );

    const searchStep = {
      kind: "tool",
      toolName: "search",
      arguments: { query: "incident" },
    };
    const tokenMeter = await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: scriptedAgent(searchStep, {
        createSession: async () => ({
          ...boundarySession(searchStep),
          tokenizerFingerprint: "5".repeat(64),
          countTokens() {
            return -1;
          },
        }),
      }),
    });
    expect(tokenMeter.receipts[0]?.canonical.failure).toMatchObject({
      class: "harness_error",
      code: "invalid_token_accounting",
    });
  });
});

describe("runner adapter boundaries", () => {
  test("rejects identity config and capability drift on attached instances", async () => {
    const fixture = await loadAgenticFixture();
    for (const drift of ["identity", "config", "capabilities"] as const) {
      const base = createPerfectAdapterFactory(fixture.snapshot);
      let instance = 0;
      const factory = (): AgentAdapter => {
        const adapter = base.factory();
        instance += 1;
        if (instance === 1) return adapter;
        if (drift === "identity") return { ...adapter, adapterId: "drifted" };
        if (drift === "config") {
          return {
            ...adapter,
            configFingerprint: canonicalFingerprint({ drift: true }),
          };
        }
        return {
          ...adapter,
          capabilities: {
            ...adapter.capabilities,
            exactLineSpans: "unavailable",
          },
        };
      };
      const result = await runAgenticBenchmark({
        adapters: { perfect: factory },
        fixture,
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"],
      });
      expect(result.receipts[0]?.canonical.failure.class).toBe("harness_error");
      expect(result.receipts[0]?.observations.diagnostics.join(" ")).toContain(
        "identity, config, or capabilities changed"
      );
      expect(base.metrics.disposals).toBe(2);
    }
  });

  test("disposes attached instances when attachment itself fails", async () => {
    const fixture = await loadAgenticFixture();
    const base = createPerfectAdapterFactory(fixture.snapshot);
    let instance = 0;
    const result = await runAgenticBenchmark({
      adapters: {
        perfect: () => {
          const adapter = base.factory();
          instance += 1;
          if (instance === 1) return adapter;
          return {
            ...adapter,
            async prepare() {
              throw new Error("attach failed");
            },
          };
        },
      },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
    });
    expect(result.receipts[0]?.canonical.failure.class).toBe("harness_error");
    expect(base.metrics.disposals).toBe(2);
  });

  test("closes preparation reset and tool outcome contracts", async () => {
    const fixture = await loadAgenticFixture();
    const malformed = async (
      mutate: (adapter: AgentAdapter) => AgentAdapter
    ) => {
      const base = createPerfectAdapterFactory(fixture.snapshot);
      return runAgenticBenchmark({
        adapters: { perfect: () => mutate(base.factory()) },
        fixture,
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"],
      });
    };

    const preparation = await malformed((adapter) => ({
      ...adapter,
      async prepare(context) {
        const value = await adapter.prepare(context);
        return { ...value, observations: { invalid: Number.NaN } };
      },
    }));
    expect(preparation.receipts[0]?.canonical.failure.class).toBe(
      "harness_error"
    );

    const reset = await malformed((adapter) => ({
      ...adapter,
      async reset(context) {
        const value = await adapter.reset(context);
        return { ...value, diagnostics: [42] as never };
      },
    }));
    expect(reset.receipts[0]?.canonical.failure.class).toBe("harness_error");

    const outcome = await malformed((adapter) => ({
      ...adapter,
      async callTool(toolName, arguments_, signal) {
        const value = await adapter.callTool(toolName, arguments_, signal);
        return { ...value, diagnostics: [42] as never };
      },
    }));
    expect(outcome.receipts[0]?.canonical.failure).toMatchObject({
      class: "harness_error",
      code: "invalid_tool_result",
    });

    const partialBackendHash = await malformed((adapter) => ({
      ...adapter,
      async callTool(toolName, arguments_, signal) {
        const value = await adapter.callTool(toolName, arguments_, signal);
        const [first, ...rest] = value.result.evidence;
        if (!first) return value;
        return {
          ...value,
          result: {
            ...value.result,
            evidence: [
              {
                ...first,
                backendSourceHash: "a".repeat(64),
                backendSpanHash: null,
                backendHashUnavailableReason: null,
              },
              ...rest,
            ],
          },
        };
      },
    }));
    expect(partialBackendHash.receipts[0]?.canonical.failure).toMatchObject({
      class: "harness_error",
      code: "invalid_tool_result",
    });
  });

  test("bounds tool listing and disposal seams", async () => {
    const fixture = await loadAgenticFixture();
    const base = createPerfectAdapterFactory(fixture.snapshot);
    const started = performance.now();
    const result = await runAgenticBenchmark({
      adapters: {
        perfect: () => ({
          ...base.factory(),
          listTools: () => new Promise(() => {}),
          dispose: () => new Promise(() => {}),
        }),
      },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      callTimeoutMs: 15,
    });
    expect(performance.now() - started).toBeLessThan(150);
    expect(result.receipts[0]?.canonical.failure.class).toBe("harness_error");
  });
});
