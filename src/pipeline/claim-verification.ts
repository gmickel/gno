import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextCapsuleVerification } from "../core/context-capsule-verification";

import { parseContextCapsuleV1 } from "../core/context-capsule";
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
    | "semantic_judgment_unavailable"
    | "quote_not_in_evidence";
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

const parseSemanticJudgmentsIndex = (
  inputs: readonly unknown[]
): Map<string, SemanticClaimJudgment[]> => {
  const byClaimId = new Map<string, SemanticClaimJudgment[]>();
  for (const input of inputs) {
    const parsed = semanticClaimJudgmentSchema.safeParse(input);
    if (!parsed.success) continue;
    const list = byClaimId.get(parsed.data.claimId);
    if (list) list.push(parsed.data);
    else byClaimId.set(parsed.data.claimId, [parsed.data]);
  }
  return byClaimId;
};

const judgmentForClaim = (
  claim: ClaimSpan,
  acceptedIds: ReadonlySet<string>,
  judgmentsByClaimId: ReadonlyMap<string, readonly SemanticClaimJudgment[]>
): SemanticClaimJudgment | null => {
  const candidates = judgmentsByClaimId.get(claim.claimId);
  if (!candidates || candidates.length === 0) return null;
  let matched: SemanticClaimJudgment | null = null;
  for (const judgment of candidates) {
    if (judgment.evidenceIds.every((id) => acceptedIds.has(id))) {
      if (matched !== null) return null;
      matched = judgment;
    }
  }
  return matched;
};

/**
 * Quotations by delimiter pair. A single quote opens only after the start, a
 * space or a bracket and closes only before the end, a space, punctuation or
 * a bracket, so apostrophes (it's, users') never delimit a quotation.
 */
const QUOTATION_PATTERNS = [
  /"([^"]+)"/g,
  /\u201C([^\u201C\u201D]+)\u201D/g,
  /(?<=^|[\s([{])'(.+?)'(?=$|[\s.,;:!?)\]}])/g,
  /(?<=^|[\s([{])\u2018(.+?)\u2019(?=$|[\s.,;:!?)\]}])/g,
] as const;

