/**
 * Deterministic evidence selection under one canonical payload budget.
 *
 * Candidate text is already materialized into its final extractive form. The
 * caller-owned projector is the budget authority: it must build the complete
 * canonical Capsule payload, including coverage, omissions, and guidance.
 */

import type { FusionSource } from "../pipeline/types";

export const CONTEXT_OMISSION_REASONS = [
  "duplicate",
  "overlap",
  "global_budget",
  "redundant_coverage",
  "document_share_cap",
  "filtered_by_scope",
  "invalid_coordinates",
] as const;

export type ContextOmissionReason = (typeof CONTEXT_OMISSION_REASONS)[number];

export type ContextGapReason =
  | "facet_not_found"
  | "global_budget_exhausted"
  | "filtered_by_scope";

export interface ContextCandidateReference {
  candidateId: string;
  uri: string;
  docid: string;
  startLine: number | null;
  endLine: number | null;
  passageHash: string | null;
  sourceHash: string;
  mirrorHash: string;
}

export interface MaterializedContextCandidate<
  T = unknown,
> extends ContextCandidateReference {
  startLine: number;
  endLine: number;
  passageHash: string;
  text: string;
  facets: string[];
  retrievalRank: number;
  /** Absent only for legacy results that predate planner provenance metadata. */
  retrievalSources?: FusionSource[];
  /** Absent only for legacy results that predate planner provenance metadata. */
  graphExpanded?: boolean;
  value: T;
}

export interface ContextOmission extends ContextCandidateReference {
  reason: ContextOmissionReason;
}

export interface ContextReasonCounts {
  duplicate: number;
  overlap: number;
  global_budget: number;
  redundant_coverage: number;
  document_share_cap: number;
  filtered_by_scope: number;
  invalid_coordinates: number;
}

export interface ContextCoverageState {
  coveredFacets: string[];
  unresolvedFacets: string[];
  gaps: Array<{ facet: string; code: ContextGapReason }>;
}

export interface ContextSelectionState<T = unknown> {
  selected: MaterializedContextCandidate<T>[];
  omissions: ContextOmission[];
  reasonCounts: ContextReasonCounts;
  coverage: ContextCoverageState;
}

export interface ContextCanonicalProjection<T = unknown> {
  value: T;
  usedBytes: number;
  usedTokens: number;
}

export interface ContextBudgetLimits {
  requestedBytes: number;
  requestedTokens: number;
  safetyMarginBytes: number;
  safetyMarginTokens: number;
  /** Defaults to 3/5 of the spendable byte budget. */
  documentShareNumerator?: number;
  documentShareDenominator?: number;
}

export interface ContextSelectionOptions<T, P> {
  candidates: MaterializedContextCandidate<T>[];
  requestedFacets: string[];
  initialOmissions?: ContextOmission[];
  filteredFacetMatches?: ReadonlySet<string>;
  limits: ContextBudgetLimits;
  projectCanonical: (
    state: ContextSelectionState<T>
  ) => ContextCanonicalProjection<P> | null;
}

export interface ContextSelectionResult<T, P> extends ContextSelectionState<T> {
  projection: ContextCanonicalProjection<P> | null;
}

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compareReferences = (
  left: ContextCandidateReference,
  right: ContextCandidateReference
): number =>
  compareCodeUnits(left.uri, right.uri) ||
  (left.startLine ?? 0) - (right.startLine ?? 0) ||
  (left.endLine ?? 0) - (right.endLine ?? 0) ||
  compareCodeUnits(left.sourceHash, right.sourceHash) ||
  compareCodeUnits(left.candidateId, right.candidateId);

const compareOmissions = (
  left: ContextOmission,
  right: ContextOmission
): number =>
  compareCodeUnits(left.reason, right.reason) || compareReferences(left, right);

const emptyReasonCounts = (): ContextReasonCounts => ({
  duplicate: 0,
  overlap: 0,
  global_budget: 0,
  redundant_coverage: 0,
  document_share_cap: 0,
  filtered_by_scope: 0,
  invalid_coordinates: 0,
});

const dedupeOmissions = (omissions: ContextOmission[]): ContextOmission[] => {
  const byId = new Map<string, ContextOmission>();
  for (const omission of [...omissions].sort(compareOmissions)) {
    if (!byId.has(omission.candidateId)) {
      byId.set(omission.candidateId, omission);
    }
  }
  return [...byId.values()].sort(compareOmissions);
};

const countReasons = (omissions: ContextOmission[]): ContextReasonCounts => {
  const counts = emptyReasonCounts();
  for (const omission of omissions) counts[omission.reason] += 1;
  return counts;
};

const coveredFacetSet = <T>(
  selected: MaterializedContextCandidate<T>[]
): Set<string> => new Set(selected.flatMap((candidate) => candidate.facets));

