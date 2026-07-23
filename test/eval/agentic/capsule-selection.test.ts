import { describe, expect, test } from "bun:test";

import type { CapsuleCandidate } from "../../../evals/agentic/capsule-selection";

import { sha256Bytes } from "../../../evals/agentic/canonical";
import {
  collapseCapsuleCandidates,
  selectCapsuleEvidence,
} from "../../../evals/agentic/capsule-selection";

const candidate = (
  startLine: number,
  endLine: number,
  text: string,
  facets: string[],
  retrievalRank = 0
): CapsuleCandidate => ({
  uri: "gno://c001/doc.md",
  sourceHash: sha256Bytes("source"),
  startLine,
  endLine,
  spanHash: sha256Bytes(text),
  sourceHashProvenance: "harness_observed",
  spanHashProvenance: "harness_observed",
  text,
  backendSourceHash: null,
  backendSpanHash: null,
  backendHashUnavailableReason: "not exposed",
  retrievalRank,
  facets,
});

describe("Capsule evidence selection", () => {
  test("collapses exact duplicates and overlapping spans deterministically", () => {
    const exact = candidate(3, 3, "answer", ["answer"], 0);
    const selection = collapseCapsuleCandidates([
      candidate(2, 4, "context\nanswer\nextra", ["answer"], 3),
      exact,
      structuredClone(exact),
      candidate(7, 7, "other", ["other"], 4),
    ]);

    expect(
      selection.evidence.map((item) => [item.startLine, item.endLine])
    ).toEqual([
      [3, 3],
      [7, 7],
    ]);
    expect(selection.omitted.map((item) => item.reason).sort()).toEqual([
      "duplicate",
      "overlap",
    ]);
  });

  test("uses marginal facet coverage and one caller-measured global budget", () => {
    const candidates = [
      candidate(1, 1, "alpha", ["alpha"], 0),
      candidate(2, 2, "beta", ["beta"], 1),
      candidate(3, 3, "alpha beta", ["alpha", "beta"], 2),
    ];
    const selection = selectCapsuleEvidence(
      candidates,
      (selected) =>
        selected.reduce((sum, item) => sum + item.text.length, 0) <= 10
    );

    expect(selection.evidence.map((item) => item.text)).toEqual(["alpha beta"]);
    expect(selection.omitted.map((item) => item.reason)).toEqual([
      "redundant_coverage",
      "redundant_coverage",
    ]);
  });

  test("stops once each source has no new requested facet evidence", () => {
    const selection = selectCapsuleEvidence(
      [
        candidate(1, 1, "complete", ["owner", "date"], 0),
        candidate(2, 2, "duplicate owner", ["owner"], 1),
        candidate(3, 3, "no facet", [], 2),
      ],
      () => true
    );

    expect(selection.evidence.map((item) => item.text)).toEqual(["complete"]);
    expect(selection.omitted.map((item) => item.reason)).toEqual([
      "redundant_coverage",
      "redundant_coverage",
    ]);
  });
});
