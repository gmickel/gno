import { describe, expect, test } from "bun:test";

import { sha256Text } from "../../../src/core/context-capsule-validation";
import { contextCapsuleVerificationSchema } from "../../../src/core/context-capsule-verification";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const HASH = {
  index: sha256Text("index"),
  mirror: sha256Text("mirror"),
  source: sha256Text("source"),
};

describe("Context Capsule verification contract", () => {
  const unchangedEvidence = {
    evidenceId: sha256Text("evidence"),
    uri: "gno://notes/decision.md",
    contentStatus: "unchanged" as const,
    contentCode: "verified_unchanged" as const,
    rankingStatus: "unchanged" as const,
    rankingCode: "ranking_unchanged" as const,
    currentSourceHash: HASH.source,
    currentMirrorHash: HASH.mirror,
    currentPassageHash: sha256Text("passage"),
    currentRetrievalRank: 1,
  };
  const receipt = {
    schemaVersion: "1.0" as const,
    coordinateSpace: "canonical_mirror" as const,
    capsuleId: sha256Text("capsule"),
    operationStatus: "completed" as const,
    contentStatus: "unchanged" as const,
    contentCode: "verified_unchanged" as const,
    rankingStatus: "unchanged" as const,
    rankingCode: "ranking_unchanged" as const,
    indexSnapshot: {
      before: HASH.index,
      after: HASH.index,
      stable: true as const,
    },
    evidence: [unchangedEvidence],
  };

  test("accepts unchanged, stale, and missing as successful non-mutating receipts", async () => {
    const schema = await loadSchema("context-capsule-verification");
    expect(contextCapsuleVerificationSchema.parse(receipt)).toEqual(receipt);
    expect(assertValid(receipt, schema)).toBe(true);

    const staleEvidence = {
      ...unchangedEvidence,
      contentStatus: "stale" as const,
      contentCode: "passage_stale" as const,
      rankingStatus: "unavailable" as const,
      rankingCode: "ranking_unavailable" as const,
      currentRetrievalRank: null,
    };
    const stale = {
      ...receipt,
      contentStatus: "stale" as const,
      contentCode: "content_stale" as const,
      rankingStatus: "unavailable" as const,
      rankingCode: "ranking_unavailable" as const,
      evidence: [staleEvidence],
    };
    expect(contextCapsuleVerificationSchema.parse(stale)).toEqual(stale);
    expect(assertValid(stale, schema)).toBe(true);

    const missing = {
      ...stale,
      contentStatus: "missing" as const,
      contentCode: "content_missing" as const,
      evidence: [
        {
          ...staleEvidence,
          contentStatus: "missing" as const,
          contentCode: "source_missing" as const,
          currentSourceHash: null,
          currentMirrorHash: null,
          currentPassageHash: null,
        },
      ],
    };
    expect(contextCapsuleVerificationSchema.parse(missing)).toEqual(missing);
    expect(assertValid(missing, schema)).toBe(true);
  });

  test("rejects stale evidence presented as reranked and false aggregate status", async () => {
    const schema = await loadSchema("context-capsule-verification");
    const staleReranked = {
      ...receipt,
      contentStatus: "stale",
      contentCode: "content_stale",
      rankingStatus: "reranked",
      rankingCode: "ranking_changed",
      evidence: [
        {
          ...unchangedEvidence,
          contentStatus: "stale",
          contentCode: "source_stale",
          rankingStatus: "reranked",
          rankingCode: "ranking_changed",
        },
      ],
    };
    expect(
      contextCapsuleVerificationSchema.safeParse(staleReranked).success
    ).toBe(false);
    expect(assertInvalid(staleReranked, schema)).toBe(true);

    expect(
      contextCapsuleVerificationSchema.safeParse({
        ...receipt,
        contentStatus: "missing",
        contentCode: "content_missing",
      }).success
    ).toBe(false);
  });
});
