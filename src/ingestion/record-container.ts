import type { NormalizedContentTypeRule } from "../config";
import type { Collection } from "../config/types";
import type { RecordAdapter, RecordMetadata } from "../converters/types";
import type {
  ChunkInput,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  ChunkerPort,
  FileSyncResult,
  RecordImportItemReceipt,
  SyncOptions,
  WalkEntry,
} from "./types";

import { resolveConfiguredEgressPolicy } from "../config/types";
import { DEFAULT_RECORD_ADAPTER_LIMITS } from "../converters/types";
import {
  diffDocumentStructure,
  extractDocumentStructure,
} from "../core/change-diff";
import { createEgressLineage } from "../core/egress-provenance";
import { normalizeTag, validateTag } from "../core/tags";
import { runRecordAdapter } from "./record-adapter";
import { recordVirtualPath } from "./record-path";
import { reconcileRecordSnapshot, type RecordSyncPlan } from "./record-sync";
import { DEFAULT_CHUNK_PARAMS, MAX_RECORD_IMPORT_RECEIPT_ITEMS } from "./types";

interface RecordDocumentMetadata {
  contentType?: string;
  contentTypeSource: "frontmatter-type" | "prefix" | "path-ext" | "fallback";
  categories?: string[];
  author?: string;
  frontmatterDate?: string;
  dateFields?: Record<string, string>;
}

interface RecordContainerInput {
  adapter: RecordAdapter;
  chunker: ChunkerPort;
  collection: Collection;
  contentTypeRules: NormalizedContentTypeRule[];
  contentTypeRulesFingerprint: string;
  entry: WalkEntry;
  ext: string;
  extractMetadata: (
    markdown: string,
    relPath: string,
    ext: string,
    rules: NormalizedContentTypeRule[]
  ) => RecordDocumentMetadata;
  ingestVersion: number;
  mime: string;
  options: SyncOptions;
  sourceCtime: string;
  sourceMtime: string;
  sourceSize: number;
  store: StorePort;
  /**
   * Optional pre-read source bytes from the guarded content boundary.
   * When set, record import streams from this buffer and never reopens the path.
   */
  sourceBytes?: Uint8Array;
}

interface AppliedRecordReconciliation {
  changed: boolean;
  hadSourceDocument: boolean;
  plan: RecordSyncPlan;
  priorByKey: Map<string, DocumentRow>;
  priorDocumentCount: number;
}

const mustOk = <T>(result: StoreResult<T>, operation: string): T => {
  if (result.ok) return result.value;
  throw new Error(
    `Store operation failed: ${operation} - ${result.error.message}`
  );
};

const normalizedDateFields = (
  metadata: RecordMetadata | undefined
): Record<string, string> | undefined => {
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(metadata?.dateFields ?? {})) {
    const normalized = normalizeRecordDate(raw);
    if (normalized) fields[key] = normalized;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FLOATING_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/;
const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const TZID_DATE_TIME_PATTERN =
  /^TZID=([^:]{1,128}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})$/;

const timeZoneParts = (
  epochMs: number,
  timeZone: string
): [number, number, number, number, number, number] | undefined => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(epochMs));
    const values = new Map(
      parts.map((part) => [part.type, Number(part.value)])
    );
    const tuple = [
      values.get("year"),
      values.get("month"),
      values.get("day"),
      values.get("hour"),
      values.get("minute"),
      values.get("second"),
    ];
    if (tuple.some((value) => !Number.isInteger(value))) return undefined;
    return tuple as [number, number, number, number, number, number];
  } catch {
    return undefined;
  }
};

const zonedDateTimeToIso = (
  timeZone: string,
  localDateTime: string
): string | undefined => {
  const match = FLOATING_DATE_TIME_PATTERN.exec(localDateTime);
  if (!match) return undefined;
  const desired = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const desiredMs = Date.UTC(
    desired[0],
    desired[1] - 1,
    desired[2],
    desired[3],
    desired[4],
    desired[5]
  );
  let candidateMs = desiredMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projected = timeZoneParts(candidateMs, timeZone);
    if (!projected) return undefined;
    const projectedMs = Date.UTC(
      projected[0],
      projected[1] - 1,
      projected[2],
      projected[3],
      projected[4],
      projected[5]
    );
    candidateMs += desiredMs - projectedMs;
  }
  const verified = timeZoneParts(candidateMs, timeZone);
  if (!verified || verified.some((value, index) => value !== desired[index])) {
    return undefined;
  }
  return new Date(candidateMs).toISOString();
};

