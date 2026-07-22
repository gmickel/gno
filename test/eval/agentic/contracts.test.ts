import { describe, expect, test } from "bun:test";

import {
  canonicalFingerprint,
  exactLineSpan,
  normalizeNewlines,
  receiptCanonicalFingerprint,
  sha256Bytes,
  sourceHash,
  spanHash,
} from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  AGENT_TASK_CATEGORIES,
  type AgentTask,
  type BenchmarkReport,
  type FinalEnvelope,
  type HiddenOracle,
  type TrajectoryReceipt,
} from "../../../evals/agentic/types";
import {
  assertAgenticSchema,
  listAgenticSchemas,
  projectAgentVisibleTask,
  validateAgenticSchema,
  validateFinalEnvelopeSemantics,
} from "../../../evals/agentic/validation";
import {
  evidence,
  finalEnvelopeFixture,
  oracleFixture,
  receiptFixture,
  taskFixture,
} from "./fixtures";

describe("agentic retrieval schemas", () => {
  test("compiles all five closed versioned schemas", () => {
    expect(listAgenticSchemas()).toEqual([
      "agent-task",
      "benchmark-report",
      "final-envelope",
      "hidden-oracle",
      "trajectory-receipt",
    ]);
    expect(() =>
      assertAgenticSchema("agent-task", taskFixture())
    ).not.toThrow();
    expect(() =>
      assertAgenticSchema("hidden-oracle", oracleFixture())
    ).not.toThrow();
    expect(() =>
      assertAgenticSchema("final-envelope", finalEnvelopeFixture())
    ).not.toThrow();
    expect(() =>
      assertAgenticSchema("trajectory-receipt", receiptFixture())
    ).not.toThrow();
  });

  test("rejects root and nested extra properties", () => {
    const task = structuredClone(taskFixture()) as AgentTask & {
      answer?: string;
    };
    task.answer = "INC-4827";
    expect(validateAgenticSchema("agent-task", task)).toBeFalse();

    const oracle = structuredClone(oracleFixture()) as HiddenOracle;
    (oracle.claims[0] as unknown as Record<string, unknown>).hint = "secret";
    expect(validateAgenticSchema("hidden-oracle", oracle)).toBeFalse();

    const envelope = structuredClone(finalEnvelopeFixture()) as FinalEnvelope;
    const claim = envelope.claims[0];
    if (!claim) throw new Error("claim missing");
    (claim.value as unknown as Record<string, unknown>).prose = "unsupported";
    expect(validateAgenticSchema("final-envelope", envelope)).toBeFalse();

    const receipt = structuredClone(receiptFixture()) as TrajectoryReceipt;
    (receipt.canonical as unknown as Record<string, unknown>).durationMs = 10;
    expect(validateAgenticSchema("trajectory-receipt", receipt)).toBeFalse();
  });

  test("forbids prose answers and invalid tagged values", () => {
    const withAnswer = {
      ...finalEnvelopeFixture(),
      answer: "The answer is INC-4827.",
    };
    expect(validateAgenticSchema("final-envelope", withAnswer)).toBeFalse();

    const wrongTag = finalEnvelopeFixture();
    wrongTag.claims[0] = {
      claimKey: "incidentId",
      value: { type: "number", value: 4827 },
      citations: [evidence()],
    };
    expect(validateAgenticSchema("final-envelope", wrongTag)).toBeTrue();
    expect(
      validateFinalEnvelopeSemantics(taskFixture(), wrongTag)
    ).toContainEqual({
      code: "type_mismatch",
      claimKey: "incidentId",
    });

    const invalidDate = finalEnvelopeFixture();
    invalidDate.claims[0] = {
      claimKey: "incidentId",
      value: { type: "date", value: "22 July" },
      citations: [evidence()],
    };
    expect(validateAgenticSchema("final-envelope", invalidDate)).toBeFalse();
  });

  test("semantic validation rejects duplicate unknown and uncited claims", () => {
    const envelope = finalEnvelopeFixture();
    envelope.claims.push({
      claimKey: "incidentId",
      value: { type: "identifier", value: "INC-4827" },
      citations: [],
    });
    envelope.claims.push({
      claimKey: "answerText",
      value: { type: "string", value: "unsupported" },
      citations: [],
    });
    const issues = validateFinalEnvelopeSemantics(taskFixture(), envelope);
    expect(issues).toContainEqual({
      code: "duplicate_claim",
      claimKey: "incidentId",
    });
    expect(issues).toContainEqual({
      code: "uncited_required_claim",
      claimKey: "incidentId",
    });
    expect(issues).toContainEqual({
      code: "extra_claim",
      claimKey: "answerText",
    });
  });

  test("requires an explicit reason for unavailable observations", () => {
    const receipt = receiptFixture();
    receipt.observations.timings.tool = {
      valueMs: null,
      unavailableReason: null,
    };
    expect(validateAgenticSchema("trajectory-receipt", receipt)).toBeFalse();
  });
});

