import { z } from "zod";

export const CLAIM_VERIFICATION_SCHEMA_VERSION = "1.0" as const;
export const CLAIM_COORDINATE_SPACE = "utf16_code_units" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const semanticClaimJudgmentSchema = z
  .object({
    claimId: sha256Schema,
    verdict: z.enum(["supported", "contradicted"]),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(sha256Schema).min(1).max(256),
    rationaleCode: z.enum(["semantic_entailment", "semantic_contradiction"]),
    verifierFingerprint: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.verdict === "supported"
        ? "semantic_entailment"
        : "semantic_contradiction";
    if (
      value.rationaleCode !== expected ||
      new Set(value.evidenceIds).size !== value.evidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic judgment is incoherent",
      });
    }
  });

export type SemanticClaimJudgment = z.infer<typeof semanticClaimJudgmentSchema>;
const evidenceReferenceSchema = z
  .object({
    evidenceId: sha256Schema,
    uri: z.string().min(1).max(2048).startsWith("gno://"),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: z.string().min(1),
    sourceHash: sha256Schema,
    mirrorHash: sha256Schema,
    passageHash: sha256Schema,
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: "evidence line range is reversed",
    path: ["endLine"],
  });

const rejectedCitationSchema = z
  .object({
    marker: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    evidenceId: sha256Schema.nullable(),
    reason: z.enum([
      "malformed_citation",
      "out_of_capsule",
      "freshness_unavailable",
      "freshness_receipt_invalid",
      "freshness_receipt_mismatch",
      "evidence_stale",
      "evidence_missing",
      "orphan_citation",
    ]),
  })
  .strict()
  .refine((value) => value.end > value.start, {
    message: "citation span must be non-empty",
    path: ["end"],
  });

const verifiedClaimSchema = z
  .object({
    claimId: sha256Schema,
    text: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    status: z.enum(["supported", "contradicted", "insufficient", "uncertain"]),
    confidence: z.number().min(0).max(1).nullable(),
    rationaleCode: z.enum([
      "semantic_entailment",
      "semantic_contradiction",
      "no_valid_evidence",
      "semantic_judgment_unavailable",
    ]),
    verifierFingerprint: sha256Schema.nullable(),
    evidence: z.array(evidenceReferenceSchema).max(256),
    rejectedCitations: z.array(rejectedCitationSchema).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.end <= value.start) {
      context.addIssue({
        code: "custom",
        message: "claim span must be non-empty",
        path: ["end"],
      });
    }
    const semantic =
      value.status === "supported" || value.status === "contradicted";
    const expectedRationale = {
      supported: "semantic_entailment",
      contradicted: "semantic_contradiction",
      insufficient: "no_valid_evidence",
      uncertain: "semantic_judgment_unavailable",
    }[value.status];
    const evidenceCountValid =
      value.status === "insufficient"
        ? value.evidence.length === 0
        : value.evidence.length > 0;
    if (
      value.rationaleCode !== expectedRationale ||
      !evidenceCountValid ||
      (semantic &&
        (value.confidence === null || value.verifierFingerprint === null)) ||
      (!semantic &&
        (value.confidence !== null || value.verifierFingerprint !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "claim status fields are incoherent",
      });
    }
    const ids = value.evidence.map((item) => item.evidenceId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "claim evidence must be unique",
        path: ["evidence"],
      });
    }
  });

const coverageSchema = z
  .object({
    totalClaims: z.number().int().nonnegative(),
    supportedClaims: z.number().int().nonnegative(),
    contradictedClaims: z.number().int().nonnegative(),
    insufficientClaims: z.number().int().nonnegative(),
    uncertainClaims: z.number().int().nonnegative(),
    supportedRatio: z.number().min(0).max(1),
  })
  .strict();

export const claimVerificationResultSchema = z
  .object({
    schemaVersion: z.literal(CLAIM_VERIFICATION_SCHEMA_VERSION),
    coordinateSpace: z.literal(CLAIM_COORDINATE_SPACE),
    capsuleId: sha256Schema,
    answerHash: sha256Schema,
    coverageThreshold: z.literal(1),
    claims: z.array(verifiedClaimSchema).max(256),
    rejectedCitations: z.array(rejectedCitationSchema).max(256),
    coverage: coverageSchema,
    answerStatus: z.enum(["verified", "abstained"]),
    abstained: z.boolean(),
    abstentionReason: z
      .enum([
        "contradiction_detected",
        "coverage_below_threshold",
        "no_substantive_claims",
        "citation_hygiene_failed",
      ])
      .nullable(),
    abstentionText: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const counts = {
      supportedClaims: value.claims.filter(
        (claim) => claim.status === "supported"
      ).length,
      contradictedClaims: value.claims.filter(
        (claim) => claim.status === "contradicted"
      ).length,
      insufficientClaims: value.claims.filter(
        (claim) => claim.status === "insufficient"
      ).length,
      uncertainClaims: value.claims.filter(
        (claim) => claim.status === "uncertain"
      ).length,
    };
    const supportedRatio =
      value.claims.length === 0
        ? 0
        : counts.supportedClaims / value.claims.length;
    const expectedReason =
      value.claims.length === 0
        ? "no_substantive_claims"
        : counts.contradictedClaims > 0
          ? "contradiction_detected"
          : value.rejectedCitations.length > 0 ||
              value.claims.some((claim) => claim.rejectedCitations.length > 0)
            ? "citation_hygiene_failed"
            : supportedRatio < 1
              ? "coverage_below_threshold"
              : null;
    const coverageValid =
      value.coverage.totalClaims === value.claims.length &&
      Object.entries(counts).every(
        ([key, count]) => value.coverage[key as keyof typeof counts] === count
      ) &&
      value.coverage.supportedRatio === supportedRatio;
    const abstentionValid =
      value.abstentionReason === expectedReason &&
      value.abstained === (expectedReason !== null) &&
      value.answerStatus ===
        (expectedReason === null ? "verified" : "abstained") &&
      (expectedReason === null
        ? value.abstentionText === null
        : value.abstentionText !== null);
    const spansValid = value.claims.every(
      (claim, index) =>
        index === 0 || claim.start >= (value.claims[index - 1]?.end ?? 0)
    );
    const claimIds = value.claims.map((claim) => claim.claimId);
    if (
      !coverageValid ||
      !abstentionValid ||
      !spansValid ||
      new Set(claimIds).size !== claimIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "claim verification aggregate is incoherent",
      });
    }
  });

export type ClaimVerificationResult = z.infer<
  typeof claimVerificationResultSchema
>;
