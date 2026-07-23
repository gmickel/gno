/**
 * Shared read services for retained knowledge changes, structural diffs, and
 * bounded inbound dependency impact.
 */

import type {
  DocumentChangeRow,
  DocumentChangeStructureDelta,
  DocumentRow,
  StorePort,
} from "../store/types";

import {
  decodeDocumentChangeCursor,
  encodeDocumentChangeCursor,
} from "./change-journal";
import { resolveDocRef } from "./ref-parser";

const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 1000;
const MAX_DIFF_SCAN_PAGES = 10;
const DIFF_SCAN_PAGE_SIZE = 1000;

export interface KnowledgeChangeSnapshot {
  relPath: string;
  docid: string;
  uri: string;
  sourceHash: string;
  mirrorHash: string | null;
  active: boolean;
}

export interface KnowledgeChange {
  id: string;
  kind: DocumentChangeRow["kind"];
  collection: string;
  observedAt: string;
  previous: KnowledgeChangeSnapshot | null;
  current: KnowledgeChangeSnapshot | null;
  structureDelta: DocumentChangeStructureDelta;
}

export interface KnowledgeChangesResult {
  schemaVersion: "1.0";
  changes: KnowledgeChange[];
  page: {
    nextCursor: string | null;
    earliestCursor: string;
    latestCursor: string;
    cursorExpired: boolean;
    truncated: boolean;
    retentionTruncated: boolean;
  };
  warnings: string[];
}

export interface ListKnowledgeChangesInput {
  since?: string;
  collection?: string;
  limit?: number;
}

export interface KnowledgeDocument {
  id: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  active?: boolean;
}

export interface KnowledgeDiffResult {
  schemaVersion: "1.0";
  status: "available" | "expired" | "unavailable";
  document: KnowledgeDocument & { active: boolean };
  change: KnowledgeChange | null;
  content: {
    status: "not_retained";
    reason: "journal_metadata_only";
  };
  history: {
    status: "available" | "partial" | "unavailable";
    reason:
      | null
      | "structure_delta_truncated"
      | "change_expired"
      | "no_retained_change"
      | "change_not_found";
  };
  warnings: string[];
}

export type KnowledgeDeltaServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; isValidation?: boolean };

const snapshot = (
  row: DocumentChangeRow,
  side: "old" | "new"
): KnowledgeChangeSnapshot | null => {
  const prefix = side === "old" ? "old" : "new";
  const relPath = row[`${prefix}RelPath`];
  const docid = row[`${prefix}Docid`];
  const uri = row[`${prefix}Uri`];
  const sourceHash = row[`${prefix}SourceHash`];
  const active = row[`${prefix}Active`];
  if (
    relPath === null ||
    docid === null ||
    uri === null ||
    sourceHash === null ||
    active === null
  ) {
    return null;
  }
  return {
    relPath,
    docid,
    uri,
    sourceHash,
    mirrorHash: row[`${prefix}MirrorHash`],
    active,
  };
};

export const projectKnowledgeChange = (
  row: DocumentChangeRow
): KnowledgeChange => ({
  id: encodeDocumentChangeCursor(row.sequence),
  kind: row.kind,
  collection: row.collection,
  observedAt: new Date(row.observedAtMs).toISOString(),
  previous: snapshot(row, "old"),
  current: snapshot(row, "new"),
  structureDelta: row.structureDelta,
});

const parseSince = (
  since: string | undefined
): { cursor?: string; observedAfterMs?: number } | { error: string } => {
  if (since === undefined) return {};
  const trimmed = since.trim();
  if (!trimmed) return { error: "since cannot be empty" };
  try {
    decodeDocumentChangeCursor(trimmed);
    return { cursor: trimmed };
  } catch {
    const observedAfterMs = Date.parse(trimmed);
    return Number.isFinite(observedAfterMs)
      ? { observedAfterMs }
      : { error: "since must be an ISO-8601 time or opaque change cursor" };
  }
};

export async function listKnowledgeChanges(
  store: StorePort,
  input: ListKnowledgeChangesInput = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeChangesResult>> {
  if ((input.since?.length ?? 0) > 512) {
    return {
      success: false,
      error: "since must be at most 512 characters",
      isValidation: true,
    };
  }
  if ((input.collection?.length ?? 0) > 256) {
    return {
      success: false,
      error: "collection must be at most 256 characters",
      isValidation: true,
    };
  }
  const limit = input.limit ?? DEFAULT_CHANGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
    return {
      success: false,
      error: `limit must be between 1 and ${MAX_CHANGE_LIMIT}`,
      isValidation: true,
    };
  }
  const since = parseSince(input.since);
  if ("error" in since) {
    return { success: false, error: since.error, isValidation: true };
  }
  const listed = await store.listDocumentChanges({
    ...since,
    collection: input.collection,
    limit,
  });
  if (!listed.ok) {
    return {
      success: false,
      error: listed.error.message,
      isValidation: listed.error.code === "INVALID_INPUT",
    };
  }
  const retentionTruncated =
    decodeDocumentChangeCursor(listed.value.earliestCursor) > 0;
  const warnings: string[] = [];
  if (listed.value.cursorExpired) {
    warnings.push(
      `Requested cursor expired; resume from ${listed.value.earliestCursor}`
    );
  } else if (retentionTruncated && !since.cursor) {
    warnings.push("Earlier journal history was removed by retention");
  }
  return {
    success: true,
    data: {
      schemaVersion: "1.0",
      changes: listed.value.changes.map(projectKnowledgeChange),
      page: {
        nextCursor: listed.value.nextCursor,
        earliestCursor: listed.value.earliestCursor,
        latestCursor: listed.value.latestCursor,
        cursorExpired: listed.value.cursorExpired,
        truncated: listed.value.truncated,
        retentionTruncated,
      },
      warnings,
    },
  };
}

