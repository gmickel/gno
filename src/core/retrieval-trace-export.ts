/** Aggregate retrieval trace export with manifest-bound verification. */

import type {
  RetrievalTraceBundle,
  RetrievalTraceExportFormat,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  ExportRetrievalTracesInput,
  ExportRetrievalTracesResult,
  RetrievalTraceArtifact,
} from "./retrieval-trace-management-types";

import { hashTraceCanonical } from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";
import { buildRetrievalQrelsArtifact } from "./retrieval-qrels";

const validateTraceIds = (traceIds: unknown): StoreResult<string[]> => {
  if (
    !Array.isArray(traceIds) ||
    traceIds.some(
      (traceId) => typeof traceId !== "string" || traceId.length < 1
    )
  ) {
    return err("INVALID_INPUT", "Export trace IDs must be a string array");
  }
  const normalized = [...new Set(traceIds)].sort((left, right) =>
    left.localeCompare(right)
  );
  return normalized.length < 1 || normalized.length > 10_000
    ? err("INVALID_INPUT", "Export requires from 1 to 10000 trace IDs")
    : ok(normalized);
};

const agenticArtifact = (
  bundles: RetrievalTraceBundle[]
): RetrievalTraceArtifact => ({
  schemaVersion: "1.0",
  format: "agentic-receipt",
  traces: bundles.map(({ exports: _exports, ...trace }) => trace),
});

const buildArtifact = (
  format: "agentic-receipt" | "qrels",
  bundles: RetrievalTraceBundle[]
): StoreResult<RetrievalTraceArtifact> => {
  if (format === "agentic-receipt") return ok(agenticArtifact(bundles));
  return buildRetrievalQrelsArtifact(bundles);
};

export const exportRetrievalTraces = async <
  Format extends RetrievalTraceExportFormat,
>(
  store: StorePort,
  clock: () => number,
  input: ExportRetrievalTracesInput<Format>
): Promise<StoreResult<ExportRetrievalTracesResult<Format>>> => {
  const format = input.format ?? "agentic-receipt";
  if (!["agentic-receipt", "qrels"].includes(format)) {
    return err("INVALID_INPUT", "Invalid retrieval trace export format");
  }
  const traceIds = validateTraceIds(input.traceIds);
  if (!traceIds.ok) return traceIds;
  const bundles: RetrievalTraceBundle[] = [];
  for (const traceId of traceIds.value) {
    const stored = await store.getRetrievalTrace(traceId);
    if (!stored.ok) return stored;
    if (!stored.value) return err("NOT_FOUND", "Retrieval trace not found");
    if (stored.value.trace.status === "open") {
      return err(
        "CONSTRAINT_VIOLATION",
        "Open retrieval traces cannot be exported"
      );
    }
    bundles.push(stored.value);
  }
  const built = buildArtifact(format, bundles);
  if (!built.ok) return built;
  const artifactHash = hashTraceCanonical(built.value);
  const exportId = `trace-export-${artifactHash.slice(0, 40)}`;
  const appended = await store.appendRetrievalTraceExportManifest({
    exportId,
    traceIds: traceIds.value,
    format,
    artifactHash,
    createdAtMs: clock(),
  });
  if (!appended.ok) return appended;
  const complete = await store.getRetrievalTraceExportBundle(exportId);
  if (!complete.ok) return complete;
  if (!complete.value) {
    return err("QUERY_FAILED", "Stored retrieval trace export is unavailable");
  }
  const reconstructed = buildArtifact(format, complete.value.traces);
  if (!reconstructed.ok) return reconstructed;
  if (
    complete.value.manifest.traceIds.join("\0") !== traceIds.value.join("\0") ||
    hashTraceCanonical(reconstructed.value) !==
      complete.value.manifest.artifactHash
  ) {
    return err(
      "CONSTRAINT_VIOLATION",
      "manifest_hash_mismatch: stored retrieval trace export changed"
    );
  }
  return ok({
    schemaVersion: "1.0",
    result: appended.value,
    manifest: complete.value.manifest,
    artifact: reconstructed.value,
  } as ExportRetrievalTracesResult<Format>);
};
