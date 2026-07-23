/** Shared local management service for private retrieval trace receipts. */

import type {
  RetrievalTraceBundle,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  DeleteRetrievalTraceResult,
  ExportRetrievalTracesInput,
  ExportRetrievalTracesResult,
  LabelRetrievalTraceInput,
  LabelRetrievalTraceResult,
  PurgeRetrievalTracesResult,
  RetrievalTraceDetail,
  RetrievalTraceDetailOptions,
  RetrievalTraceListOptions,
  RetrievalTraceListResult,
  RetrievalTraceSummary,
} from "./retrieval-trace-management-types";

import {
  canonicalTraceJson,
  hashTraceCanonical,
} from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";
import {
  allEvidence,
  applyTargetKind,
  compactTarget,
  decodeCursor,
  encodeCursor,
  type EvidenceTarget,
  latestForTarget,
  refMatches,
  summaryOf,
  targetKey,
} from "./retrieval-trace-management-helpers";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_DETAIL_LIMIT = 1000;
const MAX_DETAIL_LIMIT = 10_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOCID_PATTERN = /^#[a-f0-9]{6,}$/;

interface ManagementDeps {
  clock?: () => number;
}

export class RetrievalTraceManagementService {
  private readonly clock: () => number;

  constructor(
    private readonly store: StorePort,
    deps: ManagementDeps = {}
  ) {
    this.clock = deps.clock ?? Date.now;
  }

