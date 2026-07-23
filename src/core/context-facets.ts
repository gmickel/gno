/** Deterministic, generation-free Context Capsule facet derivation. */

import type { QueryModeInput, SearchResult } from "../pipeline/types";

import { isWithinTemporalRange } from "../pipeline/temporal";

const COMPARISON_PATTERN = /\b(?:vs\.?|versus|compared?\s+(?:to|with))\b/iu;
const COMPARISON_LEAD_PATTERN = /^\s*(?:compare|comparison\s+of)\s+/iu;
const QUOTED_PATTERN = /["“]([^"”]{2,512})["”]/gu;
const ENTITY_PATTERN = /\p{Lu}[\p{L}\p{N}._-]*(?:\s+\p{Lu}[\p{L}\p{N}._-]*)*/gu;
const TEMPORAL_SIGNALS = [
  "today",
  "yesterday",
  "this week",
  "last week",
  "this month",
  "last month",
  "latest",
  "newest",
  "most recent",
  "recent",
] as const;
const TEMPORAL_PATTERN =
  /\b(?:today|yesterday|this week|last week|this month|last month|latest|newest|most recent|recent)\b/giu;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "compare",
  "find",
  "for",
  "from",
  "how",
  "in",
  "is",
  "last",
  "latest",
  "month",
  "most",
  "newest",
  "of",
  "on",
  "or",
  "the",
  "this",
  "today",
  "to",
  "vs",
  "what",
  "week",
  "when",
  "where",
  "which",
  "who",
  "with",
  "yesterday",
]);

export interface ContextDerivedFacet {
  value: string;
  matchText: string;
  temporal: boolean;
}

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const normalizeContextText = (value: string): string =>
  value.replace(/\r\n?/g, "\n").normalize("NFC").trim().replace(/\s+/g, " ");

const normalizedFacet = (value: string): string =>
  normalizeContextText(value).toLocaleLowerCase("und").slice(0, 512);

const addFacet = (
  facets: Map<string, ContextDerivedFacet>,
  value: string,
  temporal = false
): void => {
  const normalized = normalizedFacet(value);
  if (!normalized || facets.has(normalized) || facets.size >= 128) return;
  facets.set(normalized, {
    value: normalized,
    matchText: normalized,
    temporal,
  });
};

const comparisonOperands = (goal: string): string[] => {
  const explicit = goal.split(COMPARISON_PATTERN);
  if (explicit.length > 1) {
    return explicit.map((operand) =>
      operand
        .replace(COMPARISON_LEAD_PATTERN, "")
        .replace(TEMPORAL_PATTERN, "")
        .trim()
    );
  }
  if (!COMPARISON_LEAD_PATTERN.test(goal)) return [];
  return goal
    .replace(COMPARISON_LEAD_PATTERN, "")
    .split(/\s+and\s+/iu)
    .map((operand) => operand.replace(TEMPORAL_PATTERN, "").trim());
};

export const deriveContextFacetPlan = (
  goal: string,
  queryModes: readonly QueryModeInput[] = []
): ContextDerivedFacet[] => {
  const facets = new Map<string, ContextDerivedFacet>();
  for (const match of goal.matchAll(QUOTED_PATTERN))
    addFacet(facets, match[1] ?? "");
  for (const mode of queryModes) addFacet(facets, mode.text);
  for (const operand of comparisonOperands(goal)) addFacet(facets, operand);
  for (const entity of goal.match(ENTITY_PATTERN) ?? []) {
    const withoutLead = entity.replace(COMPARISON_LEAD_PATTERN, "");
    if (!STOP_WORDS.has(normalizedFacet(withoutLead)))
      addFacet(facets, withoutLead);
  }
  const lowerGoal = normalizedFacet(goal);
  for (const signal of TEMPORAL_SIGNALS) {
    if (lowerGoal.includes(signal)) addFacet(facets, signal, true);
  }
  const words = lowerGoal.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  for (const word of words) {
    if (word.length > 1 && !STOP_WORDS.has(word)) addFacet(facets, word);
  }
  if (facets.size === 0) addFacet(facets, goal);
  return [...facets.values()].sort((left, right) =>
    compareCodeUnits(left.value, right.value)
  );
};

export const deriveContextFacets = (
  goal: string,
  queryModes: readonly QueryModeInput[] = []
): string[] =>
  deriveContextFacetPlan(goal, queryModes).map((facet) => facet.value);

export const candidateMatchesContextFacet = (
  facet: ContextDerivedFacet,
  result: SearchResult,
  text: string,
  temporalRange: { since?: string; until?: string }
): boolean => {
  if (facet.temporal) {
    const timestamp = result.source.documentDate ?? result.source.modifiedAt;
    return Boolean(
      timestamp && isWithinTemporalRange(timestamp, temporalRange)
    );
  }
  const haystack = normalizeContextText(
    `${result.title ?? ""}\n${text}`
  ).toLocaleLowerCase("und");
  return haystack.includes(facet.matchText);
};
