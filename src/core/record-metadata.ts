import type { RecordAnchor, RecordMetadata } from "../converters/types";

export interface RecordEvidenceMetadata extends RecordMetadata {
  recordKey: string;
  sourceLocator: string;
  anchors: RecordAnchor[];
  adapter: {
    id: string;
    version: string;
    fingerprint: string;
  };
}

interface RecordMetadataSource {
  recordKey?: string | null;
  recordSourceLocator?: string | null;
  recordMetadata?: RecordMetadata | null;
  recordAnchors?: RecordAnchor[] | null;
  converterId?: string | null;
  converterVersion?: string | null;
  recordAdapterFingerprint?: string | null;
}

export const RECORD_PROVENANCE_REQUIRED_FIELDS = [
  "recordKey",
  "recordSourceLocator",
  "converterId",
  "converterVersion",
  "recordAdapterFingerprint",
] as const;

export interface RecordProvenanceIssue {
  field: (typeof RECORD_PROVENANCE_REQUIRED_FIELDS)[number];
  reason: "missing";
}

/** Generic converter identity alone does not declare a logical-record contract. */
export const hasDeclaredRecordProvenance = (
  source: RecordMetadataSource
): boolean =>
  source.recordKey != null ||
  source.recordSourceLocator != null ||
  source.recordAdapterFingerprint != null ||
  source.recordMetadata != null ||
  source.recordAnchors != null;

/** Validate completeness only when logical-record provenance is declared. */
export const validateDeclaredRecordProvenance = (
  source: RecordMetadataSource
): RecordProvenanceIssue[] => {
  if (!hasDeclaredRecordProvenance(source)) return [];
  return RECORD_PROVENANCE_REQUIRED_FIELDS.filter(
    (field) => !source[field]
  ).map((field) => ({ field, reason: "missing" as const }));
};

/** Project only bounded, collection-relative logical-record provenance. */
export const projectRecordEvidenceMetadata = (
  source: RecordMetadataSource
): RecordEvidenceMetadata | undefined => {
  if (
    !(
      source.recordKey &&
      source.recordSourceLocator &&
      source.converterId &&
      source.converterVersion &&
      source.recordAdapterFingerprint
    )
  )
    return undefined;
  return {
    recordKey: source.recordKey,
    sourceLocator: source.recordSourceLocator,
    anchors: source.recordAnchors ?? [],
    adapter: {
      id: source.converterId,
      version: source.converterVersion,
      fingerprint: source.recordAdapterFingerprint,
    },
    ...source.recordMetadata,
  };
};
