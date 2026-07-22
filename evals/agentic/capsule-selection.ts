import type { NormalizedToolEvidence } from "./types";

export type CapsuleOmissionReason =
  | "duplicate"
  | "overlap"
  | "global_budget"
  | "redundant_coverage";

export interface CapsuleCandidate extends NormalizedToolEvidence {
  retrievalRank: number;
  facets: string[];
}

export interface CapsuleOmission {
  uri: string;
  sourceHash: string;
  startLine: number;
  endLine: number;
  spanHash: string;
  reason: CapsuleOmissionReason;
}

export interface CapsuleSelection {
  evidence: CapsuleCandidate[];
  omitted: CapsuleOmission[];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const coordinateCompare = (
  left: Pick<
    CapsuleCandidate,
    "uri" | "sourceHash" | "startLine" | "endLine" | "spanHash"
  >,
  right: Pick<
    CapsuleCandidate,
    "uri" | "sourceHash" | "startLine" | "endLine" | "spanHash"
  >
): number =>
  compareText(left.uri, right.uri) ||
  compareText(left.sourceHash, right.sourceHash) ||
  left.startLine - right.startLine ||
  left.endLine - right.endLine ||
  compareText(left.spanHash, right.spanHash);

const priorityCompare = (
  left: CapsuleCandidate,
  right: CapsuleCandidate
): number =>
  right.facets.length - left.facets.length ||
  left.retrievalRank - right.retrievalRank ||
  left.endLine - left.startLine - (right.endLine - right.startLine) ||
  coordinateCompare(left, right);

const overlaps = (left: CapsuleCandidate, right: CapsuleCandidate): boolean =>
  left.uri === right.uri &&
  left.startLine <= right.endLine &&
  right.startLine <= left.endLine;

const omit = (
  candidate: CapsuleCandidate,
  reason: CapsuleOmissionReason
): CapsuleOmission => ({
  uri: candidate.uri,
  sourceHash: candidate.sourceHash,
  startLine: candidate.startLine,
  endLine: candidate.endLine,
  spanHash: candidate.spanHash,
  reason,
});

const omissionCompare = (
  left: CapsuleOmission,
  right: CapsuleOmission
): number =>
  compareText(left.uri, right.uri) ||
  compareText(left.sourceHash, right.sourceHash) ||
  left.startLine - right.startLine ||
  left.endLine - right.endLine ||
  compareText(left.spanHash, right.spanHash) ||
  compareText(left.reason, right.reason);

export const collapseCapsuleCandidates = (
  candidates: readonly CapsuleCandidate[]
): CapsuleSelection => {
  const kept: CapsuleCandidate[] = [];
  const omitted: CapsuleOmission[] = [];
  for (const candidate of [...candidates].sort(priorityCompare)) {
    const exact = kept.some(
      (item) =>
        item.uri === candidate.uri &&
        item.sourceHash === candidate.sourceHash &&
        item.startLine === candidate.startLine &&
        item.endLine === candidate.endLine &&
        item.spanHash === candidate.spanHash
    );
    if (exact) {
      omitted.push(omit(candidate, "duplicate"));
      continue;
    }
    if (kept.some((item) => overlaps(item, candidate))) {
      omitted.push(omit(candidate, "overlap"));
      continue;
    }
    kept.push(candidate);
  }
  return {
    evidence: kept.sort(coordinateCompare),
    omitted: omitted.sort(omissionCompare),
  };
};

/**
 * Greedy marginal facet coverage. `fits` measures the complete model-visible
 * result, so one budget governs payload metadata and evidence together.
 */
export const selectCapsuleEvidence = (
  candidates: readonly CapsuleCandidate[],
  fits: (selected: readonly CapsuleCandidate[]) => boolean
): CapsuleSelection => {
  const collapsed = collapseCapsuleCandidates(candidates);
  const remaining = [...collapsed.evidence];
  const selected: CapsuleCandidate[] = [];
  const covered = new Set<string>();
  const omitted = [...collapsed.omitted];

  while (remaining.length > 0) {
    const coveredByUri = new Map<string, Set<string>>();
    for (const item of selected) {
      const uriFacets = coveredByUri.get(item.uri) ?? new Set<string>();
      for (const facet of item.facets) uriFacets.add(facet);
      coveredByUri.set(item.uri, uriFacets);
    }
    const eligible: CapsuleCandidate[] = [];
    for (const candidate of remaining) {
      const uriFacets = coveredByUri.get(candidate.uri) ?? new Set<string>();
      if (
        candidate.facets.length === 0 ||
        candidate.facets.every((facet) => uriFacets.has(facet))
      ) {
        omitted.push(omit(candidate, "redundant_coverage"));
      } else {
        eligible.push(candidate);
      }
    }
    remaining.length = 0;
    remaining.push(...eligible);
    if (remaining.length === 0) break;
    remaining.sort((left, right) => {
      const leftMarginal = left.facets.filter(
        (facet) => !covered.has(facet)
      ).length;
      const rightMarginal = right.facets.filter(
        (facet) => !covered.has(facet)
      ).length;
      return rightMarginal - leftMarginal || priorityCompare(left, right);
    });
    const candidate = remaining.shift() as CapsuleCandidate;
    if (!fits([...selected, candidate])) {
      omitted.push(omit(candidate, "global_budget"));
      continue;
    }
    selected.push(candidate);
    for (const facet of candidate.facets) covered.add(facet);
  }

  return {
    evidence: selected.sort(coordinateCompare),
    omitted: omitted.sort(omissionCompare),
  };
};

export const omitRedundantCapsuleCandidates = (
  candidates: readonly CapsuleCandidate[],
  selected: readonly CapsuleCandidate[]
): CapsuleOmission[] => {
  const selectedKeys = new Set(
    selected.map(
      (item) =>
        `${item.uri}\0${item.startLine}\0${item.endLine}\0${item.spanHash}`
    )
  );
  return candidates
    .filter(
      (item) =>
        !selectedKeys.has(
          `${item.uri}\0${item.startLine}\0${item.endLine}\0${item.spanHash}`
        )
    )
    .map((item) => omit(item, "redundant_coverage"))
    .sort(omissionCompare);
};
