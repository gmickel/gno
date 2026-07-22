import { describe, expect, test } from "bun:test";

import { sha256Text } from "../../../src/core/context-capsule-validation";
import { contextCapsuleVerificationSchema } from "../../../src/core/context-capsule-verification";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const HASH = {
  config: sha256Text("config"),
  index: sha256Text("index"),
  mirror: sha256Text("mirror"),
  retrieval: sha256Text("retrieval"),
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
    currentFingerprints: {
      config: HASH.config,
      retrieval: HASH.retrieval,
      embeddingModel: null,
      rerankModel: null,
      tokenizer: null,
      index: HASH.index,
    },
    fingerprintStatus: "unchanged" as const,
    fingerprintReasons: [],
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

    const missingMirror = {
      ...missing,
      evidence: [
        {
          ...missing.evidence[0]!,
          contentCode: "mirror_missing" as const,
          currentSourceHash: HASH.source,
          currentMirrorHash: HASH.mirror,
        },
      ],
    };
    expect(contextCapsuleVerificationSchema.parse(missingMirror)).toEqual(
      missingMirror
    );
    expect(assertValid(missingMirror, schema)).toBe(true);
    const missingUnregisteredMirror = {
      ...missingMirror,
      evidence: [
        {
          ...missingMirror.evidence[0]!,
          currentMirrorHash: null,
        },
      ],
    };
    expect(
      contextCapsuleVerificationSchema.parse(missingUnregisteredMirror)
    ).toEqual(missingUnregisteredMirror);
    expect(assertValid(missingUnregisteredMirror, schema)).toBe(true);
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

  test("requires distinct canonically ordered fingerprint drift reasons", async () => {
    const schema = await loadSchema("context-capsule-verification");
    const drifted = {
      ...receipt,
      fingerprintStatus: "drifted" as const,
      fingerprintReasons: ["config_changed", "index_changed"] as const,
    };
    expect(contextCapsuleVerificationSchema.safeParse(drifted).success).toBe(
      true
    );
    expect(assertValid(drifted, schema)).toBe(true);

    for (const reasons of [
      ["index_changed", "config_changed"],
      ["config_changed", "config_changed"],
    ]) {
      const invalid = { ...drifted, fingerprintReasons: reasons };
      expect(contextCapsuleVerificationSchema.safeParse(invalid).success).toBe(
        false
      );
      expect(assertInvalid(invalid, schema)).toBe(true);
    }
  });
});
