/**
 * Closed validation and transport projection for section targets.
 * Private helper — import public API from `./sections`.
 *
 * Shared by REST and SDK so response shapes stay identical without
 * duplicating parser/resolver logic.
 *
 * @module src/core/section-target-transport
 */

import {
  SECTION_TARGET_BOUNDS,
  SECTION_TARGET_SCHEMA_VERSION,
  isBoundedSectionTarget,
  type SectionTargetV1,
} from "./section-target";
import {
  isNavigableSectionResolution,
  type SectionResolution,
  type SectionResolutionCandidate,
  type SectionResolutionStatus,
} from "./section-target-resolve";

export type TransportValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface SectionTargetCreateSelector {
  anchor?: string;
  line?: number;
}

/** REST/SDK create response — canonical stored URI + target. */
export interface SectionTargetCreateResult {
  uri: string;
  target: SectionTargetV1;
}

/** Citation evidence exposed only for navigable resolutions. */
export interface SectionCitationV1 {
  uri: string;
  anchor: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  sourceFingerprint: string;
}

/**
 * Transport diagnostics. Candidates are filtered/projected to schema bounds
 * without truncating identity strings; `candidateCount` is the pre-filter
 * total and `candidatesTruncated` is true when any candidate was omitted.
 */
export interface SectionResolutionDiagnostics {
  reason?: string;
  candidates?: SectionResolutionCandidate[];
  candidateCount?: number;
  candidatesTruncated?: boolean;
}

/**
 * REST/SDK resolve response. Non-navigable results omit citation and any
 * navigation fields.
 */
export interface SectionTargetResolveResult {
  uri: string;
  status: SectionResolutionStatus;
  currentFingerprint: string;
  target: SectionTargetV1;
  diagnostics: SectionResolutionDiagnostics;
  citation?: SectionCitationV1;
}

/** Transport-only bounds for resolve diagnostics / citation projection. */
export const SECTION_TARGET_TRANSPORT_BOUNDS = {
  diagnosticsCandidatesMaxItems: 32,
  reasonMaxChars: 256,
  titleMaxChars: SECTION_TARGET_BOUNDS.anchorMaxChars,
} as const;

/** Stable reason when a navigable citation cannot fit transport bounds. */
export const CITATION_EXCEEDS_TRANSPORT_BOUNDS =
  "citation_exceeds_transport_bounds" as const;

/** Stable VALIDATION message when a stored canonical URI cannot fit transport. */
export const CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS =
  `Canonical document URI exceeds the maximum length of ${SECTION_TARGET_BOUNDS.uriMaxChars}` as const;

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const invalid = <T>(error: string): TransportValidationResult<T> => ({
  ok: false,
  error,
});
/**
 * Snapshot only own data properties. Accessors, exotic prototypes, symbols,
 * proxy traps, arrays, and unknown keys are rejected without invoking getters.
 */
const closedRecord = (
  value: unknown,
  allowedKeys: readonly string[]
): TransportValidationResult<Record<string, unknown>> => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid("Expected a JSON object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid("Expected a plain JSON object");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > allowedKeys.length ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return invalid("Object contains unknown fields");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return invalid("Invalid object field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return invalid("Accessor fields are not allowed");
      }
      result[key] = descriptor.value;
    }
    return { ok: true, value: result };
  } catch {
    return invalid("Unreadable input object");
  }
};

const parseNonEmptyString = (
  value: unknown,
  field: string,
  maxChars: number
): TransportValidationResult<string> => {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string`);
  }
  if (value.length < 1) {
    return invalid(`${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    return invalid(`${field} exceeds the maximum length of ${maxChars}`);
  }
  return { ok: true, value };
};

const parseBoundedString = (
  value: unknown,
  field: string,
  maxChars: number
): TransportValidationResult<string> => {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string`);
  }
  if (value.length > maxChars) {
    return invalid(`${field} exceeds the maximum length of ${maxChars}`);
  }
  return { ok: true, value };
};

const parsePositiveInt = (
  value: unknown,
  field: string
): TransportValidationResult<number> => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(`${field} must be a positive safe integer`);
  }
  return { ok: true, value };
};

const parseNonNegativeInt = (
  value: unknown,
  field: string
): TransportValidationResult<number> => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${field} must be a non-negative safe integer`);
  }
  return { ok: true, value };
};
/**
 * Require exactly one selector: `anchor` XOR `line`.
 * Rejects unknown fields and empty/oversized values.
 */
export const parseSectionTargetCreateSelector = (
  value: unknown
): TransportValidationResult<SectionTargetCreateSelector> => {
  const record = closedRecord(value, ["anchor", "line"]);
  if (!record.ok) return record;

  const hasAnchor = Object.hasOwn(record.value, "anchor");
  const hasLine = Object.hasOwn(record.value, "line");
  if (hasAnchor === hasLine) {
    return invalid("Provide exactly one of anchor or line");
  }

  if (hasAnchor) {
    const anchor = parseNonEmptyString(
      record.value.anchor,
      "anchor",
      SECTION_TARGET_BOUNDS.anchorMaxChars
    );
    if (!anchor.ok) return anchor;
    return { ok: true, value: { anchor: anchor.value } };
  }

  const line = parsePositiveInt(record.value.line, "line");
  if (!line.ok) return line;
  return { ok: true, value: { line: line.value } };
};

