/**
 * Bounded auxiliary scoring for trusted project affinity.
 *
 * @module src/pipeline/project-affinity
 */

import type {
  ProjectAffinityMatch,
  ProjectAffinityResolution,
} from "../core/project-affinity";
import type { SearchResult } from "./types";

import {
  AUXILIARY_RANKING_MAX_CONTRIBUTION,
  PROJECT_AFFINITY_MAX_CONTRIBUTION,
} from "../config/types";

export interface ProjectAffinityScoringInput {
  enabled?: boolean;
  contribution?: number;
  resolution: ProjectAffinityResolution;
}

export interface ProjectAffinityScoreMetadata {
  affinityAdjustedScore: number;
  affinityApplied: number;
  affinityRequested: number;
  affinityWeight: number;
  baseScore: number;
  collectionAlias: string | null;
  combinedAuxiliaryApplied: number;
  combinedAuxiliaryCap: number;
  combinedAuxiliaryRequested: number;
  finalBlendedScore: number;
  finalScore: number;
  matched: boolean;
  rawScore: number;
  rawScoreKind: "bm25" | "hybrid_blended" | "normalized" | "vector_distance";
  rootAlias: string | null;
  source: ProjectAffinityMatch["source"] | null;
}

export const SEARCH_RESULT_AFFINITY_METADATA = Symbol(
  "gno.searchResultAffinityMetadata"
);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function applyAuxiliaryScore(
  baseScore: number,
  contributions: readonly number[]
): {
  applied: number;
  finalScore: number;
  requested: number;
} {
  const requested = [...contributions]
    .sort((left, right) => left - right)
    .reduce((total, contribution) => total + contribution, 0);
  const applied = clamp(
    requested,
    -AUXILIARY_RANKING_MAX_CONTRIBUTION,
    AUXILIARY_RANKING_MAX_CONTRIBUTION
  );
  return {
    requested,
    applied,
    finalScore: clamp(baseScore + applied, 0, 1),
  };
}

const matchingCollection = (
  input: ProjectAffinityScoringInput | undefined,
  collection: string
): ProjectAffinityMatch | undefined => {
  if (input?.enabled === false) return undefined;
  return input?.resolution.matches.find(
    (match) => match.collection === collection
  );
};

export function scoreProjectAffinity(
  baseScore: number,
  collection: string,
  input: ProjectAffinityScoringInput | undefined,
  raw: {
    kind: ProjectAffinityScoreMetadata["rawScoreKind"];
    score: number;
  } = { kind: "normalized", score: baseScore }
): ProjectAffinityScoreMetadata {
  const match = matchingCollection(input, collection);
  const configuredWeight = clamp(
    input?.contribution ?? PROJECT_AFFINITY_MAX_CONTRIBUTION,
    0,
    PROJECT_AFFINITY_MAX_CONTRIBUTION
  );
  const affinityRequested = match ? configuredWeight : 0;
  const auxiliary = applyAuxiliaryScore(baseScore, [affinityRequested]);
  const affinityApplied = auxiliary.finalScore - baseScore;

  return {
    affinityAdjustedScore: auxiliary.finalScore,
    affinityApplied,
    affinityRequested,
    affinityWeight: configuredWeight,
    baseScore,
    collectionAlias: match?.collectionAlias ?? null,
    combinedAuxiliaryApplied: auxiliary.applied,
    combinedAuxiliaryCap: AUXILIARY_RANKING_MAX_CONTRIBUTION,
    combinedAuxiliaryRequested: auxiliary.requested,
    finalBlendedScore: auxiliary.finalScore,
    finalScore: auxiliary.finalScore,
    matched: Boolean(match),
    rawScore: raw.score,
    rawScoreKind: raw.kind,
    rootAlias: match?.rootAlias ?? null,
    source: match?.source ?? null,
  };
}

export function hasProjectAffinity(
  input: ProjectAffinityScoringInput | undefined
): boolean {
  return (
    Boolean(input) &&
    input?.enabled !== false &&
    (input?.contribution ?? PROJECT_AFFINITY_MAX_CONTRIBUTION) > 0 &&
    (input?.resolution.matches.length ?? 0) !== 0
  );
}

export function applyProjectAffinity(
  result: SearchResult,
  collection: string,
  input: ProjectAffinityScoringInput | undefined,
  raw?: {
    kind: ProjectAffinityScoreMetadata["rawScoreKind"];
    score: number;
  }
): SearchResult {
  if (!hasProjectAffinity(input)) return result;
  const metadata = scoreProjectAffinity(result.score, collection, input, raw);
  result.score = metadata.finalScore;
  Object.defineProperty(result, SEARCH_RESULT_AFFINITY_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata,
    writable: true,
  });
  return result;
}

export function getProjectAffinityMetadata(
  result: SearchResult
): ProjectAffinityScoreMetadata | undefined {
  return (
    result as SearchResult & {
      [SEARCH_RESULT_AFFINITY_METADATA]?: ProjectAffinityScoreMetadata;
    }
  )[SEARCH_RESULT_AFFINITY_METADATA];
}
