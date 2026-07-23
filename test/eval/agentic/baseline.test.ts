import { describe, expect, test } from "bun:test";
// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import type {
  BenchmarkReport,
  BenchmarkScoreRecord,
  CapsuleReplayRecord,
} from "../../../evals/agentic/types";

import {
  canonicalFingerprint,
  canonicalJson,
} from "../../../evals/agentic/canonical";
import {
  AGENTIC_FIXTURE_ROOT,
  loadAgenticFixture,
} from "../../../evals/agentic/fixture-db";
import {
  evaluatePromotionGates,
  pairPromotionCohorts,
} from "../../../evals/agentic/promotion";
import { benchmarkCanonicalProjection } from "../../../evals/agentic/report";
import {
  scoreRecordFor,
  scoreTrajectory,
} from "../../../evals/agentic/scoring";
import { validateAgenticSchema } from "../../../evals/agentic/validation";

const BASELINE_ROOT = join(AGENTIC_FIXTURE_ROOT, "baseline", "fixture-agent");

const identity = (value: {
  adapterId: string;
  taskId: string;
  trialId: string;
  lifecycle: string;
  seed: number | null;
  agentId: string;
}): string =>
  [
    value.adapterId,
    value.taskId,
    value.trialId,
    value.lifecycle,
    String(value.seed),
    value.agentId,
  ].join("\0");

describe("committed authoritative agentic baseline", () => {
  test("is schema-valid, complete, unique, and reproducibly scored", async () => {
    const report = (await Bun.file(
      join(BASELINE_ROOT, "report.json")
    ).json()) as BenchmarkReport;
    const fixture = await loadAgenticFixture();
    expect(validateAgenticSchema("benchmark-report", report)).toBeTrue();
    expect(report.attemptedPairs).toBe(144);
    expect(report.scoredPairs).toBe(144);
    expect(report.receipts).toHaveLength(144);
    expect(report.scores).toHaveLength(144);
    expect(report.exclusions).toEqual([]);
    expect(report.capsuleReplays).toHaveLength(48);
    expect(
      new Set(report.receipts.map((receipt) => identity(receipt.canonical)))
        .size
    ).toBe(144);
    expect(
      new Set(report.receipts.map((receipt) => receipt.canonical.adapterId))
    ).toEqual(new Set(["gno-mcp", "lexical", "capsule"]));
    expect(report.environment.git).toMatchObject({
      dirty: false,
      unavailableReason: null,
    });
    expect(report.environment.git.commit).toMatch(/^[a-f0-9]{40}$/);

    for (const [index, receipt] of report.receipts.entries()) {
      const task = fixture.tasks.get(receipt.canonical.taskId);
      const oracle = fixture.oracles.get(receipt.canonical.taskId);
      expect(task).toBeDefined();
      expect(oracle).toBeDefined();
      const expected = scoreRecordFor(
        receipt,
        scoreTrajectory(task!, oracle!, receipt)
      );
      expect(report.scores[index]).toEqual(expected);
    }
  });

  test("recomputes canonical fingerprint and passed promotion exactly", async () => {
    const report = (await Bun.file(
      join(BASELINE_ROOT, "report.json")
    ).json()) as BenchmarkReport;
    const { canonicalFingerprint: _fingerprint, ...withoutFingerprint } =
      report;
    expect(
      canonicalFingerprint(benchmarkCanonicalProjection(withoutFingerprint))
    ).toBe(report.canonicalFingerprint);
    const canonicalArtifact = await Bun.file(
      join(BASELINE_ROOT, "canonical.json")
    ).json();
    expect(canonicalArtifact).toEqual({
      canonicalFingerprint: report.canonicalFingerprint,
      projection: benchmarkCanonicalProjection(withoutFingerprint),
    });

    const scoreByIdentity = new Map(
      report.scores.map((score) => [identity(score), score])
    );
    const replayByIdentity = new Map(
      report.capsuleReplays.map((replay) => [identity(replay), replay])
    );
    const baseline = report.receipts
      .filter((receipt) => receipt.canonical.adapterId === "gno-mcp")
      .map((receipt) => ({
        receipt,
        score: scoreByIdentity.get(
          identity(receipt.canonical)
        ) as BenchmarkScoreRecord,
      }));
    const candidate = report.receipts
      .filter((receipt) => receipt.canonical.adapterId === "capsule")
      .map((receipt) => ({
        receipt,
        score: scoreByIdentity.get(
          identity(receipt.canonical)
        ) as BenchmarkScoreRecord,
        replay: replayByIdentity.get(
          identity(receipt.canonical)
        ) as CapsuleReplayRecord,
      }));
    expect(report.promotion).not.toBeNull();
    expect(
      evaluatePromotionGates(pairPromotionCohorts(baseline, candidate))
    ).toEqual(report.promotion!);
    expect(report.promotion).toMatchObject({
      passed: true,
      pairCount: 48,
      failures: [],
      metrics: {
        baselineSuccessRate: 0.9583333333333334,
        candidateSuccessRate: 1,
        agentCallReduction: 0.4893617021276596,
        contextByteReduction: 0.499475208866871,
        claimLinkageRate: 1,
      },
    });
  });

  test("projects volatile paths out of committed observations", async () => {
    const observations = await Bun.file(
      join(BASELINE_ROOT, "observations.json")
    ).text();
    expect(observations).not.toMatch(/\/Users\/|\/private\/|\/var\/folders\//);
    expect(observations).toContain('"<temp>"');
    expect(canonicalJson(JSON.parse(observations))).toBeTruthy();
  });
});