/**
 * Validate an untrusted SectionTargetV1 before core resolve.
 * Enforces closed shape, bounds, fingerprint format, and serialized size.
 */
export const parseSectionTargetV1 = (
  value: unknown
): TransportValidationResult<SectionTargetV1> => {
  const record = closedRecord(value, [
    "schemaVersion",
    "document",
    "anchor",
    "headingPath",
    "occurrence",
    "quote",
    "sourceFingerprint",
    "hints",
  ]);
  if (!record.ok) return record;

  if (record.value.schemaVersion !== SECTION_TARGET_SCHEMA_VERSION) {
    return invalid('schemaVersion must be "1"');
  }

  const document = closedRecord(record.value.document, ["uri"]);
  if (!document.ok) return invalid(`document: ${document.error}`);
  const uri = parseNonEmptyString(
    document.value.uri,
    "document.uri",
    SECTION_TARGET_BOUNDS.uriMaxChars
  );
  if (!uri.ok) return uri;

  const anchor = parseNonEmptyString(
    record.value.anchor,
    "anchor",
    SECTION_TARGET_BOUNDS.anchorMaxChars
  );
  if (!anchor.ok) return anchor;

  if (!Array.isArray(record.value.headingPath)) {
    return invalid("headingPath must be an array");
  }
  if (
    record.value.headingPath.length < 1 ||
    record.value.headingPath.length > SECTION_TARGET_BOUNDS.headingPathMaxItems
  ) {
    return invalid(
      `headingPath must contain 1 to ${SECTION_TARGET_BOUNDS.headingPathMaxItems} items`
    );
  }
  const headingPath: string[] = [];
  for (const [index, item] of record.value.headingPath.entries()) {
    const parsed = parseNonEmptyString(
      item,
      `headingPath[${index}]`,
      SECTION_TARGET_BOUNDS.headingPathItemMaxChars
    );
    if (!parsed.ok) return parsed;
    headingPath.push(parsed.value);
  }

  const occurrence = parsePositiveInt(record.value.occurrence, "occurrence");
  if (!occurrence.ok) return occurrence;

  const quoteRecord = closedRecord(record.value.quote, [
    "exact",
    "prefix",
    "suffix",
  ]);
  if (!quoteRecord.ok) return invalid(`quote: ${quoteRecord.error}`);
  const exact = parseBoundedString(
    quoteRecord.value.exact,
    "quote.exact",
    SECTION_TARGET_BOUNDS.exactMaxChars
  );
  if (!exact.ok) return exact;
  const prefix = parseBoundedString(
    quoteRecord.value.prefix,
    "quote.prefix",
    SECTION_TARGET_BOUNDS.prefixMaxChars
  );
  if (!prefix.ok) return prefix;
  const suffix = parseBoundedString(
    quoteRecord.value.suffix,
    "quote.suffix",
    SECTION_TARGET_BOUNDS.suffixMaxChars
  );
  if (!suffix.ok) return suffix;

  if (
    typeof record.value.sourceFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(record.value.sourceFingerprint)
  ) {
    return invalid("sourceFingerprint must be a lowercase SHA-256 hex digest");
  }

  const hintsRecord = closedRecord(record.value.hints, [
    "line",
    "startOffset",
    "endOffset",
  ]);
  if (!hintsRecord.ok) return invalid(`hints: ${hintsRecord.error}`);
  const hintsLine = parsePositiveInt(hintsRecord.value.line, "hints.line");
  if (!hintsLine.ok) return hintsLine;
  const startOffset = parseNonNegativeInt(
    hintsRecord.value.startOffset,
    "hints.startOffset"
  );
  if (!startOffset.ok) return startOffset;
  const endOffset = parseNonNegativeInt(
    hintsRecord.value.endOffset,
    "hints.endOffset"
  );
  if (!endOffset.ok) return endOffset;
  if (endOffset.value < startOffset.value) {
    return invalid("hints.endOffset must be >= hints.startOffset");
  }

  const target: SectionTargetV1 = {
    schemaVersion: SECTION_TARGET_SCHEMA_VERSION,
    document: { uri: uri.value },
    anchor: anchor.value,
    headingPath,
    occurrence: occurrence.value,
    quote: {
      exact: exact.value,
      prefix: prefix.value,
      suffix: suffix.value,
    },
    sourceFingerprint: record.value.sourceFingerprint,
    hints: {
      line: hintsLine.value,
      startOffset: startOffset.value,
      endOffset: endOffset.value,
    },
  };

  // Serialized-byte budget is owned by isBoundedSectionTarget — no recheck.
  if (!isBoundedSectionTarget(target)) {
    return invalid("Section target exceeds size bounds");
  }

  return { ok: true, value: target };
};
/** Resolve-body wrapper: `{ target: SectionTargetV1 }` only. */
export const parseSectionTargetResolveBody = (
  value: unknown
): TransportValidationResult<{ target: SectionTargetV1 }> => {
  const record = closedRecord(value, ["target"]);
  if (!record.ok) return record;
  if (!Object.hasOwn(record.value, "target")) {
    return invalid("target is required");
  }
  const target = parseSectionTargetV1(record.value.target);
  if (!target.ok) return target;
  return { ok: true, value: { target: target.value } };
};

