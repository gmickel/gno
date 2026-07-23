import { describe, expect, test } from "bun:test";

import { sha256Text } from "../../src/core/context-capsule-validation";
import { verifyContextCapsule } from "../../src/core/context-verifier";
import {
  CLAIM_ABSTENTION_TEXT,
  segmentSubstantiveClaims,
  semanticClaimJudgmentSchema,
  verifyClaimsDeterministically,
} from "../../src/pipeline/claim-verification";
import {
  capsuleFor,
  createVerifierStore,
  FINGERPRINTS,
  verifierDeps,
  verifierFixture,
} from "../core/context-verifier-fixture";
import {
  assertInvalid,
  assertValid,
  loadSchema,
} from "../spec/schemas/validator";

const setup = async () => {
  const fixture = verifierFixture(false);
  const harness = createVerifierStore(fixture.state);
  const capsule = await capsuleFor(harness.store, fixture.state);
  const receipt = await verifyContextCapsule(
    capsule,
    verifierDeps(harness.store, capsule)
  );
  return { ...fixture, ...harness, capsule, receipt };
};

const marker = (evidenceId: string): string => `[evidence:${evidenceId}]`;

const judgment = (
  claimId: string,
  evidenceIds: string[],
  verdict: "supported" | "contradicted" = "supported"
) => ({
  claimId,
  verdict,
  confidence: 0.91,
  evidenceIds,
  rationaleCode:
    verdict === "supported"
      ? ("semantic_entailment" as const)
      : ("semantic_contradiction" as const),
  verifierFingerprint: sha256Text("verifier"),
});