const buildCoverage = <T>(
  requestedFacets: string[],
  selected: MaterializedContextCandidate<T>[],
  candidates: MaterializedContextCandidate<T>[],
  filteredFacetMatches: ReadonlySet<string>
): ContextCoverageState => {
  const covered = coveredFacetSet(selected);
  const available = new Set(
    candidates.flatMap((candidate) => candidate.facets)
  );
  const coveredFacets = requestedFacets.filter((facet) => covered.has(facet));
  const unresolvedFacets = requestedFacets.filter(
    (facet) => !covered.has(facet)
  );
  const gaps = unresolvedFacets.map((facet) => ({
    facet,
    code: available.has(facet)
      ? ("global_budget_exhausted" as const)
      : filteredFacetMatches.has(facet)
        ? ("filtered_by_scope" as const)
        : ("facet_not_found" as const),
  }));
  return { coveredFacets, unresolvedFacets, gaps };
};

const buildState = <T>(
  requestedFacets: string[],
  selected: MaterializedContextCandidate<T>[],
  omissions: ContextOmission[],
  candidates: MaterializedContextCandidate<T>[],
  filteredFacetMatches: ReadonlySet<string>
): ContextSelectionState<T> => {
  const orderedOmissions = dedupeOmissions(omissions);
  return {
    selected: selected.map((candidate) => ({ ...candidate })),
    omissions: orderedOmissions,
    reasonCounts: countReasons(orderedOmissions),
    coverage: buildCoverage(
      requestedFacets,
      selected,
      candidates,
      filteredFacetMatches
    ),
  };
};

const overlaps = <T>(
  candidate: MaterializedContextCandidate<T>,
  selected: MaterializedContextCandidate<T>[]
): boolean =>
  selected.some(
    (item) =>
      item.docid === candidate.docid &&
      candidate.startLine <= item.endLine &&
      item.startLine <= candidate.endLine
  );

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const validateLimits = (limits: ContextBudgetLimits): void => {
  const values = [
    limits.requestedBytes,
    limits.requestedTokens,
    limits.safetyMarginBytes,
    limits.safetyMarginTokens,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    limits.requestedBytes <= limits.safetyMarginBytes ||
    limits.requestedTokens <= limits.safetyMarginTokens
  ) {
    throw new Error("Context budget limits must be positive safe integers");
  }
};

const projectionFits = <P>(
  projection: ContextCanonicalProjection<P> | null,
  limits: ContextBudgetLimits
): projection is ContextCanonicalProjection<P> =>
  projection !== null &&
  Number.isSafeInteger(projection.usedBytes) &&
  Number.isSafeInteger(projection.usedTokens) &&
  projection.usedBytes >= 0 &&
  projection.usedTokens >= 0 &&
  projection.usedBytes + limits.safetyMarginBytes <= limits.requestedBytes &&
  projection.usedTokens + limits.safetyMarginTokens <= limits.requestedTokens;

const documentShareExceeded = <T>(
  candidate: MaterializedContextCandidate<T>,
  selected: MaterializedContextCandidate<T>[],
  candidateDocumentCount: number,
  limits: ContextBudgetLimits
): boolean => {
  if (candidateDocumentCount <= 1) return false;
  const numerator = limits.documentShareNumerator ?? 3;
  const denominator = limits.documentShareDenominator ?? 5;
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 1 ||
    denominator < numerator
  ) {
    throw new Error("Invalid Context document share ratio");
  }
  const spendableBytes = limits.requestedBytes - limits.safetyMarginBytes;
  const shareLimit = Number(
    (BigInt(spendableBytes) * BigInt(numerator)) / BigInt(denominator)
  );
  const sameDocumentBytes = selected
    .filter((item) => item.docid === candidate.docid)
    .reduce((sum, item) => sum + utf8Bytes(item.text), 0);
  return sameDocumentBytes + utf8Bytes(candidate.text) > shareLimit;
};

const omissionReason = <T>(
  candidate: MaterializedContextCandidate<T>,
  selected: MaterializedContextCandidate<T>[],
  covered: ReadonlySet<string>,
  requestedFacetCount: number,
  candidateDocumentCount: number,
  limits: ContextBudgetLimits
): ContextOmissionReason | null => {
  if (requestedFacetCount > 0 && candidate.facets.length === 0) {
    return "redundant_coverage";
  }
  if (overlaps(candidate, selected)) return "overlap";
  if (
    documentShareExceeded(candidate, selected, candidateDocumentCount, limits)
  ) {
    return "document_share_cap";
  }
  if (
    selected.length > 0 &&
    candidate.facets.every((facet) => covered.has(facet))
  ) {
    return "redundant_coverage";
  }
  return null;
};

const asOmission = <T>(
  candidate: MaterializedContextCandidate<T>,
  reason: ContextOmissionReason
): ContextOmission => ({
  candidateId: candidate.candidateId,
  uri: candidate.uri,
  docid: candidate.docid,
  startLine: candidate.startLine,
  endLine: candidate.endLine,
  passageHash: candidate.passageHash,
  sourceHash: candidate.sourceHash,
  mirrorHash: candidate.mirrorHash,
  reason,
});

