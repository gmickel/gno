/** Deterministic set-like retrieval-filter normalization before persistence. */

const SET_ARRAY_KEYS = [
  "categories",
  "collections",
  "exclude",
  "tagsAll",
  "tagsAny",
] as const;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalizeRetrievalTraceFilters = <
  Filters extends Record<string, unknown>,
>(
  filters: Filters
): Filters => {
  const normalized: Record<string, unknown> = { ...filters };
  for (const key of SET_ARRAY_KEYS) {
    const values = filters[key];
    if (Array.isArray(values)) {
      normalized[key] = [...new Set(values)].sort(compareCodeUnits);
    }
  }
  return normalized as Filters;
};
