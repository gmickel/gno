import { expect, test } from "bun:test";

import type { AcceptanceManifest } from "../../evals/acceptance/manifest";
import type { RerankObservation } from "../../evals/acceptance/rerank-scenarios";

import {
  compareRerankScenarios,
  rerankScenarios,
  runRerankScenarioSchedule,
  verifyRerankFixturePins,
} from "../../evals/acceptance/rerank-scenarios";
import { canonicalFingerprint } from "../../evals/agentic/canonical";
import fixtures from "../../evals/fixtures/acceptance/rerank-long-input/fixtures.json";

const hash = "a".repeat(64);
function manifest(role: "baseline" | "candidate"): AcceptanceManifest {
  return {
    schemaVersion: "gno-acceptance-v1",
    role,
    identity: {
      commit: "a".repeat(40),
      indexId: "synthetic",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: { "node-llama-cpp": "3.19.1" },
      platform: "mock",
      architecture: "mock",
    },
    fixtureVersion: "rerank-scenarios-v1",
    fixtures: [
      { path: "schedule", sha256: canonicalFingerprint(rerankScenarios()) },
    ],
    models: [
      { role: "reranking", id: "mock", sha256: hash, tokenizerSha256: hash },
    ],
    cases: rerankScenarios().map((scenario) => ({
      caseId: scenario.caseId,
      fixtureSha256: canonicalFingerprint(scenario),
      surface: "sdk",
      preset: "mock",
      configuration: {},
    })),
    intendedDeltas: [],
  };
}
function observations(): RerankObservation[] {
  return rerankScenarios().map((scenario) => ({
    query: scenario.query,
    documents: [...scenario.documents],
    tokens: scenario.documents.map(() =>
      Array.from({ length: scenario.formattedTokens ?? 1 }, (_, index) => index)
    ),
    scores: (scenario.historicalScores ?? scenario.documents.map(() => 0.5))
      .map((score, index) => ({ index, score, rank: index + 1 }))
      .sort((a, b) => b.score - a.score)
      .map((item, index) => ({ ...item, rank: index + 1 })),
    durationMs: 1,
    backend: "mock",
  }));
}

test("frozen 45 cells, 69 ordered pairs and 122 scores remain unchanged", async () => {
  await verifyRerankFixturePins();
  const schedule = rerankScenarios();
  const historical = schedule.filter((item) => item.historicalScores);
  expect(historical).toHaveLength(69);
  expect(new Set(historical.map((item) => item.fixtureId)).size).toBe(45);
  expect(
    historical.reduce(
      (total, item) => total + (item.historicalScores?.length ?? 0),
      0
    )
  ).toBe(122);
  expect(
    schedule.find((item) => item.caseId === "long-query-full-pair")
      ?.formattedTokens
  ).toBe(6025);
  expect(schedule.slice(-5).map((item) => item.caseId)).toEqual([
    "long-query-full-pair",
    "shrink-after-long-query",
    "duplicate-ties",
    "unsupported-template",
    "restart-short",
  ]);
  for (const fixture of fixtures) {
    const prepared = [
      ...new Set(
        fixture.originals.map((text) =>
          text.length > 4000 ? `${text.slice(0, 4000)}...` : text
        )
      ),
    ];
    expect(fixture.texts).toEqual(prepared);
  }
});

test("exact fn143 comparator preserves token streams, scores and ties; retains slower pairs", () => {
  const baseline = observations();
  const candidate = observations();
  candidate[0]!.durationMs = 2;
  const result = compareRerankScenarios(
    { baseline: manifest("baseline"), candidate: manifest("candidate") },
    { baseline, candidate }
  );
  expect(result.passed).toBe(true);
  expect(result.comparison.comparedCases).toBe(74);
  expect(result.slowerPairs).toEqual(["EN-1000-start-repeat-0"]);
});

test("truncated input, changed scores/order and missing observations cannot pass", () => {
  for (const mutation of ["truncate", "score", "order", "missing"] as const) {
    const baseline = observations();
    const candidate = observations();
    const first = candidate[0]!;
    if (mutation === "truncate") {
      first.documents[0] = first.documents[0]!.slice(0, 512);
      first.tokens[0]!.pop();
    }
    if (mutation === "score") first.scores[0]!.score -= 0.01;
    if (mutation === "order")
      first.scores = first.scores
        .reverse()
        .map((item, index) => ({ ...item, rank: index + 1 }));
    if (mutation === "missing") candidate.pop();
    const result = compareRerankScenarios(
      { baseline: manifest("baseline"), candidate: manifest("candidate") },
      { baseline, candidate }
    );
    expect(result.passed).toBe(false);
  }
});

test("bounded schedule stops its owned workload after timeout without admitting another row", async () => {
  let calls = 0;
  let stopped = false;
  let aborted = false;
  const error = await runRerankScenarioSchedule({
    timeoutMs: 5,
    execute: (_side, _scenario, signal) => {
      calls++;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
    checkpoint: async () => {
      throw new Error("Unexpected checkpoint");
    },
    stop: async () => {
      stopped = true;
    },
  }).then(
    () => null,
    (reason: unknown) => reason
  );
  expect(String(error)).toContain("Scenario timeout");
  expect(calls).toBe(1);
  expect(stopped).toBe(true);
  expect(aborted).toBe(true);
});

test("equal bilateral truncation and partial scoring are rejected independently of equality", () => {
  const baseline = observations();
  baseline[0]!.documents[0] = "truncated";
  const candidate = structuredClone(baseline);
  const manifests = {
    baseline: manifest("baseline"),
    candidate: manifest("candidate"),
  };
  const result = compareRerankScenarios(manifests, { baseline, candidate });
  expect(result.comparison.passed).toBe(true);
  expect(result.passed).toBe(false);
  expect(result.inputDrift).toHaveLength(2);
  candidate[0]!.scores.pop();
  expect(() =>
    compareRerankScenarios(manifests, { baseline, candidate })
  ).toThrow("Incomplete");
});
