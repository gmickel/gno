import type { AgentTask } from "./types";

const TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

const normalize = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ");

const quoteFts = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const publicClaimTerms = (task: Readonly<AgentTask>): string[] =>
  task.claims.flatMap(
    (claim) =>
      claim.claimKey
        .replace(CAMEL_BOUNDARY, "$1 $2")
        .toLowerCase()
        .match(TOKEN_PATTERN) ?? []
  );

export interface CapsuleQueryPlan {
  requestedQuery: string;
  variants: string[];
  facets: string[];
}

/** Deterministic, oracle-free query variants from agent-visible inputs only. */
export const planCapsuleQuery = (
  task: Readonly<AgentTask>,
  requestedQuery: string
): CapsuleQueryPlan => {
  const query = normalize(requestedQuery);
  const queryTerms = query.toLowerCase().match(TOKEN_PATTERN) ?? [];
  const facetTerms = [...queryTerms, ...publicClaimTerms(task)]
    .map(normalize)
    .filter((term) => term.length >= 2);
  const facets = [...new Set(facetTerms)].sort();
  const variants = [query, quoteFts(query), ...facets.map(quoteFts)].filter(
    (variant) => variant.length > 0
  );
  return {
    requestedQuery: query,
    variants: [...new Set(variants)],
    facets,
  };
};

export const matchingCapsuleFacets = (
  text: string,
  facets: readonly string[]
): string[] => {
  const normalized = normalize(text).toLowerCase();
  return facets.filter((facet) => normalized.includes(facet));
};