const document = (
  row: DocumentRow
): KnowledgeDocument & { active: boolean } => ({
  id: row.docid,
  uri: row.uri,
  title: row.title,
  collection: row.collection,
  relPath: row.relPath,
  active: row.active,
});

async function latestRetainedChange(
  store: StorePort,
  documentId: number
): Promise<
  | { ok: true; row: DocumentChangeRow | null; retentionTruncated: boolean }
  | { ok: false; error: string }
> {
  let cursor: string | undefined;
  let latest: DocumentChangeRow | null = null;
  let retentionTruncated = false;
  for (let pageIndex = 0; pageIndex < MAX_DIFF_SCAN_PAGES; pageIndex += 1) {
    const page = await store.listDocumentChanges({
      cursor,
      documentId,
      limit: DIFF_SCAN_PAGE_SIZE,
    });
    if (!page.ok) return { ok: false, error: page.error.message };
    retentionTruncated =
      decodeDocumentChangeCursor(page.value.earliestCursor) > 0;
    latest = page.value.changes.at(-1) ?? latest;
    if (!page.value.nextCursor) {
      return { ok: true, row: latest, retentionTruncated };
    }
    cursor = page.value.nextCursor;
  }
  return { ok: false, error: "Retained change scan exceeded its bound" };
}

async function exactRetainedChange(
  store: StorePort,
  documentId: number,
  changeId: string
): Promise<
  | { ok: true; row: DocumentChangeRow | null; expired: boolean }
  | { ok: false; error: string; isValidation?: boolean }
> {
  let sequence: number;
  try {
    sequence = decodeDocumentChangeCursor(changeId);
  } catch {
    return { ok: false, error: "Invalid change id", isValidation: true };
  }
  if (sequence < 1) {
    return { ok: false, error: "Invalid change id", isValidation: true };
  }
  const page = await store.listDocumentChanges({
    cursor: encodeDocumentChangeCursor(sequence - 1),
    documentId,
    limit: 1,
  });
  if (!page.ok) {
    return {
      ok: false,
      error: page.error.message,
      isValidation: page.error.code === "INVALID_INPUT",
    };
  }
  const row = page.value.changes[0] ?? null;
  return {
    ok: true,
    row: row?.sequence === sequence ? row : null,
    expired: page.value.cursorExpired,
  };
}

export async function getKnowledgeDiff(
  store: StorePort,
  ref: string,
  changeId?: string
): Promise<KnowledgeDeltaServiceResult<KnowledgeDiffResult>> {
  if (!ref.trim() || ref.length > 4096) {
    return {
      success: false,
      error: "ref must be between 1 and 4096 characters",
      isValidation: true,
    };
  }
  if ((changeId?.length ?? 0) > 512) {
    return {
      success: false,
      error: "changeId must be at most 512 characters",
      isValidation: true,
    };
  }
  const resolved = await resolveDocRef(store, ref);
  if ("error" in resolved) {
    return {
      success: false,
      error: resolved.error,
      isValidation: resolved.isValidation,
    };
  }
  let row: DocumentChangeRow | null;
  let status: KnowledgeDiffResult["status"];
  let history: KnowledgeDiffResult["history"];
  const warnings = ["Source bodies are not retained in the change journal"];
  if (changeId) {
    const exact = await exactRetainedChange(store, resolved.doc.id, changeId);
    if (!exact.ok) return { success: false, ...exact };
    row = exact.row;
    status = exact.expired ? "expired" : row ? "available" : "unavailable";
    history = exact.expired
      ? { status: "unavailable", reason: "change_expired" }
      : row
        ? row.structureDelta.truncated
          ? { status: "partial", reason: "structure_delta_truncated" }
          : { status: "available", reason: null }
        : { status: "unavailable", reason: "change_not_found" };
  } else {
    const latest = await latestRetainedChange(store, resolved.doc.id);
    if (!latest.ok) {
      return { success: false, error: latest.error };
    }
    row = latest.row;
    status = row ? "available" : "unavailable";
    history = row
      ? row.structureDelta.truncated
        ? { status: "partial", reason: "structure_delta_truncated" }
        : { status: "available", reason: null }
      : { status: "unavailable", reason: "no_retained_change" };
    if (latest.retentionTruncated) {
      warnings.push("Earlier journal history was removed by retention");
    }
  }
  return {
    success: true,
    data: {
      schemaVersion: "1.0",
      status,
      document: document(resolved.doc),
      change: row ? projectKnowledgeChange(row) : null,
      content: {
        status: "not_retained",
        reason: "journal_metadata_only",
      },
      history,
      warnings,
    },
  };
}

export { analyzeKnowledgeImpact } from "./knowledge-impact";
export type {
  KnowledgeImpactEvidenceStep,
  KnowledgeImpactInput,
  KnowledgeImpactResult,
} from "./knowledge-impact";
