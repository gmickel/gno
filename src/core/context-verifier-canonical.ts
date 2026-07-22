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

export const hasNoncanonicalVerifierText = (value: unknown): boolean => {
  if (typeof value === "string") {
    return value.includes("\r") || value !== value.normalize("NFC");
  }
  if (Array.isArray(value)) return value.some(hasNoncanonicalVerifierText);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNoncanonicalVerifierText);
  }
  return false;
};