const isValidDateOnly = (raw: string): boolean => {
  if (!DATE_ONLY_PATTERN.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(raw)
  );
};

const isValidFloatingDateTime = (raw: string): boolean => {
  const match = FLOATING_DATE_TIME_PATTERN.exec(raw);
  if (!match) return false;
  const parsed = new Date(`${raw}Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const values = match.slice(1, 7).map(Number);
  return (
    parsed.getUTCFullYear() === values[0] &&
    parsed.getUTCMonth() + 1 === values[1] &&
    parsed.getUTCDate() === values[2] &&
    parsed.getUTCHours() === values[3] &&
    parsed.getUTCMinutes() === values[4] &&
    parsed.getUTCSeconds() === values[5]
  );
};

export const normalizeRecordDate = (raw: string): string | undefined => {
  if (isValidDateOnly(raw)) return raw;
  if (isValidFloatingDateTime(raw)) return raw;
  const zoned = TZID_DATE_TIME_PATTERN.exec(raw);
  if (zoned?.[1] && zoned[2]) {
    return zonedDateTimeToIso(zoned[1], zoned[2]);
  }
  if (!OFFSET_DATE_TIME_PATTERN.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const primaryDate = (
  fields: Record<string, string> | undefined
): string | undefined => {
  if (!fields) return undefined;
  const priorities = [
    "date",
    "start",
    "sentAt",
    "created",
    "addedAt",
    "visitedAt",
    "updated",
    "end",
  ];
  for (const key of priorities) {
    if (fields[key]) return fields[key];
  }
  return Object.entries(fields).sort(([left], [right]) =>
    left.localeCompare(right)
  )[0]?.[1];
};

const recordContentType = (
  adapterId: string,
  fallback: string | undefined
): string | undefined => {
  if (adapterId.includes("email")) return "email";
  if (adapterId.includes("ical")) return "event";
  if (adapterId.includes("transcript")) return "transcript";
  if (adapterId.includes("browser")) return "browser-export";
  if (adapterId.includes("jsonl")) return "record";
  return fallback;
};

const normalizedCategories = (
  metadataCategories: readonly string[] | undefined,
  inferredCategories: readonly string[] | undefined,
  contentType: string | undefined
): string[] => {
  const values = [
    ...(metadataCategories ?? []),
    ...(inferredCategories ?? []),
    ...(contentType ? [contentType] : []),
  ];
  const categories = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTag(value);
    if (validateTag(normalized)) categories.add(normalized);
  }
  return [...categories].sort();
};

const sourceStream = (
  path: string,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const reader = Bun.file(path).stream().getReader();
    const abort = (): void => {
      void reader.cancel("record adapter aborted");
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  },
});

const bytesStream = (
  bytes: Uint8Array,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (signal?.aborted) {
      throw new Error("record adapter aborted");
    }
    if (bytes.byteLength > 0) {
      yield bytes;
    }
  },
});

const loadPreviousStructure = async (
  store: StorePort,
  existing: DocumentRow | undefined
): Promise<ReturnType<typeof extractDocumentStructure> | null | undefined> => {
  if (!existing) return null;
  if (!existing.mirrorHash) return undefined;
  const content = mustOk(
    await store.getContent(existing.mirrorHash),
    "getContent"
  );
  if (content === null) return undefined;
  return extractDocumentStructure(
    content,
    existing.relPath,
    existing.dateFields
  );
};

const persistRecord = async (
  input: RecordContainerInput,
  record: Awaited<ReturnType<typeof runRecordAdapter>>["records"][number],
  existing: DocumentRow | undefined,
  wrapInTransaction = true,
  rebuildEvidence = true
): Promise<void> => {
  const virtualPath = recordVirtualPath(input.entry.relPath, record.recordKey);
  const inferred = input.extractMetadata(
    record.markdown,
    virtualPath,
    ".md",
    input.contentTypeRules
  );
  const dateFields =
    normalizedDateFields(record.metadata) ?? inferred.dateFields;
  const contentType = recordContentType(record.adapterId, inferred.contentType);
  const categories = normalizedCategories(
    record.metadata?.categories,
    inferred.categories,
    contentType
  );
  const previousStructure = await loadPreviousStructure(input.store, existing);
  const nextStructure = extractDocumentStructure(
    record.markdown,
    virtualPath,
    dateFields
  );
  const structureDelta = diffDocumentStructure(
    previousStructure,
    nextStructure
  ).delta;

  const persist = async (): Promise<void> => {
    const document = mustOk(
      await input.store.upsertDocument({
        collection: input.collection.name,
        relPath: virtualPath,
        sourceHash: record.sourceHash,
        sourceMime: input.mime,
        sourceExt: input.ext,
        sourceSize: input.sourceSize,
        sourceMtime: input.sourceMtime,
        sourceCtime: input.sourceCtime,
        title: record.title,
        mirrorHash: record.mirrorHash,
        converterId: record.adapterId,
        converterVersion: record.adapterVersion,
        languageHint: record.languageHint ?? input.collection.languageHint,
        contentType,
        contentTypeSource: inferred.contentTypeSource,
        categories,
        author: record.metadata?.author ?? inferred.author,
        frontmatterDate: primaryDate(dateFields) ?? inferred.frontmatterDate,
        dateFields,
        recordKey: record.recordKey,
        recordSourcePath: input.entry.relPath,
        recordSourceLocator: record.sourceLocator,
        recordMetadata: record.metadata,
        recordAnchors: record.anchors,
        recordAdapterFingerprint: record.adapterFingerprint,
        contentTypeRulesFingerprint: input.contentTypeRulesFingerprint,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        ingestVersion: input.ingestVersion,
        changeJournal: { structureDelta },
      }),
      "upsertDocument"
    );
    if (!rebuildEvidence) return;
    mustOk(
      await input.store.upsertContent(record.mirrorHash, record.markdown),
      "upsertContent"
    );
    const chunks: ChunkInput[] = input.chunker
      .chunk(
        record.markdown,
        DEFAULT_CHUNK_PARAMS,
        record.languageHint ?? input.collection.languageHint,
        virtualPath
      )
      .map((chunk) => ({
        seq: chunk.seq,
        pos: chunk.pos,
        text: chunk.text,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        language: chunk.language ?? undefined,
        tokenCount: chunk.tokenCount ?? undefined,
      }));
    mustOk(
      await input.store.upsertChunks(record.mirrorHash, chunks),
      "upsertChunks"
    );
    mustOk(
      await input.store.rebuildFtsForHash(record.mirrorHash),
      "rebuildFtsForHash"
    );
    mustOk(
      await input.store.setDocTags(document.id, categories, "frontmatter"),
      "setDocTags"
    );
    mustOk(
      await input.store.setDocLinks(document.id, [], "parsed"),
      "setDocLinks"
    );
  };

  if (!(wrapInTransaction && input.store.withTransaction)) return persist();
  mustOk(await input.store.withTransaction(persist), "persistRecord");
};

const sameJsonValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const recordProvenanceChanged = (
  input: RecordContainerInput,
  record: Awaited<ReturnType<typeof runRecordAdapter>>["records"][number],
  existing: DocumentRow
): boolean =>
  existing.sourceMime !== input.mime ||
  existing.sourceExt !== input.ext ||
  existing.sourceSize !== input.sourceSize ||
  existing.sourceMtime !== input.sourceMtime ||
  existing.sourceCtime !== input.sourceCtime ||
  existing.recordSourcePath !== input.entry.relPath ||
  existing.recordSourceLocator !== record.sourceLocator ||
  !sameJsonValue(existing.recordAnchors, record.anchors);

/** Stream, reconcile, and persist one export container as virtual documents. */
export async function processRecordContainer(
  input: RecordContainerInput
): Promise<FileSyncResult> {
  const effectiveEgress = resolveConfiguredEgressPolicy(input.collection);
  const snapshot = await runRecordAdapter(
    input.adapter,
    {
      sourcePath: input.entry.absPath,
      relativePath: input.entry.relPath,
      collection: input.collection.name,
      mime: input.mime,
      ext: input.ext,
      open: (signal) =>
        input.sourceBytes
          ? bytesStream(input.sourceBytes, signal)
          : sourceStream(input.entry.absPath, signal),
      limits: {
        ...DEFAULT_RECORD_ADAPTER_LIMITS,
        timeoutMs: Math.min(
          DEFAULT_RECORD_ADAPTER_LIMITS.timeoutMs ?? 60_000,
          input.options.limits?.timeoutMs ?? Number.POSITIVE_INFINITY
        ),
        maxSourceBytes: Math.min(
          DEFAULT_RECORD_ADAPTER_LIMITS.maxSourceBytes,
          input.options.limits?.maxBytes ?? Number.POSITIVE_INFINITY
        ),
        maxTotalChars: Math.min(
          DEFAULT_RECORD_ADAPTER_LIMITS.maxTotalChars,
          input.options.limits?.maxOutputChars ?? Number.POSITIVE_INFINITY
        ),
      },
    },
    {
      egressLineage: createEgressLineage([
        {
          collection: input.collection.name,
          policy: effectiveEgress.policy,
          source: effectiveEgress.source,
        },
      ]),
    }
  );

  const reconcileAndApply = async (): Promise<AppliedRecordReconciliation> => {
    const priorDocuments = mustOk(
      await input.store.listRecordDocuments(
        input.collection.name,
        input.entry.relPath
      ),
      "listRecordDocuments"
    );
    const sourceDocument = mustOk(
      await input.store.getDocument(input.collection.name, input.entry.relPath),
      "getDocument"
    );
    const priorByKey = new Map(
      priorDocuments
        .filter((document) => document.recordKey)
        .map((document) => [document.recordKey as string, document])
    );
    const plan = reconcileRecordSnapshot(
      priorDocuments
        .filter((document) => document.recordKey)
        .map((document) => ({
          recordKey: document.recordKey as string,
          sourceHash: document.sourceHash,
          adapterVersion: document.converterVersion ?? "",
          adapterFingerprint: document.recordAdapterFingerprint ?? "",
          active: document.active,
          relativePath: document.relPath,
        })),
      snapshot
    );

    let changed = false;
    for (const action of plan.actions) {
      if (
        action.type === "add" ||
        action.type === "update" ||
        action.type === "reactivate"
      ) {
        await persistRecord(
          input,
          action.record,
          priorByKey.get(action.record.recordKey),
          false
        );
        changed = true;
        continue;
      }
      if (action.type === "unchanged" && action.record) {
        const existing = priorByKey.get(action.record.recordKey);
        const projectionChanged =
          existing?.ingestVersion !== input.ingestVersion ||
          existing.contentTypeRulesFingerprint !==
            input.contentTypeRulesFingerprint;
        if (projectionChanged) {
          await persistRecord(input, action.record, existing, false);
          changed = true;
        } else if (
          existing &&
          recordProvenanceChanged(input, action.record, existing)
        ) {
          await persistRecord(input, action.record, existing, false, false);
          changed = true;
        }
        continue;
      }
      if (action.type === "deactivate") {
        const result = mustOk(
          await input.store.markInactive(input.collection.name, [
            action.previous.relativePath,
          ]),
          "markInactive"
        );
        changed ||= result > 0;
      }
    }

    if (sourceDocument?.active && snapshot.authoritative) {
      const result = mustOk(
        await input.store.markInactive(input.collection.name, [
          input.entry.relPath,
        ]),
        "markInactive"
      );
      changed ||= result > 0;
    }
    return {
      changed,
      hadSourceDocument: sourceDocument !== null,
      plan,
      priorByKey,
      priorDocumentCount: priorDocuments.length,
    };
  };
  const applied = input.store.withTransaction
    ? mustOk(
        await input.store.withTransaction(reconcileAndApply),
        "reconcileRecordSnapshot"
      )
    : await reconcileAndApply();
  const actionCount = (
    type: (typeof applied.plan.actions)[number]["type"]
  ): number =>
    applied.plan.actions.filter((action) => action.type === type).length;
  const receiptItems = applied.plan.actions
    .map((action): RecordImportItemReceipt => {
      const record = "record" in action ? action.record : undefined;
      const previous =
        "previous" in action
          ? applied.priorByKey.get(action.previous.recordKey)
          : undefined;
      const recordKey =
        record?.recordKey ??
        ("previous" in action ? action.previous.recordKey : "");
      return {
        outcome:
          action.type === "add"
            ? "added"
            : action.type === "update"
              ? "updated"
              : action.type === "reactivate"
                ? "reactivated"
                : action.type === "deactivate"
                  ? "deactivated"
                  : action.type === "preserve"
                    ? "preserved"
                    : action.type,
        recordKey,
        sourceLocator:
          record?.sourceLocator ??
          previous?.recordSourceLocator ??
          `record:${recordKey}`,
        sourceHash: record?.sourceHash ?? previous?.sourceHash ?? "",
        ...(record?.mirrorHash || previous?.mirrorHash
          ? { mirrorHash: record?.mirrorHash ?? previous?.mirrorHash ?? "" }
          : {}),
        adapterFingerprint:
          record?.adapterFingerprint ??
          previous?.recordAdapterFingerprint ??
          snapshot.adapterFingerprint,
        attachments: (
          record?.metadata?.attachments ??
          previous?.recordMetadata?.attachments ??
          []
        ).map((attachment) => ({ ...attachment })),
      };
    })
    .sort(
      (left, right) =>
        left.recordKey.localeCompare(right.recordKey) ||
        left.outcome.localeCompare(right.outcome)
    );
  const boundedReceiptItems = receiptItems.slice(
    0,
    MAX_RECORD_IMPORT_RECEIPT_ITEMS
  );
  const recordImport: NonNullable<FileSyncResult["recordImport"]> = {
    adapterId: snapshot.adapterId,
    adapterVersion: snapshot.adapterVersion,
    adapterFingerprint: snapshot.adapterFingerprint,
    egressLineage: snapshot.egressLineage,
    snapshotState: snapshot.snapshotState,
    authoritative: snapshot.authoritative,
    stoppedByCap: snapshot.stoppedByCap,
    sourceBytesRead: snapshot.sourceBytesRead,
    records: {
      accepted: snapshot.records.length,
      added: actionCount("add"),
      updated: actionCount("update"),
      reactivated: actionCount("reactivate"),
      unchanged: actionCount("unchanged"),
      deactivated: actionCount("deactivate"),
      preserved: actionCount("preserve"),
      failed: snapshot.failures.length,
    },
    items: boundedReceiptItems,
    itemsTruncated: receiptItems.length - boundedReceiptItems.length,
    warnings:
      snapshot.snapshotState === "partial" && snapshot.failures.length === 0
        ? [
            {
              code: "PARTIAL_SNAPSHOT",
              message:
                "Adapter reported a partial snapshot; unseen records were preserved.",
              retryable: true,
            },
          ]
        : [],
    failures: snapshot.failures,
  };

  for (const failure of snapshot.failures) {
    await input.store.recordError({
      collection: input.collection.name,
      relPath: input.entry.relPath,
      code: failure.code,
      message: failure.message,
      details: {
        retryable: failure.retryable,
        ...(failure.sourceLocator
          ? { sourceLocator: failure.sourceLocator }
          : {}),
        ...(failure.stableId ? { stableId: failure.stableId } : {}),
      },
    });
  }

  if (snapshot.records.length === 0 && snapshot.failures.length > 0) {
    return {
      relPath: input.entry.relPath,
      status: "error",
      errorCode: snapshot.failures[0]?.code ?? "ADAPTER_FAILURE",
      errorMessage:
        snapshot.failures[0]?.message ?? "Export conversion failed.",
      recordImport,
    };
  }
  if (!applied.changed)
    return {
      relPath: input.entry.relPath,
      status: "unchanged",
      recordImport,
    };
  return {
    relPath: input.entry.relPath,
    status:
      applied.priorDocumentCount > 0 || applied.hadSourceDocument
        ? "updated"
        : "added",
    recordImport,
  };
}
