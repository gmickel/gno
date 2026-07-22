import { describe, expect, test } from "bun:test";

import type {
  AgentCreateContext,
  OuterAgentFactory,
  OuterAgentRuntime,
  OuterAgentSession,
} from "../../../evals/agentic/agent";
import type {
  AgentVisibleCall,
  FinalEnvelope,
} from "../../../evals/agentic/types";

import {
  canonicalJson,
  receiptCanonicalJson,
} from "../../../evals/agentic/canonical";
import {
  FixtureAgentFactory,
  buildFixtureSearchQuery,
  parseFinalEnvelope,
} from "../../../evals/agentic/fixture-agent";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import { runAgenticBenchmark } from "../../../evals/agentic/runner";
import { scoreTrajectory } from "../../../evals/agentic/scoring";
import { createPerfectAdapterFactory } from "./driver-fakes";
import { taskFixture } from "./fixtures";

const abstentionEnvelope = (context: AgentCreateContext): FinalEnvelope => ({
  schemaVersion: "1.0",
  claims: [],
  gaps: context.task.claims.map((claim) => ({
    claimKey: claim.claimKey,
    reason: "missing_evidence",
  })),
  abstained: true,
  stopReason: "abstained",
});

class SpyAgentFactory implements OuterAgentFactory {
  readonly agentId = "spy-agent";
  readonly histories: Array<readonly AgentVisibleCall[]> = [];

  trials() {
    return [{ trialId: "spy-01", seed: 17 }];
  }

  async open() {
    const histories = this.histories;
    const runtime: OuterAgentRuntime = {
      async createSession(context) {
        let step = 0;
        const session: OuterAgentSession = {
          agentId: "spy-agent",
          promptFingerprint: "1".repeat(64),
          modelFingerprint: "2".repeat(64),
          tokenizerFingerprint: null,
          async next(calls) {
            histories.push(structuredClone(calls));
            step += 1;
            if (step === 1) {
              return {
                kind: "tool" as const,
                toolName: "search",
                arguments: { query: context.task.brief.goal },
              };
            }
            return {
              kind: "final" as const,
              envelope: abstentionEnvelope(context),
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

describe("pinned fixture agent", () => {
  test("derives all 24 outcomes from bundles and candidate-to-read flows", async () => {
    const fixture = await loadAgenticFixture();
    for (const searchResultRole of ["evidence_bundle", "candidates"] as const) {
      const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
        searchResultRole,
      });
      const result = await runAgenticBenchmark({
        adapters: { perfect: factory },
        fixture,
        agentFactory: new FixtureAgentFactory(),
        lifecycles: ["cold"],
        recordedAt: () => "2026-07-22T12:00:00.000Z",
      });

      expect(result.receipts).toHaveLength(24);
      const scores = result.receipts.map((receipt) => {
        const task = fixture.tasks.get(receipt.canonical.taskId);
        const oracle = fixture.oracles.get(receipt.canonical.taskId);
        if (!task || !oracle) throw new Error("fixture pair disappeared");
        return scoreTrajectory(task, oracle, receipt);
      });
      expect(scores.filter((score) => score.success === 1)).toHaveLength(24);
      if (searchResultRole === "candidates") {
        expect(
          result.receipts
            .filter((receipt) => receipt.canonical.taskId !== "t7891a03")
            .every((receipt) => receipt.canonical.agentCalls >= 2)
        ).toBe(true);
      }
    }
  });

  test("strict final parsing rejects prose and semantic extras", () => {
    const task = taskFixture();
    expect(() => parseFinalEnvelope(task, "answer: {}")).toThrow(
      "not one JSON value"
    );
    expect(() =>
      parseFinalEnvelope(
        task,
        JSON.stringify({
          schemaVersion: "1.0",
          claims: [],
          gaps: [{ claimKey: "unknownClaim", reason: "missing_evidence" }],
          abstained: true,
          stopReason: "abstained",
        })
      )
    ).toThrow("extra_gap:unknownClaim");
    expect(() =>
      parseFinalEnvelope(
        task,
        `{"schemaVersion":"1.0","claims":[{"claimKey":"incidentId","claimKey":"other","value":{"type":"identifier","value":"INC-1"},"citations":[]}],"gaps":[],"abstained":false,"stopReason":"complete"}`
      )
    ).toThrow("Duplicate JSON key");
  });

  test("uses one answer-free preferred lexical cue under AND semantics", async () => {
    const fixture = await loadAgenticFixture();
    const expected = new Map([
      ["t012ab3c", "exportación automática"],
      ["td7e8f90", "failure identifier"],
      ["t345de6f", "owner"],
    ]);
    for (const [taskId, query] of expected) {
      const task = fixture.tasks.get(taskId);
      if (!task) throw new Error(`missing task ${taskId}`);
      expect(buildFixtureSearchQuery(task)).toBe(query);
      const corpus = fixture.snapshot.files
        .filter((file) => file.taskId === taskId)
        .map((file) => file.content.toLowerCase())
        .join("\n");
      expect(
        query.split(/\s+/).every((term) => corpus.includes(term.toLowerCase()))
      ).toBe(true);
    }
  });

  test("canonical fixture receipts replay byte-identically", async () => {
    const fixture = await loadAgenticFixture();
    const run = async () => {
      const { factory } = createPerfectAdapterFactory(fixture.snapshot);
      return runAgenticBenchmark({
        adapters: { perfect: factory },
        fixture,
        taskIds: ["t0a1b2c3"],
        lifecycles: ["cold"],
        recordedAt: () => "2099-01-01T00:00:00.000Z",
      });
    };
    const first = await run();
    const second = await run();
    expect(receiptCanonicalJson(first.receipts[0] as never)).toBe(
      receiptCanonicalJson(second.receipts[0] as never)
    );
    expect(first.canonicalFingerprint).toBe(second.canonicalFingerprint);
  });
});

describe("agent-visible boundary", () => {
  test("passes no accounting backend temp or oracle metadata to the agent", async () => {
    const fixture = await loadAgenticFixture();
    const { factory } = createPerfectAdapterFactory(fixture.snapshot, {
      backendInvocations: 7,
    });
    const agent = new SpyAgentFactory();
    await runAgenticBenchmark({
      adapters: { perfect: factory },
      fixture,
      taskIds: ["t0a1b2c3"],
      lifecycles: ["cold"],
      agentFactory: agent,
    });

    const visible = canonicalJson(agent.histories.at(-1));
    expect(visible).toContain("INC-4827");
    expect(visible).not.toContain("modelVisibleUtf8Bytes");
    expect(visible).not.toContain("measuredTokens");
    expect(visible).not.toContain("tokenizerFingerprint");
    expect(visible).not.toContain("backendSourceHash");
    expect(visible).not.toContain("backendInvocations");
    expect(visible).not.toContain("/tmp/fake-index");
    expect(visible).not.toContain("oracle-only");
  });
});