describe("claim verification deterministic hygiene", () => {
  test("preserves exact half-open UTF-16 claim spans and ignores citation artifacts", async () => {
    const { capsule } = await setup();
    const id = capsule.evidence[0]!.evidenceId;
    const answer = `🧭 Mina owns it ${marker(id)}.\n${marker(id)}\nReview Friday; Omar agrees?`;
    const claims = segmentSubstantiveClaims(answer, capsule.capsuleId);

    expect(claims.map((claim) => claim.text)).toEqual([
      `🧭 Mina owns it ${marker(id)}.`,
      "Review Friday;",
      "Omar agrees?",
    ]);
    for (const claim of claims) {
      expect(answer.slice(claim.start, claim.end)).toBe(claim.text);
    }
    expect(claims[0]!.start).toBe(0);
    expect(claims[0]!.end).toBe(`🧭 Mina owns it ${marker(id)}.`.length);
    expect(segmentSubstantiveClaims(answer, capsule.capsuleId)).toStrictEqual(
      claims
    );
  });

  test("keeps numeric/date claims, abbreviations, and fenced code deterministic", async () => {
    const { capsule } = await setup();
    const answer =
      "Dr. Mina approved 2026-07-23.\n42.\n```ts\nconst x = 1.5;\n```\nReview done.";
    const claims = segmentSubstantiveClaims(answer, capsule.capsuleId);
    expect(claims.map((claim) => claim.text)).toEqual([
      "Dr. Mina approved 2026-07-23.",
      "42.",
      "Review done.",
    ]);
    expect(
      segmentSubstantiveClaims("2026-07-23.", capsule.capsuleId)
    ).toHaveLength(1);
    expect(segmentSubstantiveClaims("42.", capsule.capsuleId)).toHaveLength(1);
    for (const claim of claims) {
      expect(answer.slice(claim.start, claim.end)).toBe(claim.text);
    }
  });

  test("requires unchanged Capsule evidence and semantic judgment for support", async () => {
    const { capsule, receipt } = await setup();
    const evidence = capsule.evidence[0]!;
    const answer = `Mina owns the decision ${marker(evidence.evidenceId)}.`;
    const deterministic = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });

    expect(deterministic.claims[0]).toMatchObject({
      status: "uncertain",
      confidence: null,
      rationaleCode: "semantic_judgment_unavailable",
      verifierFingerprint: null,
      evidence: [
        {
          evidenceId: evidence.evidenceId,
          text: evidence.text,
          startLine: evidence.startLine,
          endLine: evidence.endLine,
          sourceHash: evidence.sourceHash,
          mirrorHash: evidence.mirrorHash,
          passageHash: evidence.passageHash,
        },
      ],
    });
    expect(deterministic.claims[0]!.evidence[0]!.text).toBe(evidence.text);
    expect(deterministic.abstentionReason).toBe("coverage_below_threshold");

    const supported = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
      semanticJudgments: [
        judgment(deterministic.claims[0]!.claimId, [evidence.evidenceId]),
      ],
    });
    expect(supported.claims[0]!.status).toBe("supported");
    expect(supported.coverage).toEqual({
      totalClaims: 1,
      supportedClaims: 1,
      contradictedClaims: 0,
      insufficientClaims: 0,
      uncertainClaims: 0,
      supportedRatio: 1,
    });
    expect(supported).toMatchObject({
      coverageThreshold: 1,
      answerStatus: "verified",
      abstained: false,
      abstentionReason: null,
      abstentionText: null,
    });
  });

  test("rejects absent, malformed, out-of-Capsule, stale, and mismatched freshness", async () => {
    const setupResult = await setup();
    const { capsule, receipt, state, store } = setupResult;
    const evidence = capsule.evidence[0]!;
    const unknownId = sha256Text("not-in-capsule");
    const cases: Array<{
      freshness?: unknown;
      citation: string;
      reason: string;
    }> = [
      {
        citation: marker(evidence.evidenceId),
        reason: "freshness_unavailable",
      },
      {
        freshness: { schemaVersion: "not-a-receipt" },
        citation: marker(evidence.evidenceId),
        reason: "freshness_receipt_invalid",
      },
      {
        freshness: receipt,
        citation: "[evidence:not-a-hash]",
        reason: "malformed_citation",
      },
      {
        freshness: receipt,
        citation: marker(unknownId),
        reason: "out_of_capsule",
      },
      {
        freshness: { ...receipt, capsuleId: sha256Text("wrong-capsule") },
        citation: marker(evidence.evidenceId),
        reason: "freshness_receipt_mismatch",
      },
    ];

    for (const item of cases) {
      const result = verifyClaimsDeterministically({
        answer: `Claim ${item.citation}.`,
        capsule,
        freshness: item.freshness,
      });
      expect(result.claims[0]).toMatchObject({
        status: "insufficient",
        rationaleCode: "no_valid_evidence",
        evidence: [],
        rejectedCitations: [{ reason: item.reason }],
      });
    }

    state.documents[0] = {
      ...state.documents[0]!,
      sourceHash: sha256Text("changed-source"),
      docid: `#${sha256Text("changed-source").slice(0, 6)}`,
    };
    const staleReceipt = await verifyContextCapsule(
      capsule,
      verifierDeps(store, capsule)
    );
    const stale = verifyClaimsDeterministically({
      answer: `Claim ${marker(evidence.evidenceId)}.`,
      capsule,
      freshness: staleReceipt,
      semanticJudgments: [
        judgment(sha256Text("irrelevant"), [evidence.evidenceId]),
      ],
    });
    expect(stale.claims[0]).toMatchObject({
      status: "insufficient",
      evidence: [],
      rejectedCitations: [{ reason: "evidence_stale" }],
    });
  });

  test("does not confuse missing evidence with contradiction", async () => {
    const { capsule, state, store } = await setup();
    const evidence = capsule.evidence[0]!;
    const answer = `Mina does not own it ${marker(evidence.evidenceId)}.`;
    state.documents = state.documents.slice(1);
    const missingReceipt = await verifyContextCapsule(
      capsule,
      verifierDeps(store, capsule)
    );
    expect(missingReceipt.evidence[0]!.contentStatus).toBe("missing");
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: missingReceipt,
    });
    const result = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: missingReceipt,
      semanticJudgments: [
        judgment(
          preliminary.claims[0]!.claimId,
          [evidence.evidenceId],
          "contradicted"
        ),
      ],
    });
    expect(result.claims[0]).toMatchObject({
      status: "insufficient",
      rationaleCode: "no_valid_evidence",
      rejectedCitations: [{ reason: "evidence_missing" }],
    });
    expect(result.coverage.contradictedClaims).toBe(0);
  });

  test("rejects a Capsule whose content no longer matches its identity", async () => {
    const { capsule, receipt } = await setup();
    const tampered = structuredClone(capsule);
    tampered.evidence[0]!.text = "rewritten evidence";
    expect(() =>
      verifyClaimsDeterministically({
        answer: "Claim.",
        capsule: tampered,
        freshness: receipt,
      })
    ).toThrow();
  });

  test("accepts only one strict, citation-bound semantic judgment", async () => {
    const { capsule, receipt } = await setup();
    const first = capsule.evidence[0]!;
    const second = capsule.evidence[1]!;
    const answer = `Mina owns it ${marker(first.evidenceId)}.`;
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });
    const valid = judgment(preliminary.claims[0]!.claimId, [first.evidenceId]);
    expect(semanticClaimJudgmentSchema.safeParse(valid).success).toBe(true);

    for (const invalid of [
      { ...valid, unexpected: true },
      { ...valid, rationaleCode: "semantic_contradiction" },
      { ...valid, evidenceIds: [second.evidenceId] },
      valid,
    ]) {
      const inputs =
        invalid === valid ? [valid, structuredClone(valid)] : [invalid];
      const result = verifyClaimsDeterministically({
        answer,
        capsule,
        freshness: receipt,
        semanticJudgments: inputs,
      });
      expect(result.claims[0]!.status).toBe("uncertain");
    }
  });

  test("surfaces orphan and incomplete citation artifacts and forces abstention", async () => {
    const { capsule, receipt } = await setup();
    const evidence = capsule.evidence[0]!;
    const outside = sha256Text("outside");
    const answer = `Mina owns it ${marker(evidence.evidenceId)}.\n${marker(outside)}`;
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });
    const result = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
      semanticJudgments: [
        judgment(preliminary.claims[0]!.claimId, [evidence.evidenceId]),
      ],
    });
    expect(result.claims[0]!.status).toBe("supported");
    expect(result).toMatchObject({
      answerStatus: "abstained",
      abstentionReason: "citation_hygiene_failed",
      rejectedCitations: [{ evidenceId: outside, reason: "out_of_capsule" }],
    });

    const malformed = verifyClaimsDeterministically({
      answer: "Claim [evidence:not-closed.",
      capsule,
      freshness: receipt,
    });
    expect(malformed.claims[0]!.rejectedCitations).toEqual([
      expect.objectContaining({
        marker: "[evidence:not-closed.",
        evidenceId: null,
        reason: "malformed_citation",
      }),
    ]);
  });

  test("ranking and fingerprint drift do not invalidate unchanged content", async () => {
    const { capsule, store } = await setup();
    const evidence = capsule.evidence[0]!;
    const driftedReceipt = await verifyContextCapsule(capsule, {
      ...verifierDeps(store, capsule),
      currentFingerprints: {
        ...FINGERPRINTS,
        config: sha256Text("new-config"),
      },
      resolveCurrentRanks: async () =>
        new Map(capsule.evidence.map((item) => [item.evidenceId, 9])),
    });
    expect(driftedReceipt).toMatchObject({
      contentStatus: "unchanged",
      rankingStatus: "reranked",
      fingerprintStatus: "drifted",
    });
    const answer = `Mina owns it ${marker(evidence.evidenceId)}.`;
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: driftedReceipt,
    });
    const result = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: driftedReceipt,
      semanticJudgments: [
        judgment(preliminary.claims[0]!.claimId, [evidence.evidenceId]),
      ],
    });
    expect(result.claims[0]!.status).toBe("supported");
  });

  test("contradiction forces abstention and incomplete support stays below 1.0", async () => {
    const { capsule, receipt } = await setup();
    const first = capsule.evidence[0]!;
    const second = capsule.evidence[1]!;
    const answer = `Mina owns it ${marker(first.evidenceId)}. Omar reviews it ${marker(second.evidenceId)}.`;
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });
    const contradicted = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
      semanticJudgments: [
        judgment(preliminary.claims[0]!.claimId, [first.evidenceId]),
        judgment(
          preliminary.claims[1]!.claimId,
          [second.evidenceId],
          "contradicted"
        ),
      ],
    });
    expect(contradicted).toMatchObject({
      answerStatus: "abstained",
      abstained: true,
      abstentionReason: "contradiction_detected",
      abstentionText: CLAIM_ABSTENTION_TEXT,
      coverage: { supportedRatio: 0.5, contradictedClaims: 1 },
    });

    const partial = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
      semanticJudgments: [
        judgment(preliminary.claims[0]!.claimId, [first.evidenceId]),
      ],
    });
    expect(partial).toMatchObject({
      abstentionReason: "coverage_below_threshold",
      coverage: { supportedRatio: 0.5, uncertainClaims: 1 },
    });
  });

  test("strict JSON schema closes every nested output object", async () => {
    const { capsule, receipt } = await setup();
    const evidence = capsule.evidence[0]!;
    const answer = `Claim ${marker(evidence.evidenceId)} plus ${marker(sha256Text("outside"))}.`;
    const result = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });
    const schema = await loadSchema("claim-verification");
    expect(assertValid(result, schema)).toBe(true);

    const paths: Array<Array<string | number>> = [
      [],
      ["claims", 0],
      ["claims", 0, "evidence", 0],
      ["claims", 0, "rejectedCitations", 0],
      ["coverage"],
    ];
    for (const path of paths) {
      const mutated = structuredClone(result) as unknown as Record<
        string,
        unknown
      >;
      let target: unknown = mutated;
      for (const segment of path) {
        target = (target as Record<string | number, unknown>)[segment];
      }
      (target as Record<string, unknown>).unexpected = true;
      expect(assertInvalid(mutated, schema)).toBe(true);
    }
  });

  test("fails closed before bounded result arrays exceed the contract", async () => {
    const { capsule, receipt } = await setup();
    const tooManyClaims = Array.from({ length: 257 }, () => "Claim.").join(" ");
    expect(() =>
      verifyClaimsDeterministically({
        answer: tooManyClaims,
        capsule,
        freshness: receipt,
      })
    ).toThrow("Claim limit exceeded");

    const bad = marker(sha256Text("outside"));
    const tooManyCitations = `Claim ${Array.from({ length: 257 }, () => bad).join(" ")}.`;
    expect(() =>
      verifyClaimsDeterministically({
        answer: tooManyCitations,
        capsule,
        freshness: receipt,
      })
    ).toThrow("Citation limit exceeded");

    const valid = marker(capsule.evidence[0]!.evidenceId);
    const duplicateValidCitations = `Claim ${Array.from({ length: 257 }, () => valid).join(" ")}.`;
    expect(() =>
      verifyClaimsDeterministically({
        answer: duplicateValidCitations,
        capsule,
        freshness: receipt,
      })
    ).toThrow("Citation limit exceeded");
  });
});