describe("agentic fixture inventory and projection", () => {
  test("loads 24 opaque tasks across every required category", async () => {
    const fixture = await loadAgenticFixture();
    expect(fixture.tasks.size).toBe(24);
    expect(fixture.oracles.size).toBe(24);
    expect(fixture.snapshot.files.length).toBeGreaterThanOrEqual(24);
    const categories = new Set(
      [...fixture.tasks.values()].map((task) => task.category)
    );
    expect(
      [...AGENT_TASK_CATEGORIES].every((category) => categories.has(category))
    ).toBeTrue();
    expect(
      [...fixture.tasks.values()].filter(
        (task) => task.category === "multilingual"
      ).length
    ).toBeGreaterThanOrEqual(4);
    expect(
      [...fixture.oracles.values()].filter(
        (oracle) => oracle.completion.expectAbstention
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  test("agent-visible projection excludes oracle fields and canaries", async () => {
    const fixture = await loadAgenticFixture();
    for (const [taskId, task] of fixture.tasks) {
      const projection = projectAgentVisibleTask(task);
      expect(Object.isFrozen(projection.brief)).toBe(true);
      expect(Object.isFrozen(projection.claims)).toBe(true);
      const visible = JSON.stringify(projection);
      expect(visible).not.toContain("expectedValue");
      expect(visible).not.toContain("normalizer");
      expect(visible).not.toContain("requiredEvidence");
      const oracle = fixture.oracles.get(taskId);
      expect(oracle).toBeDefined();
      for (const canary of oracle?.leakCanaries ?? []) {
        expect(visible).not.toContain(canary);
      }
      expect(taskId).toMatch(/^t[0-9a-f]{7}$/);
    }
  });

  test("manifest has exact task oracle corpus inventory and stable hash", async () => {
    const fixture = await loadAgenticFixture();
    const entries = fixture.manifest.files;
    expect(entries.filter((entry) => entry.kind === "task")).toHaveLength(24);
    expect(entries.filter((entry) => entry.kind === "oracle")).toHaveLength(24);
    expect(entries.filter((entry) => entry.kind === "corpus")).toHaveLength(
      fixture.snapshot.files.length
    );
    expect(fixture.snapshot.fingerprint).toBe(
      fixture.manifest.corpusFingerprint
    );
    expect(fixture.manifest.license).toBe("MIT");
  });
});

describe("canonical evidence and receipt semantics", () => {
  test("uses exact UTF-8 source bytes and LF-normalized inclusive spans", () => {
    const source = "first\r\nCafe\u0301\rthird\r\n";
    expect(normalizeNewlines(source)).toBe("first\nCafe\u0301\nthird\n");
    expect(exactLineSpan(source, 2, 3)).toBe("Cafe\u0301\nthird");
    expect(sourceHash(source)).toBe(sha256Bytes(source));
    expect(spanHash(source, 2, 3)).toBe(sha256Bytes("Cafe\u0301\nthird"));
    expect(spanHash(source, 2, 2)).not.toBe(
      spanHash(source.normalize("NFC"), 2, 2)
    );
  });

  test("does not synthesize a trailing newline for the final line", () => {
    expect(exactLineSpan("one\ntwo\n", 2, 2)).toBe("two");
    expect(exactLineSpan("one\ntwo", 2, 2)).toBe("two");
    expect(() => exactLineSpan("one\n", 2, 2)).toThrow();
  });

  test("canonical receipt fingerprint excludes observations", () => {
    const first = receiptFixture();
    const second = structuredClone(first);
    second.observations.recordedAt = "2026-07-23T12:00:00.000Z";
    second.observations.tempPaths = ["/different/path"];
    second.observations.timings.tool = {
      valueMs: 999,
      unavailableReason: null,
    };
    expect(receiptCanonicalFingerprint(first)).toBe(
      receiptCanonicalFingerprint(second)
    );
    expect(canonicalFingerprint(first)).not.toBe(canonicalFingerprint(second));
  });

  test("benchmark report schema closes nested score objects", () => {
    const report: BenchmarkReport = {
      schemaVersion: "1.0",
      benchmarkId: "agentic-retrieval@1",
      fixtureFingerprint: "0".repeat(64),
      attemptedPairs: 0,
      scoredPairs: 0,
      exclusions: [],
      receipts: [],
      scores: [],
      promotion: null,
    };
    expect(validateAgenticSchema("benchmark-report", report)).toBeTrue();
    (report as unknown as Record<string, unknown>).generatedAt = "volatile";
    expect(validateAgenticSchema("benchmark-report", report)).toBeFalse();
  });
});
