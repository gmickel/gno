import type {
  ActivationStageReceipt,
  ActivationVerificationReceipt,
} from "./types";

const ACTIVATION_RECEIPT_MAX_BYTES = 16_384;
const ACTIVATION_STAGE_STATUSES = new Set([
  "passed",
  "pending",
  "failed",
  "skipped",
]);
const ACTIVATION_CODES = new Set([
  "no_documents",
  "no_probe_term",
  "index_query_failed",
  "retrieval_mismatch",
  "semantic_not_checked",
  "connector_not_requested",
]);

function projectStage(stage: ActivationStageReceipt): ActivationStageReceipt {
  return {
    status: stage.status,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
    latencyMs: stage.latencyMs,
    ...(stage.code ? { code: stage.code } : {}),
  };
}

function projectReceipt(
  receipt: ActivationVerificationReceipt
): ActivationVerificationReceipt {
  return {
    schemaVersion: "1.0",
    collection: receipt.collection,
    fingerprint: receipt.fingerprint,
    ready: receipt.ready,
    generatedAt: receipt.generatedAt,
    stages: {
      index: projectStage(receipt.stages.index),
      lexical: projectStage(receipt.stages.lexical),
      semantic: projectStage(receipt.stages.semantic),
      connector: projectStage(receipt.stages.connector),
    },
    evidence: {
      ...(receipt.evidence.probeHash
        ? { probeHash: receipt.evidence.probeHash }
        : {}),
      ...(receipt.evidence.resultUri
        ? { resultUri: receipt.evidence.resultUri }
        : {}),
      ...(receipt.evidence.resultSourceHash
        ? { resultSourceHash: receipt.evidence.resultSourceHash }
        : {}),
      ...(receipt.evidence.connectorTarget
        ? { connectorTarget: receipt.evidence.connectorTarget }
        : {}),
    },
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStage(value: unknown): value is ActivationStageReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stage = value as Record<string, unknown>;
  return (
    typeof stage.status === "string" &&
    ACTIVATION_STAGE_STATUSES.has(stage.status) &&
    isNullableString(stage.startedAt) &&
    isNullableString(stage.completedAt) &&
    (stage.latencyMs === null ||
      (typeof stage.latencyMs === "number" && stage.latencyMs >= 0)) &&
    (stage.code === undefined ||
      (typeof stage.code === "string" && ACTIVATION_CODES.has(stage.code)))
  );
}

export function parseActivationReceipt(
  raw: string
): ActivationVerificationReceipt | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const stages = parsed.stages as Record<string, unknown> | undefined;
    const evidence = parsed.evidence as Record<string, unknown> | undefined;
    if (
      parsed.schemaVersion !== "1.0" ||
      typeof parsed.collection !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.ready !== "boolean" ||
      typeof parsed.generatedAt !== "string" ||
      !stages ||
      !isStage(stages.index) ||
      !isStage(stages.lexical) ||
      !isStage(stages.semantic) ||
      !isStage(stages.connector) ||
      !evidence
    ) {
      return null;
    }
    for (const key of [
      "probeHash",
      "resultUri",
      "resultSourceHash",
      "connectorTarget",
    ]) {
      if (evidence[key] !== undefined && typeof evidence[key] !== "string") {
        return null;
      }
    }
    return projectReceipt(parsed as unknown as ActivationVerificationReceipt);
  } catch {
    return null;
  }
}

export function serializeActivationReceipt(
  receipt: ActivationVerificationReceipt
):
  | {
      ok: true;
      json: string;
      projected: ActivationVerificationReceipt;
      connectorTarget: string;
    }
  | { ok: false } {
  const projected = projectReceipt(receipt);
  const json = JSON.stringify(projected);
  if (
    new TextEncoder().encode(json).byteLength > ACTIVATION_RECEIPT_MAX_BYTES
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    json,
    projected,
    connectorTarget: projected.evidence.connectorTarget ?? "",
  };
}