  async list(
    options: RetrievalTraceListOptions = {}
  ): Promise<StoreResult<RetrievalTraceListResult>> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      return err(
        "INVALID_INPUT",
        `Trace limit must be from 1 to ${MAX_LIST_LIMIT}`
      );
    }
    const cursor = decodeCursor(options.cursor);
    if (!cursor.ok) return cursor;
    const rows = await this.store.listRetrievalTraces(limit + 1, cursor.value);
    if (!rows.ok) return rows;
    const page = rows.value.slice(0, limit);
    const last = page.at(-1);
    return ok({
      schemaVersion: "1.0",
      traces: page.map(summaryOf),
      nextCursor:
        rows.value.length > limit && last
          ? encodeCursor({
              createdAtMs: last.createdAtMs,
              traceId: last.traceId,
            })
          : null,
    });
  }

  async show(
    traceId: string,
    options: RetrievalTraceDetailOptions = {}
  ): Promise<StoreResult<RetrievalTraceDetail>> {
    const limit = options.detailLimit ?? DEFAULT_DETAIL_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DETAIL_LIMIT) {
      return err(
        "INVALID_INPUT",
        `Trace detail limit must be from 1 to ${MAX_DETAIL_LIMIT}`
      );
    }
    const stored = await this.store.getBoundedRetrievalTrace(traceId, limit);
    if (!stored.ok) return stored;
    if (!stored.value) return err("NOT_FOUND", "Retrieval trace not found");
    const { trace, runs, events, judgments, exports } = stored.value.bundle;
    const totals = stored.value.totals;
    return ok({
      schemaVersion: "1.0",
      trace,
      runs: runs.slice(0, limit),
      events: events.slice(0, limit),
      judgments: judgments.slice(0, limit),
      exports: exports.slice(0, limit),
      totals,
      truncated: {
        runs: totals.runs > runs.length,
        events: totals.events > events.length,
        judgments: totals.judgments > judgments.length,
        exports: totals.exports > exports.length,
      },
    });
  }

  async label(
    input: LabelRetrievalTraceInput
  ): Promise<StoreResult<LabelRetrievalTraceResult>> {
    if (
      typeof input.traceId !== "string" ||
      typeof input.targetRef !== "string"
    ) {
      return err("INVALID_INPUT", "Invalid retrieval trace label");
    }
    const stored = await this.store.getRetrievalTrace(input.traceId);
    if (!stored.ok) return stored;
    if (!stored.value) return err("NOT_FOUND", "Retrieval trace not found");
    const resolved = await this.resolveLabelTarget(stored.value, input);
    if (!resolved.ok) return resolved;
    const { target, targetKind, runId } = resolved.value;
    const key = targetKey(targetKind, target);
    const latest = latestForTarget(stored.value.judgments, key);
    if (latest?.label === input.label) {
      return ok({
        schemaVersion: "1.0",
        result: "duplicate",
        judgment: latest,
      });
    }
    const now = Math.max(this.clock(), (latest?.createdAtMs ?? -1) + 1);
    if (!Number.isSafeInteger(now) || now < 0) {
      return err("INVALID_INPUT", "Trace clock must return epoch milliseconds");
    }
    const idempotencyKey =
      input.idempotencyKey ??
      `label:${hashTraceCanonical({
        traceId: input.traceId,
        key,
        label: input.label,
        supersedes: latest?.judgmentId ?? null,
      })}`;
    const judgmentId = `judgment-${hashTraceCanonical({
      traceId: input.traceId,
      idempotencyKey,
    }).slice(0, 40)}`;
    const targetRef = await this.redactTargetRef(
      stored.value.trace.redactionMode,
      input.targetRef
    );
    if (!targetRef.ok) return targetRef;
    const judgment = {
      judgmentId,
      traceId: input.traceId,
      runId,
      idempotencyKey,
      label: input.label,
      targetKind,
      targetRef: targetRef.value,
      target,
      createdAtMs: now,
    };
    const appended = await this.store.appendRetrievalTraceJudgment(judgment);
    if (!appended.ok) {
      if (appended.error.code !== "CONSTRAINT_VIOLATION") return appended;
      const concurrent = await this.store.getRetrievalTrace(input.traceId);
      if (!concurrent.ok) return concurrent;
      const settled = concurrent.value
        ? latestForTarget(concurrent.value.judgments, key)
        : undefined;
      if (
        settled?.label === input.label &&
        settled.idempotencyKey === idempotencyKey
      ) {
        return ok({
          schemaVersion: "1.0",
          result: "duplicate",
          judgment: settled,
        });
      }
      return appended;
    }
    const refreshed = await this.store.getRetrievalTrace(input.traceId);
    if (!refreshed.ok) return refreshed;
    const row = refreshed.value?.judgments.find(
      ({ judgmentId: id }) => id === judgmentId
    );
    return row
      ? ok({ schemaVersion: "1.0", result: appended.value, judgment: row })
      : err("QUERY_FAILED", "Stored retrieval trace judgment is unavailable");
  }

  async export(
    input: ExportRetrievalTracesInput
  ): Promise<StoreResult<ExportRetrievalTracesResult>> {
    if (input.format !== undefined && input.format !== "agentic-receipt") {
      return err("INVALID_INPUT", "Only agentic-receipt export is available");
    }
    if (
      !Array.isArray(input.traceIds) ||
      input.traceIds.some(
        (traceId) => typeof traceId !== "string" || traceId.length < 1
      )
    ) {
      return err("INVALID_INPUT", "Export trace IDs must be a string array");
    }
    const traceIds = [...new Set(input.traceIds)].sort();
    if (traceIds.length < 1 || traceIds.length > 10_000) {
      return err("INVALID_INPUT", "Export requires from 1 to 10000 trace IDs");
    }
    const traces: Array<Omit<RetrievalTraceBundle, "exports">> = [];
    for (const traceId of traceIds) {
      const stored = await this.store.getRetrievalTrace(traceId);
      if (!stored.ok) return stored;
      if (!stored.value) return err("NOT_FOUND", "Retrieval trace not found");
      if (stored.value.trace.status === "open") {
        return err(
          "CONSTRAINT_VIOLATION",
          "Open retrieval traces cannot be exported"
        );
      }
      const { exports: _exports, ...trace } = stored.value;
      traces.push(trace);
    }
    const artifact = {
      schemaVersion: "1.0" as const,
      format: "agentic-receipt" as const,
      traces,
    };
    const artifactHash = hashTraceCanonical(artifact);
    const exportId = `trace-export-${artifactHash.slice(0, 40)}`;
    const appended = await this.store.appendRetrievalTraceExportManifest({
      exportId,
      traceIds,
      format: "agentic-receipt",
      artifactHash,
      createdAtMs: this.clock(),
    });
    if (!appended.ok) return appended;
    const manifest = await this.store.getRetrievalTraceExportManifest(exportId);
    if (!manifest.ok) return manifest;
    if (!manifest.value) {
      return err(
        "QUERY_FAILED",
        "Stored retrieval trace export is unavailable"
      );
    }
    return ok({
      schemaVersion: "1.0",
      result: appended.value,
      manifest: manifest.value,
      artifact,
    });
  }

  async delete(
    traceId: string
  ): Promise<StoreResult<DeleteRetrievalTraceResult>> {
    const deleted = await this.store.deleteRetrievalTrace(traceId);
    if (!deleted.ok) return deleted;
    if (deleted.value.traces === 0) {
      return err("NOT_FOUND", "Retrieval trace not found");
    }
    return ok({
      schemaVersion: "1.0",
      traceId,
      deleted: true,
      counts: deleted.value,
    });
  }

  async purge(): Promise<StoreResult<PurgeRetrievalTracesResult>> {
    const purged = await this.store.purgeRetrievalTraces();
    return purged.ok ? ok({ schemaVersion: "1.0", ...purged.value }) : purged;
  }

  private async resolveLabelTarget(
    bundle: RetrievalTraceBundle,
    input: LabelRetrievalTraceInput
  ): Promise<
    StoreResult<{
      target: EvidenceTarget;
      targetKind: NonNullable<LabelRetrievalTraceInput["targetKind"]>;
      runId: string | null;
    }>
  > {
    if (
      typeof input.traceId !== "string" ||
      typeof input.targetRef !== "string" ||
      !["relevant", "irrelevant", "missing_expected"].includes(input.label) ||
      input.targetRef.length < 1 ||
      input.targetRef.length > 4096 ||
      (input.targetKind !== undefined &&
        !["document", "chunk", "span"].includes(input.targetKind)) ||
      (input.sourceHash !== undefined &&
        !SHA256_PATTERN.test(input.sourceHash)) ||
      (input.docid !== undefined && !DOCID_PATTERN.test(input.docid))
    ) {
      return err("INVALID_INPUT", "Invalid retrieval trace label");
    }
    if (input.label === "missing_expected") {
      return await this.resolveMissingExpected(bundle, input);
    }
    const match = allEvidence(bundle).find(({ target }) =>
      refMatches(target, input.targetRef)
    );
    if (!match) {
      return err(
        "INVALID_INPUT",
        "Relevant and irrelevant labels must reference recorded evidence"
      );
    }
    const target = applyTargetKind(match.target, input);
    if (!target.ok) return target;
    const targetKind =
      input.targetKind ??
      (input.startLine !== undefined
        ? "span"
        : target.value.seq !== undefined
          ? "chunk"
          : "document");
    return ok({ target: target.value, targetKind, runId: match.runId });
  }

  private async resolveMissingExpected(
    bundle: RetrievalTraceBundle,
    input: LabelRetrievalTraceInput
  ): Promise<
    StoreResult<{
      target: EvidenceTarget;
      targetKind: "document";
      runId: null;
    }>
  > {
    if (input.targetKind !== undefined && input.targetKind !== "document") {
      return err(
        "INVALID_INPUT",
        "missing_expected judgments must target a document"
      );
    }
    let document: Awaited<ReturnType<StorePort["getDocumentByUri"]>> | null =
      null;
    if (input.targetRef.startsWith("gno://")) {
      document = await this.store.getDocumentByUri(input.targetRef);
    } else if (DOCID_PATTERN.test(input.targetRef)) {
      document = await this.store.getDocumentByDocid(input.targetRef);
    } else if (!SHA256_PATTERN.test(input.targetRef)) {
      return err(
        "INVALID_INPUT",
        "Expected documents require a gno:// URI, docid, or source hash"
      );
    }
    if (document && !document.ok) return document;
    const row = document?.ok ? document.value : null;
    const target: EvidenceTarget = compactTarget(
      row
        ? {
            docid: row.docid,
            sourceHash: row.sourceHash,
            mirrorHash: row.mirrorHash ?? undefined,
            uri: row.uri,
          }
        : {
            docid:
              input.docid ??
              (DOCID_PATTERN.test(input.targetRef)
                ? input.targetRef
                : undefined),
            sourceHash:
              input.sourceHash ??
              (SHA256_PATTERN.test(input.targetRef)
                ? input.targetRef
                : undefined),
            uri: input.targetRef.startsWith("gno://")
              ? input.targetRef
              : undefined,
          }
    );
    if (!(target.uri || target.docid || target.sourceHash)) {
      return err("INVALID_INPUT", "Expected document identity is incomplete");
    }
    if (input.sourceHash && row && row.sourceHash !== input.sourceHash) {
      return err("INVALID_INPUT", "Expected document source hash mismatch");
    }
    if (input.docid && row && row.docid !== input.docid) {
      return err("INVALID_INPUT", "Expected document docid mismatch");
    }
    if (
      allEvidence(bundle).some(({ target: evidence }) =>
        [target.uri, target.docid, target.sourceHash]
          .filter(Boolean)
          .some((identity) => refMatches(evidence, identity!))
      )
    ) {
      return err(
        "CONSTRAINT_VIOLATION",
        "Expected document is already present in recorded evidence"
      );
    }
    return ok({ target, targetKind: "document", runId: null });
  }

  private async redactTargetRef(
    mode: RetrievalTraceBundle["trace"]["redactionMode"],
    targetRef: string
  ): Promise<StoreResult<string>> {
    if (mode === "replay") return ok(targetRef.normalize("NFC"));
    const secret = await this.store.getOrCreateRetrievalTraceRedactionSecret();
    if (!secret.ok) return secret;
    return ok(
      `redacted:${new Bun.CryptoHasher("sha256")
        .update(`${secret.value}\0${targetRef.normalize("NFC")}`)
        .digest("hex")}`
    );
  }
}

export type {
  DeleteRetrievalTraceResult,
  ExportRetrievalTracesInput,
  ExportRetrievalTracesResult,
  LabelRetrievalTraceInput,
  LabelRetrievalTraceResult,
  PurgeRetrievalTracesResult,
  RetrievalTraceDetail,
  RetrievalTraceDetailOptions,
  RetrievalTraceListOptions,
  RetrievalTraceListRequest,
  RetrievalTraceListResult,
  RetrievalTraceLabelRequest,
  RetrievalTraceLabelResult,
  RetrievalTraceExportRequest,
  RetrievalTraceExportResult,
  RetrievalTraceDeleteResult,
  RetrievalTracePurgeResult,
  RetrievalTraceSummary,
} from "./retrieval-trace-management-types";

export const serializeRetrievalTraceArtifact = (
  result: ExportRetrievalTracesResult
): string => canonicalTraceJson(result.artifact);