const QUOTE_DELIMITER_PATTERN = /["'\u2018\u2019\u201C\u201D]/;

/** Whitespace, quote style and case differences are not misquotes. */
const normalizeQuoted = (text: string): string =>
  text
    .normalize("NFKC")
    .replaceAll(/[\u2018\u2019]/g, "'")
    .replaceAll(/[\u201C\u201D]/g, '"')
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();

const quotesFoundInEvidence = (
  claimText: string,
  evidence: readonly Evidence[],
  normalizedCache: Map<string, string>
): boolean => {
  if (!QUOTE_DELIMITER_PATTERN.test(claimText)) return true;
  let quotedSpans: string[] | null = null;
  for (const pattern of QUOTATION_PATTERNS) {
    for (const match of claimText.matchAll(pattern)) {
      // Closing punctuation inside a quote often ends the claim's sentence.
      const quoted = normalizeQuoted(match[1] ?? "").replace(/[.,;:!?]+$/, "");
      if (quoted === "") continue;
      quotedSpans ??= [];
      quotedSpans.push(quoted);
    }
  }
  if (!quotedSpans) return true;
  const haystacks = evidence.map((item) => {
    let normalized = normalizedCache.get(item.evidenceId);
    if (normalized === undefined) {
      normalized = normalizeQuoted(item.text);
      normalizedCache.set(item.evidenceId, normalized);
    }
    return normalized;
  });
  for (const quoted of quotedSpans) {
    if (!haystacks.some((text) => text.includes(quoted))) return false;
  }
  return true;
};

interface PreparedClaim {
  claim: ClaimSpan;
  references: ClaimEvidenceReference[];
  acceptedIds: Set<string>;
  rejectedCitations: RejectedCitation[];
  quotesValid: boolean;
}

export interface PreparedClaimVerification {
  capsuleId: string;
  answerHash: string;
  claims: PreparedClaim[];
  rejectedCitations: RejectedCitation[];
}

/**
 * Run deterministic capsule parsing, claim segmentation, single-pass two-pointer
 * citation attribution, and quote checking once so semantic verifiers can apply
 * judgments without repeating deterministic work.
 */
export const prepareClaimVerification = (
  input: Omit<VerifyClaimsInput, "semanticJudgments">
): PreparedClaimVerification => {
  const capsule = parseContextCapsuleV1(input.capsule);
  // Single pass over CITATION_PATTERN enforces MAX_CITATIONS before claim
  // segmentation (preserving exact error priority), then attributes claim and
  // orphan citations via a two-pointer sweep over sorted non-overlapping claims.
  CITATION_PATTERN.lastIndex = 0;
  const rawCitations: Array<{
    marker: string;
    start: number;
    end: number;
    evidenceId: string | null;
  }> = [];
  for (const match of input.answer.matchAll(CITATION_PATTERN)) {
    if (rawCitations.length >= MAX_CITATIONS) {
      throw new Error(`Citation limit exceeded (${MAX_CITATIONS})`);
    }
    const start = match.index;
    const rawId = match[1] ?? "";
    rawCitations.push({
      marker: match[0],
      start,
      end: start + match[0].length,
      evidenceId: match[2] === "]" && SHA256_PATTERN.test(rawId) ? rawId : null,
    });
  }
  const claims = segmentSubstantiveClaims(input.answer, capsule.capsuleId);
  const freshness = freshnessState(capsule, input.freshness);
  const evidenceById = new Map(
    capsule.evidence.map((evidence) => [evidence.evidenceId, evidence])
  );
  const perClaimAccepted: Map<string, Evidence>[] = claims.map(() => new Map());
  const perClaimRejected: RejectedCitation[][] = claims.map(() => []);
  const orphanRejected: RejectedCitation[] = [];
  const boundaryAffectedClaims = new Set<number>();

  let claimIdx = 0;
  for (const citation of rawCitations) {
    const { marker, start, end, evidenceId } = citation;
    while (claimIdx < claims.length && claims[claimIdx]!.end <= start) {
      claimIdx += 1;
    }
    const evidence =
      evidenceId === null ? undefined : evidenceById.get(evidenceId);
    const inClaim =
      claimIdx < claims.length &&
      start >= claims[claimIdx]!.start &&
      start < claims[claimIdx]!.end;
    if (inClaim) {
      if (end > claims[claimIdx]!.end) {
        // A malformed marker spanning past this claim's boundary could swallow
        // markers in this or subsequent claims; re-scan affected claim slices locally.
        for (
          let k = claimIdx;
          k < claims.length && claims[k]!.start < end;
          k++
        ) {
          boundaryAffectedClaims.add(k);
        }
      } else {
        const reason =
          evidenceId === null
            ? "malformed_citation"
            : rejectedReason(evidence, freshness);
        if (reason) {
          perClaimRejected[claimIdx]!.push({
            marker,
            start,
            end,
            evidenceId,
            reason,
          });
        } else if (evidence) {
          perClaimAccepted[claimIdx]!.set(evidence.evidenceId, evidence);
        }
      }
    } else {
      orphanRejected.push({
        marker,
        start,
        end,
        evidenceId,
        reason:
          evidenceId === null
            ? "malformed_citation"
            : (rejectedReason(evidence, freshness) ?? "orphan_citation"),
      });
      // If an orphan malformed span extends into subsequent claims, re-scan
      // those claim slices locally so valid citations inside them are preserved.
      if (claimIdx < claims.length && end > claims[claimIdx]!.start) {
        for (
          let k = claimIdx;
          k < claims.length && claims[k]!.start < end;
          k++
        ) {
          boundaryAffectedClaims.add(k);
        }
      }
    }
  }

  for (const idx of boundaryAffectedClaims) {
    const claim = claims[idx]!;
    perClaimAccepted[idx]!.clear();
    perClaimRejected[idx]!.length = 0;
    CITATION_PATTERN.lastIndex = 0;
    for (const match of claim.text.matchAll(CITATION_PATTERN)) {
      const start = claim.start + match.index;
      const end = start + match[0].length;
      const rawId = match[1] ?? "";
      const evidenceId =
        match[2] === "]" && SHA256_PATTERN.test(rawId) ? rawId : null;
      const evidence =
        evidenceId === null ? undefined : evidenceById.get(evidenceId);
      const reason =
        evidenceId === null
          ? "malformed_citation"
          : rejectedReason(evidence, freshness);
      if (reason) {
        perClaimRejected[idx]!.push({
          marker: match[0],
          start,
          end,
          evidenceId,
          reason,
        });
      } else if (evidence) {
        perClaimAccepted[idx]!.set(evidence.evidenceId, evidence);
      }
    }
  }

  const normalizedEvidenceCache = new Map<string, string>();
  const preparedClaims: PreparedClaim[] = claims.map((claim, index) => {
    const accepted = [...perClaimAccepted[index]!.values()];
    const references = accepted.map(evidenceReference);
    const acceptedIds = new Set(references.map((item) => item.evidenceId));
    const quotesValid =
      references.length === 0
        ? true
        : quotesFoundInEvidence(claim.text, accepted, normalizedEvidenceCache);
    return {
      claim,
      references,
      acceptedIds,
      rejectedCitations: perClaimRejected[index]!,
      quotesValid,
    };
  });

  return {
    capsuleId: capsule.capsuleId,
    answerHash: sha256Text(input.answer),
    claims: preparedClaims,
    rejectedCitations: orphanRejected,
  };
};

export const applySemanticJudgments = (
  prepared: PreparedClaimVerification,
  semanticJudgments: readonly unknown[] = []
): ClaimVerificationResult => {
  if (semanticJudgments.length > MAX_CLAIMS) {
    throw new Error(`Semantic judgment limit exceeded (${MAX_CLAIMS})`);
  }
  const judgmentsByClaimId = parseSemanticJudgmentsIndex(semanticJudgments);
  const verifiedClaims: VerifiedClaim[] = prepared.claims.map((entry) => {
    const { claim, references, acceptedIds, rejectedCitations, quotesValid } =
      entry;
    if (references.length === 0) {
      return {
        ...claim,
        status: "insufficient",
        confidence: null,
        rationaleCode: "no_valid_evidence",
        verifierFingerprint: null,
        evidence: [],
        rejectedCitations,
      };
    }
    // An explicit quotation must appear in the cited evidence; the semantic
    // judgment cannot vouch for wording it never compared.
    if (!quotesValid) {
      return {
        ...claim,
        status: "uncertain",
        confidence: null,
        rationaleCode: "quote_not_in_evidence",
        verifierFingerprint: null,
        evidence: references,
        rejectedCitations,
      };
    }
    const judgment = judgmentForClaim(claim, acceptedIds, judgmentsByClaimId);
    if (!judgment) {
      return {
        ...claim,
        status: "uncertain",
        confidence: null,
        rationaleCode: "semantic_judgment_unavailable",
        verifierFingerprint: null,
        evidence: references,
        rejectedCitations,
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
      rejectedCitations,
    };
  });

  let supportedClaims = 0;
  let contradictedClaims = 0;
  let insufficientClaims = 0;
  let uncertainClaims = 0;
  let anyClaimRejected = false;
  for (const claim of verifiedClaims) {
    if (claim.status === "supported") supportedClaims += 1;
    else if (claim.status === "contradicted") contradictedClaims += 1;
    else if (claim.status === "insufficient") insufficientClaims += 1;
    else uncertainClaims += 1;
    if (claim.rejectedCitations.length > 0) anyClaimRejected = true;
  }
  const coverage = {
    totalClaims: verifiedClaims.length,
    supportedClaims,
    contradictedClaims,
    insufficientClaims,
    uncertainClaims,
    supportedRatio:
      verifiedClaims.length === 0 ? 0 : supportedClaims / verifiedClaims.length,
  };
  const abstentionReason =
    coverage.totalClaims === 0
      ? "no_substantive_claims"
      : coverage.contradictedClaims > 0
        ? "contradiction_detected"
        : prepared.rejectedCitations.length > 0 || anyClaimRejected
          ? "citation_hygiene_failed"
          : coverage.supportedRatio < COVERAGE_THRESHOLD
            ? "coverage_below_threshold"
            : null;
  const abstained = abstentionReason !== null;
  return claimVerificationResultSchema.parse({
    schemaVersion: CLAIM_VERIFICATION_SCHEMA_VERSION,
    coordinateSpace: CLAIM_COORDINATE_SPACE,
    capsuleId: prepared.capsuleId,
    answerHash: prepared.answerHash,
    coverageThreshold: COVERAGE_THRESHOLD,
    claims: verifiedClaims,
    rejectedCitations: prepared.rejectedCitations,
    coverage,
    answerStatus: abstained ? "abstained" : "verified",
    abstained,
    abstentionReason,
    abstentionText: abstained ? CLAIM_ABSTENTION_TEXT : null,
  });
};

export const verifyClaimsDeterministically = (
  input: VerifyClaimsInput
): ClaimVerificationResult => {
  if ((input.semanticJudgments?.length ?? 0) > MAX_CLAIMS) {
    throw new Error(`Semantic judgment limit exceeded (${MAX_CLAIMS})`);
  }
  const prepared = prepareClaimVerification(input);
  return applySemanticJudgments(prepared, input.semanticJudgments ?? []);
};
