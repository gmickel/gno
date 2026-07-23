import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextCapsuleVerification } from "../core/context-capsule-verification";

import {
  contextCapsuleV1Schema,
  parseContextCapsuleV1,
} from "../core/context-capsule";
import { sha256Text } from "../core/context-capsule-validation";
import { contextCapsuleVerificationSchema } from "../core/context-capsule-verification";
import {
  CLAIM_COORDINATE_SPACE,
  CLAIM_VERIFICATION_SCHEMA_VERSION,
  claimVerificationResultSchema,
  type ClaimVerificationResult,
  type SemanticClaimJudgment,
  semanticClaimJudgmentSchema,
} from "./claim-verification-schema";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CITATION_PATTERN = /\[evidence(?::([^\]\r\n]*))?(\]?)/g;
const SUBSTANTIVE_PATTERN = /[\p{L}\p{N}]/u;
const CLAIM_BOUNDARY_PATTERN = /[.!?;\n]/;
const TRAILING_CLOSER_PATTERN = /["')\]}’”]/;
const COVERAGE_THRESHOLD = 1;
const MAX_CLAIMS = 256;
const MAX_CITATIONS = 256;

export {
  CLAIM_COORDINATE_SPACE,
  CLAIM_VERIFICATION_SCHEMA_VERSION,
  claimVerificationResultSchema,
  semanticClaimJudgmentSchema,
};
export const CLAIM_ABSTENTION_TEXT =
  "I cannot provide this answer as verified from the supplied Context Capsule.";

export type { SemanticClaimJudgment };

export interface ClaimSpan {
  claimId: string;
  text: string;
  start: number;
  end: number;
}

export type ClaimVerificationStatus =
  | "supported"
  | "contradicted"
  | "insufficient"
  | "uncertain";

export type RejectedCitationReason =
  | "malformed_citation"
  | "out_of_capsule"
  | "freshness_unavailable"
  | "freshness_receipt_invalid"
  | "freshness_receipt_mismatch"
  | "evidence_stale"
  | "evidence_missing"
  | "orphan_citation";

export interface RejectedCitation {
  marker: string;
  start: number;
  end: number;
  evidenceId: string | null;
  reason: RejectedCitationReason;
}

export interface ClaimEvidenceReference {
  evidenceId: string;
  uri: string;
  startLine: number;
  endLine: number;
  text: string;
  sourceHash: string;
  mirrorHash: string;
  passageHash: string;
}

export interface VerifiedClaim extends ClaimSpan {
  status: ClaimVerificationStatus;
  confidence: number | null;
  rationaleCode:
    | "semantic_entailment"
    | "semantic_contradiction"
    | "no_valid_evidence"
    | "semantic_judgment_unavailable";
  verifierFingerprint: string | null;
  evidence: ClaimEvidenceReference[];
  rejectedCitations: RejectedCitation[];
}

export type { ClaimVerificationResult };

export interface VerifyClaimsInput {
  answer: string;
  capsule: unknown;
  freshness?: unknown;
  semanticJudgments?: readonly unknown[];
}

const trimSpan = (
  answer: string,
  startInput: number,
  endInput: number
): { start: number; end: number } => {
  let start = startInput;
  let end = endInput;
  while (start < end && /\s/.test(answer[start] ?? "")) start += 1;
  while (end > start && /\s/.test(answer[end - 1] ?? "")) end -= 1;
  return { start, end };
};

const citationFreeText = (value: string): string =>
  value.replace(CITATION_PATTERN, "").replace(/^\s*(?:[#>*+-]|\d+[.)])\s+/, "");

const isAbbreviationPeriod = (answer: string, index: number): boolean => {
  const previous = answer[index - 1] ?? "";
  const next = answer[index + 1] ?? "";
  if (/\d/.test(previous) && /\d/.test(next)) return true;
  const prefix = answer.slice(Math.max(0, index - 8), index + 1).toLowerCase();
  return /(?:\b(?:dr|mr|mrs|ms|prof|sr|jr|vs|etc)|e\.g|i\.e|u\.s)\.$/.test(
    prefix
  );
};

const fencedCodeEnd = (answer: string, start: number): number => {
  const closing = answer.indexOf("```", start + 3);
  return closing === -1 ? answer.length : closing + 3;
};

const assertCitationLimit = (answer: string): void => {
  CITATION_PATTERN.lastIndex = 0;
  let count = 0;
  for (const _match of answer.matchAll(CITATION_PATTERN)) {
    count += 1;
    if (count > MAX_CITATIONS) {
      throw new Error(`Citation limit exceeded (${MAX_CITATIONS})`);
    }
  }
};

const claimIdentity = (
  capsuleId: string,
  start: number,
  end: number,
  text: string
): string => sha256Text(JSON.stringify({ capsuleId, end, start, text }));

/** Split substantive claims without rewriting. Offsets are half-open UTF-16. */
export const segmentSubstantiveClaims = (
  answer: string,
  capsuleId: string
): ClaimSpan[] => {
  const claims: ClaimSpan[] = [];
  const appendClaim = (start: number, end: number, text: string): void => {
    claims.push({
      claimId: claimIdentity(capsuleId, start, end, text),
      text,
      start,
      end,
    });
    if (claims.length > MAX_CLAIMS) {
      throw new Error(`Claim limit exceeded (${MAX_CLAIMS})`);
    }
  };
  let segmentStart = 0;
  for (let index = 0; index < answer.length; index += 1) {
    if (answer.startsWith("```", index)) {
      const before = trimSpan(answer, segmentStart, index);
      const beforeText = answer.slice(before.start, before.end);
      if (SUBSTANTIVE_PATTERN.test(citationFreeText(beforeText))) {
        appendClaim(before.start, before.end, beforeText);
      }
      const codeEnd = fencedCodeEnd(answer, index);
      segmentStart = codeEnd;
      index = codeEnd - 1;
      continue;
    }
    const character = answer[index] ?? "";
    if (!CLAIM_BOUNDARY_PATTERN.test(character)) continue;
    if (character === "." && isAbbreviationPeriod(answer, index)) continue;
    let boundary = index + 1;
    while (
      character !== "\n" &&
      boundary < answer.length &&
      TRAILING_CLOSER_PATTERN.test(answer[boundary] ?? "")
    ) {
      boundary += 1;
    }
    const next = answer[boundary];
    if (character !== "\n" && next !== undefined && !/\s/.test(next)) continue;
    const span = trimSpan(answer, segmentStart, boundary);
    const text = answer.slice(span.start, span.end);
    if (SUBSTANTIVE_PATTERN.test(citationFreeText(text))) {
      appendClaim(span.start, span.end, text);
    }
    segmentStart = boundary;
  }
  const span = trimSpan(answer, segmentStart, answer.length);
  const text = answer.slice(span.start, span.end);
  if (SUBSTANTIVE_PATTERN.test(citationFreeText(text))) {
    appendClaim(span.start, span.end, text);
  }
  return claims;
};

type Evidence = ContextCapsuleV1["evidence"][number];
type EvidenceReceipt = ContextCapsuleVerification["evidence"][number];

interface FreshnessState {
  status: "verified" | "unavailable" | "invalid" | "mismatch";
  receipts: Map<string, EvidenceReceipt>;
}

const freshnessState = (
  capsule: ContextCapsuleV1,
  input: unknown
): FreshnessState => {
  if (input === undefined)
    return { status: "unavailable", receipts: new Map() };
  const parsed = contextCapsuleVerificationSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", receipts: new Map() };
  const expected = new Map(
    capsule.evidence.map((evidence) => [evidence.evidenceId, evidence])
  );
  const complete =
    parsed.data.capsuleId === capsule.capsuleId &&
    parsed.data.evidence.length === expected.size &&
    parsed.data.evidence.every(
      (receipt) =>
        expected.get(receipt.evidenceId)?.uri === receipt.uri &&
        (receipt.contentStatus !== "unchanged" ||
          (receipt.currentSourceHash ===
            expected.get(receipt.evidenceId)?.sourceHash &&
            receipt.currentMirrorHash ===
              expected.get(receipt.evidenceId)?.mirrorHash &&
            receipt.currentPassageHash ===
              expected.get(receipt.evidenceId)?.passageHash))
    );
  if (!complete) return { status: "mismatch", receipts: new Map() };
  return {
    status: "verified",
    receipts: new Map(
      parsed.data.evidence.map((receipt) => [receipt.evidenceId, receipt])
    ),
  };
};

const rejectedReason = (
  evidence: Evidence | undefined,
  freshness: FreshnessState
): RejectedCitationReason | null => {
  if (!evidence) return "out_of_capsule";
  if (freshness.status === "unavailable") return "freshness_unavailable";
  if (freshness.status === "invalid") return "freshness_receipt_invalid";
  if (freshness.status === "mismatch") return "freshness_receipt_mismatch";
  const receipt = freshness.receipts.get(evidence.evidenceId);
  if (!receipt || receipt.contentStatus === "missing")
    return "evidence_missing";
  if (receipt.contentStatus === "stale") return "evidence_stale";
  return null;
};

const evidenceReference = (evidence: Evidence): ClaimEvidenceReference => ({
  evidenceId: evidence.evidenceId,
  uri: evidence.uri,
  startLine: evidence.startLine,
  endLine: evidence.endLine,
  text: evidence.text,
  sourceHash: evidence.sourceHash,
  mirrorHash: evidence.mirrorHash,
  passageHash: evidence.passageHash,
});

const citationsForClaim = (
  answer: string,
  claim: ClaimSpan,
  evidenceById: ReadonlyMap<string, Evidence>,
  freshness: FreshnessState
): { accepted: Evidence[]; rejected: RejectedCitation[] } => {
  const accepted = new Map<string, Evidence>();
  const rejected: RejectedCitation[] = [];
  CITATION_PATTERN.lastIndex = claim.start;
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= claim.end) break;
    if (start < claim.start) continue;
    const rawId = match[1] ?? "";
    const closed = match[2] === "]";
    const evidenceId = closed && SHA256_PATTERN.test(rawId) ? rawId : null;
    const evidence =
      evidenceId === null ? undefined : evidenceById.get(evidenceId);
    const reason =
      evidenceId === null
        ? "malformed_citation"
        : rejectedReason(evidence, freshness);
    if (reason) {
      rejected.push({
        marker: match[0],
        start,
        end,
        evidenceId,
        reason,
      });
    } else if (evidence) {
      accepted.set(evidence.evidenceId, evidence);
    }
    if (accepted.size + rejected.length > MAX_CITATIONS) {
      throw new Error(`Citation limit exceeded (${MAX_CITATIONS})`);
    }
  }
  return { accepted: [...accepted.values()], rejected };
};

const judgmentForClaim = (
  claim: ClaimSpan,
  acceptedIds: ReadonlySet<string>,
  inputs: readonly unknown[]
): SemanticClaimJudgment | null => {
  const matches: SemanticClaimJudgment[] = [];
  for (const input of inputs) {
    const parsed = semanticClaimJudgmentSchema.safeParse(input);
    if (
      parsed.success &&
      parsed.data.claimId === claim.claimId &&
      parsed.data.evidenceIds.every((id) => acceptedIds.has(id))
    ) {
      matches.push(parsed.data);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const verifyClaim = (
  answer: string,
  claim: ClaimSpan,
  evidenceById: ReadonlyMap<string, Evidence>,
  freshness: FreshnessState,
  judgments: readonly unknown[]
): VerifiedClaim => {
  const citations = citationsForClaim(answer, claim, evidenceById, freshness);
  const references = citations.accepted.map(evidenceReference);
  const acceptedIds = new Set(references.map((item) => item.evidenceId));
  const judgment = judgmentForClaim(claim, acceptedIds, judgments);
  if (references.length === 0) {
    return {
      ...claim,
      status: "insufficient",
      confidence: null,
      rationaleCode: "no_valid_evidence",
      verifierFingerprint: null,
      evidence: [],
      rejectedCitations: citations.rejected,
    };
  }
  if (!judgment) {
    return {
      ...claim,
      status: "uncertain",
      confidence: null,
      rationaleCode: "semantic_judgment_unavailable",
      verifierFingerprint: null,
      evidence: references,
      rejectedCitations: citations.rejected,
    };
  }
  const selected = new Set(judgment.evidenceIds);
  return {
    ...claim,
    status: judgment.verdict,
    confidence: judgment.confidence,
    rationaleCode: judgment.rationaleCode,
    verifierFingerprint: judgment.verifierFingerprint,
    evidence: references.filter((item) => selected.has(item.evidenceId)),
    rejectedCitations: citations.rejected,
  };
};

const orphanCitations = (
  answer: string,
  claims: readonly ClaimSpan[],
  evidenceById: ReadonlyMap<string, Evidence>,
  freshness: FreshnessState
): RejectedCitation[] => {
  const rejected: RejectedCitation[] = [];
  CITATION_PATTERN.lastIndex = 0;
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (claims.some((claim) => start >= claim.start && start < claim.end)) {
      continue;
    }
    const rawId = match[1] ?? "";
    const evidenceId =
      match[2] === "]" && SHA256_PATTERN.test(rawId) ? rawId : null;
    const evidence =
      evidenceId === null ? undefined : evidenceById.get(evidenceId);
    rejected.push({
      marker: match[0],
      start,
      end,
      evidenceId,
      reason:
        evidenceId === null
          ? "malformed_citation"
          : (rejectedReason(evidence, freshness) ?? "orphan_citation"),
    });
    if (rejected.length > MAX_CITATIONS) {
      throw new Error(`Citation limit exceeded (${MAX_CITATIONS})`);
    }
  }
  return rejected;
};

export const verifyClaimsDeterministically = (
  input: VerifyClaimsInput
): ClaimVerificationResult => {
  if ((input.semanticJudgments?.length ?? 0) > MAX_CLAIMS) {
    throw new Error(`Semantic judgment limit exceeded (${MAX_CLAIMS})`);
  }
  const capsule = parseContextCapsuleV1(input.capsule);
  // A second strict parse makes the identity and nested contract requirement
  // explicit at this pipeline boundary.
  contextCapsuleV1Schema.parse(capsule);
  assertCitationLimit(input.answer);
  const claims = segmentSubstantiveClaims(input.answer, capsule.capsuleId);
  const freshness = freshnessState(capsule, input.freshness);
  const evidenceById = new Map(
    capsule.evidence.map((evidence) => [evidence.evidenceId, evidence])
  );
  const verifiedClaims = claims.map((claim) =>
    verifyClaim(
      input.answer,
      claim,
      evidenceById,
      freshness,
      input.semanticJudgments ?? []
    )
  );
  const rejectedCitations = orphanCitations(
    input.answer,
    claims,
    evidenceById,
    freshness
  );
  const count = (status: ClaimVerificationStatus): number =>
    verifiedClaims.filter((claim) => claim.status === status).length;
  const supportedClaims = count("supported");
  const coverage = {
    totalClaims: verifiedClaims.length,
    supportedClaims,
    contradictedClaims: count("contradicted"),
    insufficientClaims: count("insufficient"),
    uncertainClaims: count("uncertain"),
    supportedRatio:
      verifiedClaims.length === 0 ? 0 : supportedClaims / verifiedClaims.length,
  };
  const abstentionReason =
    coverage.totalClaims === 0
      ? "no_substantive_claims"
      : coverage.contradictedClaims > 0
        ? "contradiction_detected"
        : rejectedCitations.length > 0 ||
            verifiedClaims.some((claim) => claim.rejectedCitations.length > 0)
          ? "citation_hygiene_failed"
          : coverage.supportedRatio < COVERAGE_THRESHOLD
            ? "coverage_below_threshold"
            : null;
  const abstained = abstentionReason !== null;
  return claimVerificationResultSchema.parse({
    schemaVersion: CLAIM_VERIFICATION_SCHEMA_VERSION,
    coordinateSpace: CLAIM_COORDINATE_SPACE,
    capsuleId: capsule.capsuleId,
    answerHash: sha256Text(input.answer),
    coverageThreshold: COVERAGE_THRESHOLD,
    claims: verifiedClaims,
    rejectedCitations,
    coverage,
    answerStatus: abstained ? "abstained" : "verified",
    abstained,
    abstentionReason,
    abstentionText: abstained ? CLAIM_ABSTENTION_TEXT : null,
  });
};
