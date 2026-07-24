/**
 * Bounded content-type scoring composed with trusted project affinity.
 *
 * @module src/pipeline/content-type-boost
 */

import type { NormalizedContentTypeRule } from "../config/content-types";
import type { ProjectAffinityScoringInput } from "./project-affinity";
import type { SearchResult } from "./types";

import {
  fingerprintContentTypeRules,
  resolveContentTypeRule,
} from "../config/content-types";
import {
  CONTENT_TYPE_SEARCH_BOOST_MAX,
  CONTENT_TYPE_SEARCH_BOOST_MIN,
  CONTENT_TYPE_SEARCH_BOOST_NEUTRAL,
} from "../config/types";
import {
  applyAuxiliaryScore,
  hasProjectAffinity,
  SEARCH_RESULT_AFFINITY_METADATA,
  scoreProjectAffinity,
  type ProjectAffinityScoreMetadata,
} from "./project-affinity";

export const CONTENT_TYPE_MAX_CONTRIBUTION = 0.05;

export interface ContentTypeBoostScoreMetadata {
  baseScore: number;
  cappedContribution: number;
  combinedAuxiliaryApplied: number;
  combinedAuxiliaryCap: number;
  combinedAuxiliaryRequested: number;
  configuredFactor: number;
  contentType: string;
  finalScore: number;
  rawContribution: number;
  rawScore: number;
  rawScoreKind: ProjectAffinityScoreMetadata["rawScoreKind"];
  ruleSource: "configured-id" | "prefix";
  rulesFingerprint: string;
}

export const SEARCH_RESULT_CONTENT_TYPE_BOOST_METADATA = Symbol(
  "gno.searchResultContentTypeBoostMetadata"
);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const rankingFingerprints = new WeakMap<
  readonly NormalizedContentTypeRule[],
  string
>();

const rankingFingerprint = (
  rules: readonly NormalizedContentTypeRule[] | undefined
): string => {
  if (!rules) return fingerprintContentTypeRules([]);
  const cached = rankingFingerprints.get(rules);
  if (cached) return cached;
  const fingerprint = fingerprintContentTypeRules([...rules]);
  rankingFingerprints.set(rules, fingerprint);
  return fingerprint;
};

/** Map the supported factor range continuously onto the contribution range. */
export function contentTypeBoostContribution(factor: number): {
  raw: number;
  capped: number;
} {
  const raw =
    factor >= CONTENT_TYPE_SEARCH_BOOST_NEUTRAL
      ? ((factor - CONTENT_TYPE_SEARCH_BOOST_NEUTRAL) /
          (CONTENT_TYPE_SEARCH_BOOST_MAX - CONTENT_TYPE_SEARCH_BOOST_NEUTRAL)) *
        CONTENT_TYPE_MAX_CONTRIBUTION
      : ((factor - CONTENT_TYPE_SEARCH_BOOST_NEUTRAL) /
          (CONTENT_TYPE_SEARCH_BOOST_NEUTRAL - CONTENT_TYPE_SEARCH_BOOST_MIN)) *
        CONTENT_TYPE_MAX_CONTRIBUTION;
  return {
    raw,
    capped: clamp(
      raw,
      -CONTENT_TYPE_MAX_CONTRIBUTION,
      CONTENT_TYPE_MAX_CONTRIBUTION
    ),
  };
}

export function hasContentTypeBoost(
  rules: readonly NormalizedContentTypeRule[] | undefined
): boolean {
  return Boolean(
    rules?.some(
      (rule) => rule.searchBoost !== CONTENT_TYPE_SEARCH_BOOST_NEUTRAL
    )
  );
}

export function hasAuxiliaryRanking(
  projectAffinity: ProjectAffinityScoringInput | undefined,
  rules: readonly NormalizedContentTypeRule[] | undefined
): boolean {
  return hasProjectAffinity(projectAffinity) || hasContentTypeBoost(rules);
}

