/** Deterministic projection for untrusted evidence metadata. */

export const CONTEXT_EVIDENCE_METADATA_MAX_LENGTH = 2048;

const wellFormedScalar = (value: string): string => {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
    ? "\uFFFD"
    : value;
};

/**
 * Match the Capsule metadata normalization boundary, then truncate without
 * splitting a Unicode scalar or retaining lone surrogate code units.
 */
export const projectContextEvidenceMetadata = (
  value: string | null
): string | null => {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC");
  let projected = "";
  for (const rawScalar of normalized) {
    const scalar = wellFormedScalar(rawScalar);
    if (
      projected.length + scalar.length >
      CONTEXT_EVIDENCE_METADATA_MAX_LENGTH
    ) {
      break;
    }
    projected += scalar;
  }
  return projected;
};
