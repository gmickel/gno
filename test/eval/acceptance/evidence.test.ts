import { expect, test } from "bun:test";

import type {
  EvidenceFixtures,
  EvidenceObservation,
  ObservedPassage,
} from "../../../evals/acceptance/evidence-schema";

import {
  evaluateEvidenceRun,
  goldExtent,
  scoreEvidence,
  validateEvidenceFixtures,
} from "../../../evals/acceptance/evidence";
import { loadEvidenceFixtures } from "../../../evals/acceptance/evidence-fixtures";
import { canonicalFingerprint } from "../../../evals/agentic/canonical";

const { fixtures } = await loadEvidenceFixtures();
function passage(id: string, inputId = "request"): ObservedPassage {
  const span = goldExtent(fixtures, id);
  const document = fixtures.documents.find((d) => d.uri === span.uri)!;
  return {
    uri: span.uri,
    sourceHash: span.sourceHash,
    start: span.start,
    end: span.end,
    text: document.content.slice(span.start, span.end),
    inputId,
    selectedEnd: null,
  };
}
function observation(
  caseId = "exact-code",
  arm: "current" | "noExpand" = "current"
): EvidenceObservation {
  const item = fixtures.cases.find((c) => c.caseId === caseId)!;
  const passages = (item.requiredSets[0] ?? []).map((id) => passage(id));
  const visibleBytes = passages.reduce(
    (sum, p) => sum + Buffer.byteLength(p.text),
    0
  );
  return {
    caseId,
    arm,
    noExpand: arm === "noExpand",
    fixtureSha256: canonicalFingerprint(fixtures),
    identitySha256: "a".repeat(64),
    tokenBudget: item.tokenBudget,
    byteBudget: item.byteBudget,
    coverage: "complete",
    reasons: [],
    stages: {
      retrieval: passages,
      fusion: passages,
      rerank_input: passages,
      delivery: passages,
    },
    reader: {
      answer: item.expectedValues.join(", "),
      abstained: item.expectAbstention,
      verified: true,
    },
    cost: {
      visibleBytes,
      usedTokens: visibleBytes,
      estimator: "unicode_conservative",
      readerOutputBytes: null,
      readerOutputTokens: null,
      tokenizations: null,
      durationMs: 1,
      rssBytes: null,
    },
  };
}
function run(
  observations = fixtures.cases.flatMap((c) => [
    observation(c.caseId),
    observation(c.caseId, "noExpand"),
  ])
) {
  return { schemaVersion: "gno-evidence-run-v1", kind: "replay", observations };
}

test("pinned corpus covers all families and a complete replay remains explicitly non-native", () => {
  expect(new Set(fixtures.cases.map((c) => c.family)).size).toBe(14);
  const report = evaluateEvidenceRun(fixtures, run());
  expect(report.passed).toBe(true);
  expect(report.kind).toBe("replay");
  expect(report.scores.every((s) => s.groundedTaskSuccess)).toBe(true);
});

test("full verified span required: one-line overlap and clipped tail cannot masquerade as complete", () => {
  const observed = observation();
  const original = passage("retry");
  observed.stages.rerank_input = [
    {
      ...original,
      end: original.end - 1,
      text: original.text.slice(0, -1),
      selectedEnd: original.end,
    },
  ];
  const score = scoreEvidence(fixtures, observed);
  expect(score.stages.rerank_input.spans.retry).toBe("clipped");
  expect(score.firstLossStage).toBe("rerank_input");
  observed.stages.rerank_input[0]!.selectedEnd = null;
  expect(
    scoreEvidence(fixtures, observed).stages.rerank_input.spans.retry
  ).toBe("partial");
});

test("fragments combine only in the same actual model input, and duplicate votes add nothing", () => {
  const observed = observation();
  const whole = passage("retry");
  const middle = whole.start + 20;
  const left = { ...whole, end: middle, text: whole.text.slice(0, 20) };
  const right = {
    ...whole,
    start: middle,
    text: whole.text.slice(20),
    inputId: "other",
  };
  observed.stages.rerank_input = [left, left, right];
  expect(
    scoreEvidence(fixtures, observed).stages.rerank_input.spans.retry
  ).toBe("split-across-inputs");
  right.inputId = left.inputId;
  expect(
    scoreEvidence(fixtures, observed).stages.rerank_input.spans.retry
  ).toBe("complete");
  observed.stages.rerank_input = [left, left, left];
  expect(
    scoreEvidence(fixtures, observed).stages.rerank_input.spans.retry
  ).toBe("partial");
});

test("multi-source questions require every source, alternatives accept one sufficient set", () => {
  const observed = observation("launch-approvals");
  observed.stages.delivery = [passage("engineering")];
  const score = scoreEvidence(fixtures, observed);
  expect(score.stages.delivery.any).toBe(true);
  expect(score.stages.delivery.all).toBe(false);
  expect(score.groundedTaskSuccess).toBe(false);
  const alternate = observation("german-retention");
  alternate.stages.delivery = [passage("retention")];
  expect(scoreEvidence(fixtures, alternate).stages.delivery.all).toBe(true);
});

