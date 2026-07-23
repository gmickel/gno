/**
 * Shared, storage-agnostic contracts for the document change journal.
 */

import type {
  DocumentChangeDateDelta,
  DocumentChangeSet,
  DocumentChangeStructureDelta,
  DocumentChangeRetentionPolicy,
} from "../store/types";

const CURSOR_PREFIX = "gno-change-v1.";
const MAX_DELTA_ITEMS_PER_SIDE = 16;
const MAX_DELTA_VALUE_CHARS = 256;

export const DEFAULT_DOCUMENT_CHANGE_RETENTION: DocumentChangeRetentionPolicy =
  {
    maxAgeDays: 30,
    maxEntries: 10_000,
    maxBytes: 16 * 1024 * 1024,
  };

export const EMPTY_DOCUMENT_CHANGE_SET: DocumentChangeSet = {
  added: [],
  removed: [],
};

export const EMPTY_DOCUMENT_CHANGE_DATE_DELTA: DocumentChangeDateDelta = {
  added: [],
  removed: [],
  changed: [],
};

export const EMPTY_DOCUMENT_CHANGE_STRUCTURE_DELTA: DocumentChangeStructureDelta =
  {
    headings: EMPTY_DOCUMENT_CHANGE_SET,
    links: EMPTY_DOCUMENT_CHANGE_SET,
    typedEdges: EMPTY_DOCUMENT_CHANGE_SET,
    dates: EMPTY_DOCUMENT_CHANGE_DATE_DELTA,
    truncated: false,
  };

const normalizeValues = (
  values: readonly string[] | undefined
): { values: string[]; truncated: boolean } => {
  const unique = [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ].sort();
  const selected = unique
    .slice(0, MAX_DELTA_ITEMS_PER_SIDE)
    .map((value) => value.slice(0, MAX_DELTA_VALUE_CHARS));
  return {
    values: selected,
    truncated:
      unique.length > selected.length ||
      unique.some((value, index) => value !== selected[index]),
  };
};

const normalizeSet = (
  value: Partial<DocumentChangeSet> | undefined
): { value: DocumentChangeSet; truncated: boolean } => {
  const added = normalizeValues(value?.added);
  const removed = normalizeValues(value?.removed);
  return {
    value: { added: added.values, removed: removed.values },
    truncated: added.truncated || removed.truncated,
  };
};

const normalizeDates = (
  value: Partial<DocumentChangeDateDelta> | undefined
): { value: DocumentChangeDateDelta; truncated: boolean } => {
  const added = normalizeValues(value?.added);
  const removed = normalizeValues(value?.removed);
  const changed = normalizeValues(value?.changed);
  return {
    value: {
      added: added.values,
      removed: removed.values,
      changed: changed.values,
    },
    truncated: added.truncated || removed.truncated || changed.truncated,
  };
};

export const normalizeDocumentChangeStructureDelta = (
  value?: Partial<DocumentChangeStructureDelta>
): DocumentChangeStructureDelta => {
  const headings = normalizeSet(value?.headings);
  const links = normalizeSet(value?.links);
  const typedEdges = normalizeSet(value?.typedEdges);
  const dates = normalizeDates(value?.dates);
  return {
    headings: headings.value,
    links: links.value,
    typedEdges: typedEdges.value,
    dates: dates.value,
    truncated:
      (value?.truncated ?? false) ||
      headings.truncated ||
      links.truncated ||
      typedEdges.truncated ||
      dates.truncated,
  };
};

export const encodeDocumentChangeCursor = (sequence: number): string => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError(
      "Document change cursor sequence must be non-negative"
    );
  }
  return `${CURSOR_PREFIX}${btoa(JSON.stringify({ sequence }))}`;
};

export const decodeDocumentChangeCursor = (cursor: string): number => {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new TypeError("Invalid document change cursor");
  }
  try {
    const parsed: unknown = JSON.parse(
      atob(cursor.slice(CURSOR_PREFIX.length))
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("sequence" in parsed) ||
      !Number.isSafeInteger(parsed.sequence) ||
      (parsed.sequence as number) < 0
    ) {
      throw new TypeError("Invalid document change cursor");
    }
    return parsed.sequence as number;
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw cause;
    }
    throw new TypeError("Invalid document change cursor", { cause });
  }
};

export const validateDocumentChangeRetentionPolicy = (
  policy: DocumentChangeRetentionPolicy,
  nowMs: number
): void => {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(policy.maxAgeDays) ||
    policy.maxAgeDays < 1 ||
    policy.maxAgeDays > 3650 ||
    !Number.isSafeInteger(policy.maxEntries) ||
    policy.maxEntries < 1 ||
    policy.maxEntries > 1_000_000 ||
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 1 ||
    policy.maxBytes > 1024 * 1024 * 1024
  ) {
    throw new RangeError("Invalid document change retention policy");
  }
};
