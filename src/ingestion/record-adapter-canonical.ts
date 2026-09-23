import type {
  RecordAdapter,
  RecordAdapterFailure,
  RecordAdapterFailureCode,
  RecordAdapterInput,
  RecordAdapterRecord,
  RecordAnchor,
  RecordMetadata,
} from "../converters/types";
import type { TypedMetadata } from "../core/typed-metadata";

import { canonicalize, mirrorHash } from "../converters/canonicalize";
import { RECORD_METADATA_LIMITS } from "../converters/types";
import { validateRecordMetadata } from "./typed-metadata";

const HASH_PATTERN = /^[a-f\d]{64}$/;
const CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`
);
const CONTROL_REPLACE_PATTERN = new RegExp(CONTROL_PATTERN.source, "g");
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const MAX_ID_CHARS = 512;
const MAX_LOCATOR_CHARS = 512;
const MAX_ERROR_CHARS = 240;
const RECORD_ANCHOR_KINDS = new Set<RecordAnchor["kind"]>([
  "line",
  "cue",
  "timestamp",
  "message",
  "event",
  "record",
]);
const RECORD_ATTACHMENT_DISPOSITIONS = new Set<
  NonNullable<NonNullable<RecordMetadata["attachments"]>[number]["disposition"]>
>(["inline", "attachment"]);

export interface CanonicalRecord {
  typedMetadata?: TypedMetadata;
  metadataError?: string;
  recordKey: string;
  stableId: string;
  sourceLocator: string;
  sourceHash: string;
  mirrorHash: string;
  markdown: string;
  adapterId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  title?: string;
  languageHint?: string;
  metadata?: Omit<RecordMetadata, "custom">;
  anchors?: RecordAnchor[];
}

export interface AccountedCanonicalRecord extends CanonicalRecord {
  accountingChars: number;
  metadataChars: number;
}

export interface RecordAdapterIdentity {
  id: string;
  version: string;
}

const hashText = (value: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonicalJsonValue((value as Record<string, unknown>)[key]);
      if (child !== undefined) result[key] = child;
    }
    return result;
  }
  return value;
};

const normalizeText = (value: string): string => value.normalize("NFC").trim();

export const normalizeRecordAdapterIdentity = (
  adapter: Pick<RecordAdapter, "id" | "version">
): RecordAdapterIdentity => {
  const id =
    typeof adapter.id === "string" ? normalizeText(adapter.id) : undefined;
  const version =
    typeof adapter.version === "string"
      ? normalizeText(adapter.version)
      : undefined;
  if (
    !id ||
    id.length > RECORD_METADATA_LIMITS.maxAdapterIdChars ||
    CONTROL_PATTERN.test(id)
  ) {
    throw new Error("invalid record adapter ID");
  }
  if (
    !version ||
    version.length > RECORD_METADATA_LIMITS.maxAdapterVersionChars ||
    CONTROL_PATTERN.test(version)
  ) {
    throw new Error("invalid record adapter version");
  }
  return { id, version };
};

export const recordAdapterFingerprint = (adapter: RecordAdapter): string => {
  const identity = normalizeRecordAdapterIdentity(adapter);
  return hashText(
    `gno-record-adapter-v1\0${identity.id}\0${identity.version}\0${adapter.configurationFingerprint ?? "default"}`
  );
};

const normalizeStableId = (value: string): string => {
  const normalized = normalizeText(value);
  if (
    normalized.length === 0 ||
    normalized.length > MAX_ID_CHARS ||
    CONTROL_PATTERN.test(normalized) ||
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATTERN.test(normalized)
  ) {
    throw new Error("invalid stable ID");
  }
  return normalized;
};

const normalizeLocator = (value: string): string => {
  const normalized = normalizeText(value);
  const pathSegments = normalized.replaceAll("\\", "/").split("/");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_LOCATOR_CHARS ||
    CONTROL_PATTERN.test(normalized) ||
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATTERN.test(normalized) ||
    pathSegments.includes("..")
  ) {
    throw new Error("invalid source locator");
  }
  return normalized;
};

const normalizeOptionalText = (
  value: string | undefined
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeText(value).replace(CONTROL_REPLACE_PATTERN, "");
  return normalized || undefined;
};

const boundedText = (
  value: string | undefined,
  maxChars: number
): string | undefined => {
  const normalized = normalizeOptionalText(value);
  if (normalized && normalized.length > maxChars) {
    throw new Error("record metadata out of bounds");
  }
  return normalized;
};

const normalizeSha256 = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (!HASH_PATTERN.test(value)) {
    throw new Error("record metadata out of bounds");
  }
  return value;
};

const normalizeFailureReference = (
  value: string | undefined
): string | undefined => {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return undefined;
  const pathSegments = normalized.replaceAll("\\", "/").split("/");
  if (
    normalized.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATTERN.test(normalized) ||
    pathSegments.includes("..")
  ) {
    return undefined;
  }
  return normalized.slice(0, MAX_LOCATOR_CHARS);
};

const normalizeMetadata = (
  metadata: RecordMetadata | undefined
): Omit<RecordMetadata, "custom"> | undefined => {
  if (!metadata) return undefined;
  const normalizeList = (
    values: string[] | undefined,
    maxChars: number
  ): string[] | undefined => {
    if (!values) return undefined;
    if (values.length > RECORD_METADATA_LIMITS.maxItems) {
      throw new Error("record metadata out of bounds");
    }
    return values
      .map((value) => boundedText(value, maxChars))
      .filter((value): value is string => Boolean(value));
  };
  const dateEntries = Object.entries(metadata.dateFields ?? {});
  if (dateEntries.length > RECORD_METADATA_LIMITS.maxItems) {
    throw new Error("record metadata out of bounds");
  }
  const dateFields = metadata.dateFields
    ? Object.fromEntries(
        dateEntries
          .map(([key, value]) => [
            boundedText(key, RECORD_METADATA_LIMITS.maxDateFieldKeyChars),
            boundedText(value, RECORD_METADATA_LIMITS.maxDateFieldValueChars),
          ])
          .filter(
            (entry): entry is [string, string] =>
              Boolean(entry[0]) && Boolean(entry[1])
          )
          .sort(([left], [right]) => left.localeCompare(right))
      )
    : undefined;
  if (
    metadata.attachments &&
    metadata.attachments.length > RECORD_METADATA_LIMITS.maxItems
  ) {
    throw new Error("record metadata out of bounds");
  }
  return {
    author: boundedText(metadata.author, RECORD_METADATA_LIMITS.maxPersonChars),
    participants: normalizeList(
      metadata.participants,
      RECORD_METADATA_LIMITS.maxPersonChars
    ),
    categories: normalizeList(
      metadata.categories,
      RECORD_METADATA_LIMITS.maxCategoryChars
    ),
    dateFields,
    messageId: boundedText(
      metadata.messageId,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    inReplyTo: boundedText(
      metadata.inReplyTo,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    references: normalizeList(
      metadata.references,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    threadId: boundedText(
      metadata.threadId,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    eventId: boundedText(
      metadata.eventId,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    sessionId: boundedText(
      metadata.sessionId,
      RECORD_METADATA_LIMITS.maxIdentifierChars
    ),
    attachments: metadata.attachments?.map((attachment) => {
      if (
        attachment.bytes !== undefined &&
        (!Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0)
      ) {
        throw new Error("record metadata out of bounds");
      }
      if (
        attachment.disposition !== undefined &&
        !RECORD_ATTACHMENT_DISPOSITIONS.has(attachment.disposition)
      ) {
        throw new Error("record metadata out of bounds");
      }
      return {
        name:
          boundedText(
            attachment.name,
            RECORD_METADATA_LIMITS.maxAttachmentNameChars
          ) ?? "attachment",
        mime: boundedText(
          attachment.mime,
          RECORD_METADATA_LIMITS.maxAttachmentMimeChars
        ),
        bytes: attachment.bytes,
        disposition: attachment.disposition,
        sha256: normalizeSha256(attachment.sha256),
      };
    }),
  };
};

const normalizeAnchors = (
  anchors: RecordAnchor[] | undefined
): RecordAnchor[] | undefined => {
  if (!anchors) return undefined;
  if (anchors.length > RECORD_METADATA_LIMITS.maxItems) {
    throw new Error("record metadata out of bounds");
  }
  return anchors.map((anchor) => {
    if (!RECORD_ANCHOR_KINDS.has(anchor.kind)) {
      throw new Error("record metadata out of bounds");
    }
    return {
      kind: anchor.kind,
      value:
        boundedText(anchor.value, RECORD_METADATA_LIMITS.maxAnchorChars) ??
        "unknown",
      endValue: boundedText(
        anchor.endValue,
        RECORD_METADATA_LIMITS.maxAnchorChars
      ),
    };
  });
};

export const recordKeyFor = (adapterId: string, stableId: string): string =>
  hashText(`gno-record-v1\0${adapterId}\0${normalizeStableId(stableId)}`);

export const safeFailure = (
  input: RecordAdapterInput,
  code: RecordAdapterFailureCode,
  message: string,
  retryable: boolean,
  stableId?: string,
  sourceLocator?: string
): RecordAdapterFailure => {
  const withoutPath = message.replaceAll(input.sourcePath, "<source>");
  const sanitized = withoutPath
    .replace(CONTROL_REPLACE_PATTERN, " ")
    .slice(0, MAX_ERROR_CHARS);
  return {
    code,
    message: sanitized || "Record adapter failure.",
    retryable,
    stableId: normalizeFailureReference(stableId),
    sourceLocator: normalizeFailureReference(sourceLocator),
  };
};

export const canonicalRecord = (
  adapter: RecordAdapter,
  record: RecordAdapterRecord
): AccountedCanonicalRecord => {
  const adapterIdentity = normalizeRecordAdapterIdentity(adapter);
  const stableId = normalizeStableId(record.stableId);
  const sourceLocator = normalizeLocator(record.sourceLocator);
  const markdown = canonicalize(record.markdown);
  const metadata = normalizeMetadata(record.metadata);
  const custom =
    record.metadata && Object.hasOwn(record.metadata, "custom")
      ? validateRecordMetadata(record.metadata.custom, "metadata.custom")
      : undefined;
  const anchors = normalizeAnchors(record.anchors);
  const title = boundedText(record.title, RECORD_METADATA_LIMITS.maxTitleChars);
  const languageHint = boundedText(
    record.languageHint,
    RECORD_METADATA_LIMITS.maxLanguageHintChars
  );
  const derivedSource = JSON.stringify(
    canonicalJsonValue({
      anchors,
      languageHint,
      markdown,
      metadata,
      ...custom,
      sourceLocator,
      stableId,
      title,
    })
  );
  const metadataChars = JSON.stringify(
    canonicalJsonValue({
      anchors,
      languageHint,
      metadata,
      ...custom,
      sourceLocator,
      stableId,
      title,
    })
  ).length;
  if (
    record.sourceHash !== undefined &&
    !HASH_PATTERN.test(record.sourceHash)
  ) {
    throw new Error("invalid source hash");
  }
  return {
    recordKey: recordKeyFor(adapterIdentity.id, stableId),
    stableId,
    sourceLocator,
    sourceHash:
      record.sourceHash ?? hashText(`gno-record-source-v1\0${derivedSource}`),
    mirrorHash: mirrorHash(markdown),
    markdown,
    adapterId: adapterIdentity.id,
    adapterVersion: adapterIdentity.version,
    adapterFingerprint: recordAdapterFingerprint(adapter),
    title,
    languageHint,
    metadata,
    ...custom,
    anchors,
    accountingChars: derivedSource.length,
    metadataChars,
  };
};

export const adapterFailureMessage = (
  code: RecordAdapterFailureCode
): string => {
  switch (code) {
    case "MALFORMED_RECORD":
      return "Record adapter reported a malformed record.";
    case "MISSING_ID":
      return "Record adapter reported a missing stable identity.";
    case "DUPLICATE_ID":
      return "Record adapter reported a duplicate stable identity.";
    case "RECORD_TOO_LARGE":
      return "Record adapter reported an oversized record.";
    case "SOURCE_TOO_LARGE":
      return "Record adapter reported an oversized source.";
    case "TIMEOUT":
      return "Record adapter exceeded its time limit.";
    case "RECORD_LIMIT":
      return "Record adapter reported that its record limit was reached.";
    case "FAILURE_LIMIT":
      return "Record adapter reported that its failure limit was reached.";
    case "INVALID_LOCATOR":
      return "Record adapter reported an invalid source locator.";
    case "INVALID_SOURCE_HASH":
      return "Record adapter reported an invalid source hash.";
    case "INVALID_SNAPSHOT":
      return "Record adapter reported an invalid snapshot.";
    default:
      return "Record adapter reported a conversion failure.";
  }
};