export function scoreContentTypeBoost(
  baseScore: number,
  contentType: string | undefined,
  relativePath: string,
  collection: string,
  rules: readonly NormalizedContentTypeRule[] | undefined,
  projectAffinity: ProjectAffinityScoringInput | undefined,
  raw: {
    kind: ProjectAffinityScoreMetadata["rawScoreKind"];
    score: number;
  } = { kind: "normalized", score: baseScore }
): {
  contentTypeBoost?: ContentTypeBoostScoreMetadata;
  projectAffinity: ProjectAffinityScoreMetadata;
} {
  const resolution = resolveContentTypeRule(
    contentType,
    relativePath,
    rules ? [...rules] : []
  );
  const factor =
    resolution?.rule.searchBoost ?? CONTENT_TYPE_SEARCH_BOOST_NEUTRAL;
  const contribution = contentTypeBoostContribution(factor);
  const projectScore = scoreProjectAffinity(
    baseScore,
    collection,
    projectAffinity,
    raw
  );
  const combined = applyAuxiliaryScore(baseScore, [
    projectScore.affinityRequested,
    contribution.capped,
  ]);
  const compositeProjectScore: ProjectAffinityScoreMetadata = {
    ...projectScore,
    combinedAuxiliaryApplied: combined.applied,
    combinedAuxiliaryRequested: combined.requested,
    finalBlendedScore: combined.finalScore,
    finalScore: combined.finalScore,
  };

  if (!resolution || factor === CONTENT_TYPE_SEARCH_BOOST_NEUTRAL) {
    return { projectAffinity: compositeProjectScore };
  }

  return {
    projectAffinity: compositeProjectScore,
    contentTypeBoost: {
      baseScore,
      cappedContribution: contribution.capped,
      combinedAuxiliaryApplied: compositeProjectScore.combinedAuxiliaryApplied,
      combinedAuxiliaryCap: compositeProjectScore.combinedAuxiliaryCap,
      combinedAuxiliaryRequested:
        compositeProjectScore.combinedAuxiliaryRequested,
      configuredFactor: factor,
      contentType: resolution.rule.id,
      finalScore: compositeProjectScore.finalScore,
      rawContribution: contribution.raw,
      rawScore: raw.score,
      rawScoreKind: raw.kind,
      ruleSource: resolution.source,
      rulesFingerprint: rankingFingerprint(rules),
    },
  };
}

export function applyContentTypeBoost(
  result: SearchResult,
  collection: string,
  rules: readonly NormalizedContentTypeRule[] | undefined,
  projectAffinity: ProjectAffinityScoringInput | undefined,
  raw?: {
    kind: ProjectAffinityScoreMetadata["rawScoreKind"];
    score: number;
  }
): SearchResult {
  const scored = scoreContentTypeBoost(
    result.score,
    result.contentType,
    result.source.relPath,
    collection,
    rules,
    projectAffinity,
    raw
  );
  const affinityActive = hasProjectAffinity(projectAffinity);
  if (!(scored.contentTypeBoost || affinityActive)) return result;

  result.score = scored.projectAffinity.finalScore;
  if (affinityActive) {
    Object.defineProperty(result, SEARCH_RESULT_AFFINITY_METADATA, {
      configurable: true,
      enumerable: false,
      value: scored.projectAffinity,
      writable: true,
    });
  }
  if (scored.contentTypeBoost) {
    Object.defineProperty(result, SEARCH_RESULT_CONTENT_TYPE_BOOST_METADATA, {
      configurable: true,
      enumerable: false,
      value: scored.contentTypeBoost,
      writable: true,
    });
  }
  return result;
}

export function getContentTypeBoostMetadata(
  result: SearchResult
): ContentTypeBoostScoreMetadata | undefined {
  return (
    result as SearchResult & {
      [SEARCH_RESULT_CONTENT_TYPE_BOOST_METADATA]?: ContentTypeBoostScoreMetadata;
    }
  )[SEARCH_RESULT_CONTENT_TYPE_BOOST_METADATA];
}

export function sortByFinalScoreStable(results: SearchResult[]): void {
  const originalRank = new Map(
    results.map((result, index) => [result, index] as const)
  );
  results.sort(
    (left, right) =>
      right.score - left.score ||
      (originalRank.get(left) ?? 0) - (originalRank.get(right) ?? 0)
  );
}
