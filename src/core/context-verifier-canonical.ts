/** Stable JSON and raw text checks used by Capsule verification guards. */

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${key}`);
      }
      sorted[key] = canonicalizeJsonValue(child);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON rejects non-finite numbers");
  }
  return value;
};

export const canonicalVerifierJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));

const isNoncanonicalNormalizedText = (value: unknown): boolean => {
  if (typeof value === "string") {
    return value.includes("\r") || value !== value.normalize("NFC");
  }
  return false;
};

const containsNoncanonicalText = (value: unknown): boolean =>
  Array.isArray(value) && value.some(isNoncanonicalNormalizedText);

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** Mirrors only the text fields normalized by normalizePayload. */
export const hasNoncanonicalVerifierText = (value: unknown): boolean => {
  const capsule = recordOf(value);
  const scope = recordOf(capsule.scope);
  const retrieval = recordOf(capsule.retrieval);
  const guidance = recordOf(capsule.guidance);
  const coverage = recordOf(capsule.coverage);
  const evidence = Array.isArray(capsule.evidence) ? capsule.evidence : [];
  const configuredContexts = Array.isArray(guidance.configuredContexts)
    ? guidance.configuredContexts
    : [];
  const coveredFacets = Array.isArray(coverage.coveredFacets)
    ? coverage.coveredFacets
    : [];

  return (
    isNoncanonicalNormalizedText(capsule.goal) ||
    isNoncanonicalNormalizedText(capsule.query) ||
    isNoncanonicalNormalizedText(scope.uriPrefix) ||
    containsNoncanonicalText(scope.collections) ||
    containsNoncanonicalText(scope.tagsAll) ||
    containsNoncanonicalText(scope.tagsAny) ||
    containsNoncanonicalText(scope.categories) ||
    containsNoncanonicalText(retrieval.facets) ||
    containsNoncanonicalText(retrieval.queryVariants) ||
    evidence.some((item) => {
      const record = recordOf(item);
      return (
        isNoncanonicalNormalizedText(record.title) ||
        isNoncanonicalNormalizedText(record.heading) ||
        containsNoncanonicalText(record.contextIds) ||
        containsNoncanonicalText(record.facets)
      );
    }) ||
    configuredContexts.some((item) => {
      const record = recordOf(item);
      return (
        isNoncanonicalNormalizedText(record.scopeKey) ||
        isNoncanonicalNormalizedText(record.text)
      );
    }) ||
    containsNoncanonicalText(coverage.requestedFacets) ||
    coveredFacets.some((item) =>
      isNoncanonicalNormalizedText(recordOf(item).facet)
    ) ||
    containsNoncanonicalText(coverage.unresolvedFacets)
  );
};