const collapseDuplicates = <T>(
  candidates: MaterializedContextCandidate<T>[]
): {
  candidates: MaterializedContextCandidate<T>[];
  omissions: ContextOmission[];
} => {
  const ordered = [...candidates].sort(
    (left, right) =>
      left.retrievalRank - right.retrievalRank || compareReferences(left, right)
  );
  const seenIds = new Set<string>();
  const seenPassages = new Set<string>();
  const kept: MaterializedContextCandidate<T>[] = [];
  const omissions: ContextOmission[] = [];
  for (const candidate of ordered) {
    if (seenIds.has(candidate.candidateId)) continue;
    seenIds.add(candidate.candidateId);
    if (seenPassages.has(candidate.passageHash)) {
      omissions.push(asOmission(candidate, "duplicate"));
      continue;
    }
    seenPassages.add(candidate.passageHash);
    kept.push(candidate);
  }
  return { candidates: kept, omissions };
};

const compareMarginalValue = <T>(
  left: MaterializedContextCandidate<T>,
  right: MaterializedContextCandidate<T>,
  covered: ReadonlySet<string>,
  poolSize: number
): number => {
  const uncovered = (candidate: MaterializedContextCandidate<T>): number =>
    candidate.facets.filter((facet) => !covered.has(facet)).length;
  const leftUncovered = uncovered(left);
  const rightUncovered = uncovered(right);
  const leftCost = BigInt(Math.max(1, utf8Bytes(left.text)));
  const rightCost = BigInt(Math.max(1, utf8Bytes(right.text)));
  const leftRatio = BigInt(leftUncovered) * rightCost;
  const rightRatio = BigInt(rightUncovered) * leftCost;
  if (leftRatio !== rightRatio) return leftRatio > rightRatio ? -1 : 1;
  const relevance = (candidate: MaterializedContextCandidate<T>): number =>
    Math.max(1, poolSize - candidate.retrievalRank + 1);
  const relevanceDifference = relevance(right) - relevance(left);
  if (relevanceDifference !== 0) return relevanceDifference;
  if (left.retrievalRank !== right.retrievalRank) {
    return left.retrievalRank - right.retrievalRank;
  }
  return compareReferences(left, right);
};

/** Select materialized candidates using exact full-payload fit checks. */
export const selectContextEvidence = <T, P>(
  options: ContextSelectionOptions<T, P>
): ContextSelectionResult<T, P> => {
  validateLimits(options.limits);
  const requestedFacets = [...new Set(options.requestedFacets)].sort(
    compareCodeUnits
  );
  const filteredFacetMatches =
    options.filteredFacetMatches ?? new Set<string>();
  const collapsed = collapseDuplicates(options.candidates);
  const candidates = collapsed.candidates;
  const candidateDocumentCount = new Set(
    candidates.map((candidate) => candidate.docid)
  ).size;
  const selected: MaterializedContextCandidate<T>[] = [];
  const omissions = [
    ...(options.initialOmissions ?? []),
    ...collapsed.omissions,
  ];
  const remaining = [...candidates];
  let projection: ContextCanonicalProjection<P> | null = null;

  while (remaining.length > 0) {
    const covered = coveredFacetSet(selected);
    const eligible: MaterializedContextCandidate<T>[] = [];
    for (const candidate of remaining) {
      const reason = omissionReason(
        candidate,
        selected,
        covered,
        requestedFacets.length,
        candidateDocumentCount,
        options.limits
      );
      if (reason) omissions.push(asOmission(candidate, reason));
      else eligible.push(candidate);
    }
    remaining.length = 0;
    remaining.push(...eligible);
    if (remaining.length === 0) break;

    remaining.sort((left, right) =>
      compareMarginalValue(left, right, covered, candidates.length)
    );
    const candidate = remaining.shift();
    if (!candidate) break;
    const proposedSelected = [...selected, candidate];
    const proposedCovered = coveredFacetSet(proposedSelected);
    const provisionalOmissions = [
      ...omissions,
      ...remaining.map((item) =>
        asOmission(
          item,
          omissionReason(
            item,
            proposedSelected,
            proposedCovered,
            requestedFacets.length,
            candidateDocumentCount,
            options.limits
          ) ?? "global_budget"
        )
      ),
    ];
    const state = buildState(
      requestedFacets,
      proposedSelected,
      provisionalOmissions,
      candidates,
      filteredFacetMatches
    );
    const proposedProjection = options.projectCanonical(state);
    if (projectionFits(proposedProjection, options.limits)) {
      selected.push(candidate);
      projection = proposedProjection;
    } else {
      omissions.push(asOmission(candidate, "global_budget"));
    }
  }

  const finalState = buildState(
    requestedFacets,
    selected,
    omissions,
    candidates,
    filteredFacetMatches
  );
  const finalProjection =
    selected.length > 0 ? options.projectCanonical(finalState) : null;
  if (selected.length > 0 && !projectionFits(finalProjection, options.limits)) {
    throw new Error("Final canonical Context projection exceeds its budget");
  }
  return { ...finalState, projection: finalProjection ?? projection };
};
