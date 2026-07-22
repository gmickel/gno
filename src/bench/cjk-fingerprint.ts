const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
};

export const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const fingerprint = (value: unknown): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableJson(value));
  return hasher.digest("hex");
};

const withoutVolatileFields = (value: unknown, parentKey?: string): unknown => {
  if (Array.isArray(value)) {
    return value.map((child) => withoutVolatileFields(child, parentKey));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            key !== "generatedAt" &&
            !key.endsWith("Ms") &&
            !(parentKey === "fingerprints" && key === "result")
        )
        .map(([key, child]) => [key, withoutVolatileFields(child, key)])
    );
  }
  return value;
};

export const fingerprintStableResult = (value: unknown): string =>
  fingerprint(withoutVolatileFields(value));