test("unobserved stages are unknown, never inferred from later document hits", () => {
  const observed = observation();
  observed.stages.fusion = null;
  expect(scoreEvidence(fixtures, observed).stages.fusion).toEqual({
    all: null,
    any: null,
    spans: { retry: "unknown" },
  });
  observed.stages.delivery = [];
  expect(scoreEvidence(fixtures, observed).stages.delivery.all).toBe(false);
});

test("stale hashes, forged text, out-of-scope witnesses and underreported bytes invalidate observations", () => {
  for (const mutation of [
    (o: EvidenceObservation) => {
      o.stages.delivery![0]!.sourceHash = "0".repeat(64);
    },
    (o: EvidenceObservation) => {
      o.stages.delivery![0]!.text += "fiction";
    },
    (o: EvidenceObservation) => {
      o.stages.delivery![0]!.uri = "gno://private/customer-notes.md";
    },
    (o: EvidenceObservation) => {
      o.cost.visibleBytes = 0;
    },
    (o: EvidenceObservation) => {
      o.cost.usedTokens = o.tokenBudget + 1;
    },
    (o: EvidenceObservation) => {
      o.cost.usedTokens = 0;
    },
  ]) {
    const observed = structuredClone(observation());
    mutation(observed);
    expect(scoreEvidence(fixtures, observed).valid).toBe(false);
  }
});

test("fixture tampering, blank gold sets, duplicate IDs and unknown evidence fail closed", () => {
  const changes = [
    (f: EvidenceFixtures) => {
      f.documents[0]!.content += "changed";
    },
    (f: EvidenceFixtures) => {
      f.spans[0]!.endLine = 999;
    },
    (f: EvidenceFixtures) => {
      f.cases[0]!.requiredSets = [];
    },
    (f: EvidenceFixtures) => {
      f.cases[0]!.requiredSets = [["unknown"]];
    },
    (f: EvidenceFixtures) => {
      f.cases.push(f.cases[0]!);
    },
  ];
  for (const change of changes) {
    const f = structuredClone(fixtures);
    change(f);
    expect(() => validateEvidenceFixtures(f)).toThrow();
  }
});

test("missing or duplicate pairs, identity mismatch and fallback cannot be scored green", () => {
  const receipt = run();
  expect(() =>
    evaluateEvidenceRun(fixtures, {
      ...receipt,
      observations: receipt.observations.slice(1),
    })
  ).toThrow("Missing paired");
  expect(() =>
    evaluateEvidenceRun(fixtures, {
      ...receipt,
      observations: [...receipt.observations, receipt.observations[0]],
    })
  ).toThrow("Duplicate");
  receipt.observations[1]!.identitySha256 = "b".repeat(64);
  expect(evaluateEvidenceRun(fixtures, receipt).valid).toBe(false);
  const degraded = run();
  degraded.observations[0]!.coverage = "incomplete";
  expect(evaluateEvidenceRun(fixtures, degraded).passed).toBe(false);
  expect(
    evaluateEvidenceRun(fixtures, { ...run(), kind: "native" }).passed
  ).toBe(false);
  expect(evaluateEvidenceRun(fixtures, { ...run(), kind: "native" }).kind).toBe(
    "replay"
  );
  expect(() => evaluateEvidenceRun(fixtures, run(), "native")).toThrow(
    "cannot certify"
  );
});

test("baseline failures stay visible and held-out regressions cannot be averaged away", () => {
  const receipt = run();
  const target = receipt.observations.find(
    (o) => o.caseId === "service-owner" && o.arm === "noExpand"
  )!;
  target.stages.delivery = [];
  const report = evaluateEvidenceRun(fixtures, receipt);
  expect(report.passed).toBe(false);
  expect(report.reasons).toContain("held_out_regression:service-owner");
  expect(
    report.paired.find((p) => p.caseId === "service-owner")!.candidateMiss
  ).toBe(true);
  const baseline = receipt.observations.find(
    (o) => o.caseId === "exact-code" && o.arm === "current"
  )!;
  baseline.stages.delivery = [];
  expect(evaluateEvidenceRun(fixtures, receipt).reasons).toContain(
    "must_cover_miss:exact-code"
  );
});

test("correct abstention is separate from retrieval coverage and unsupported claims fail", () => {
  const missing = observation("missing-policy");
  expect(scoreEvidence(fixtures, missing).correctAbstention).toBe(true);
  expect(scoreEvidence(fixtures, missing).stages.delivery.all).toBeNull();
  missing.reader = { answer: "2030", abstained: false, verified: false };
  expect(scoreEvidence(fixtures, missing).groundedTaskSuccess).toBe(false);
  const answer = observation();
  answer.reader!.verified = false;
  expect(scoreEvidence(fixtures, answer).groundedTaskSuccess).toBe(false);
});