export const projectSectionTargetCreateResult = (
  uri: string,
  target: SectionTargetV1
): SectionTargetCreateResult => ({
  uri,
  target,
});

const isBoundedTransportString = (
  value: string,
  minChars: number,
  maxChars: number
): boolean => value.length >= minChars && value.length <= maxChars;

const isBoundedPositiveSafeInt = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 1;

/**
 * True when a canonical document URI fits top-level transport `uri` bounds.
 * Adapters must reject before create/projection — never truncate or rewrite.
 */
export const isTransportBoundedCanonicalUri = (uri: string): boolean =>
  isBoundedTransportString(uri, 1, SECTION_TARGET_BOUNDS.uriMaxChars);

/** True when a candidate fits transport schema bounds without truncation. */
export const isTransportBoundedCandidate = (
  candidate: SectionResolutionCandidate
): boolean =>
  isBoundedTransportString(
    candidate.anchor,
    1,
    SECTION_TARGET_BOUNDS.anchorMaxChars
  ) &&
  isBoundedTransportString(
    candidate.title,
    1,
    SECTION_TARGET_TRANSPORT_BOUNDS.titleMaxChars
  ) &&
  isBoundedPositiveSafeInt(candidate.line) &&
  isBoundedPositiveSafeInt(candidate.occurrence) &&
  candidate.headingPath.length >= 1 &&
  candidate.headingPath.length <= SECTION_TARGET_BOUNDS.headingPathMaxItems &&
  candidate.headingPath.every((item) =>
    isBoundedTransportString(
      item,
      1,
      SECTION_TARGET_BOUNDS.headingPathItemMaxChars
    )
  );

/** True when a citation fits transport schema bounds without truncation. */
export const isTransportBoundedCitation = (
  citation: SectionCitationV1
): boolean =>
  isBoundedTransportString(
    citation.uri,
    1,
    SECTION_TARGET_BOUNDS.uriMaxChars
  ) &&
  isBoundedTransportString(
    citation.anchor,
    1,
    SECTION_TARGET_BOUNDS.anchorMaxChars
  ) &&
  isBoundedTransportString(
    citation.title,
    1,
    SECTION_TARGET_TRANSPORT_BOUNDS.titleMaxChars
  ) &&
  isBoundedPositiveSafeInt(citation.lineStart) &&
  isBoundedPositiveSafeInt(citation.lineEnd) &&
  citation.lineEnd >= citation.lineStart &&
  FINGERPRINT_PATTERN.test(citation.sourceFingerprint);

const projectDiagnostics = (
  resolution: SectionResolution
): SectionResolutionDiagnostics => {
  const diagnostics: SectionResolutionDiagnostics = {};
  if (
    resolution.reason !== undefined &&
    resolution.reason.length >= 1 &&
    resolution.reason.length <= SECTION_TARGET_TRANSPORT_BOUNDS.reasonMaxChars
  ) {
    diagnostics.reason = resolution.reason;
  }

  if (resolution.candidates === undefined) {
    return diagnostics;
  }

  const candidateCount = resolution.candidates.length;
  const fitting = resolution.candidates.filter(isTransportBoundedCandidate);
  const emitted = fitting.slice(
    0,
    SECTION_TARGET_TRANSPORT_BOUNDS.diagnosticsCandidatesMaxItems
  );
  diagnostics.candidates = emitted;
  diagnostics.candidateCount = candidateCount;
  diagnostics.candidatesTruncated = emitted.length < candidateCount;
  return diagnostics;
};

export const projectSectionTargetResolveResult = (
  uri: string,
  resolution: SectionResolution
): SectionTargetResolveResult => {
  const diagnostics = projectDiagnostics(resolution);

  if (isNavigableSectionResolution(resolution)) {
    const citation: SectionCitationV1 = {
      uri,
      anchor: resolution.section.anchor,
      title: resolution.section.title,
      lineStart: resolution.section.line,
      lineEnd: resolution.section.endLine,
      sourceFingerprint: resolution.currentFingerprint,
    };
    if (isTransportBoundedCitation(citation)) {
      return {
        uri,
        status: resolution.status,
        currentFingerprint: resolution.currentFingerprint,
        target: resolution.target,
        diagnostics,
        citation,
      };
    }
    // Fail closed: never truncate identity or emit an unbound citation.
    return {
      uri,
      status: "stale",
      currentFingerprint: resolution.currentFingerprint,
      target: resolution.target,
      diagnostics: {
        ...diagnostics,
        reason: CITATION_EXCEEDS_TRANSPORT_BOUNDS,
      },
    };
  }

  return {
    uri,
    status: resolution.status,
    currentFingerprint: resolution.currentFingerprint,
    target: resolution.target,
    diagnostics,
  };
};
