import type {
  ActivationStageReceipt,
  ActivationVerificationReceipt,
} from "./types";

const ACTIVATION_RECEIPT_MAX_BYTES = 16_384;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_URI_PATTERN = /^gno:\/\/[^/]+\/.+/;
const CONNECTOR_TARGET_PATTERN =
  /^(?:mcp|skill):[a-z0-9][a-z0-9._-]{0,63}:(?:user|project):[a-f0-9]{64}$/;
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const INDEX_FAILURE_CODES = new Set(["no_documents", "index_out_of_sync"]);
const LEXICAL_FAILURE_CODES = new Set([
  "no_probe_term",
  "index_query_failed",
  "retrieval_mismatch",
]);
const CONNECTOR_SKIPPED_CODES = new Set([
  "connector_not_configured",
  "connector_probe_unavailable",
  "target_runtime_unverifiable",
]);
const CONNECTOR_FAILURE_CODES = new Set([
  "connector_probe_unavailable",
  "connector_unsupported_config",
  "connector_start_failed",
  "connector_timeout",
  "connector_missing_tools",
  "connector_status_failed",
  "connector_search_failed",
  "connector_result_mismatch",
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function isNullableDateTime(value: unknown): value is string | null {
  return value === null || isDateTime(value);
}

function isStageShape(value: unknown): value is ActivationStageReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stage = value as Record<string, unknown>;
  return (
    hasOnlyKeys(
      stage,
      new Set(["status", "startedAt", "completedAt", "latencyMs", "code"])
    ) &&
    typeof stage.status === "string" &&
    isNullableDateTime(stage.startedAt) &&
    isNullableDateTime(stage.completedAt) &&
    (stage.latencyMs === null ||
      (typeof stage.latencyMs === "number" &&
        Number.isInteger(stage.latencyMs) &&
        stage.latencyMs >= 0)) &&
    (stage.code === undefined || typeof stage.code === "string")
  );
}

function isTimedStage(stage: ActivationStageReceipt): boolean {
  return (
    isDateTime(stage.startedAt) &&
    isDateTime(stage.completedAt) &&
    typeof stage.latencyMs === "number"
  );
}

function isIndexStage(stage: ActivationStageReceipt): boolean {
  if (!isTimedStage(stage)) {
    return false;
  }
  return (
    (stage.status === "passed" && stage.code === undefined) ||
    (stage.status === "failed" &&
      stage.code !== undefined &&
      INDEX_FAILURE_CODES.has(stage.code))
  );
}

function isLexicalStage(stage: ActivationStageReceipt): boolean {
  if (stage.status === "passed") {
    return isTimedStage(stage) && stage.code === undefined;
  }
  if (stage.status === "failed") {
    return (
      isTimedStage(stage) &&
      stage.code !== undefined &&
      LEXICAL_FAILURE_CODES.has(stage.code)
    );
  }
  return (
    stage.status === "skipped" &&
    stage.startedAt === null &&
    isDateTime(stage.completedAt) &&
    stage.latencyMs === null &&
    stage.code !== undefined &&
    INDEX_FAILURE_CODES.has(stage.code)
  );
}

function isSemanticStage(stage: ActivationStageReceipt): boolean {
  return (
    stage.status === "pending" &&
    stage.startedAt === null &&
    stage.completedAt === null &&
    stage.latencyMs === null &&
    stage.code === "semantic_not_checked"
  );
}

function isConnectorStage(stage: ActivationStageReceipt): boolean {
  if (stage.status === "passed") {
    return isTimedStage(stage) && stage.code === undefined;
  }
  if (stage.status === "failed") {
    return (
      isTimedStage(stage) &&
      stage.code !== undefined &&
      CONNECTOR_FAILURE_CODES.has(stage.code)
    );
  }
  if (stage.status !== "skipped") {
    return false;
  }
  if (stage.code === "connector_not_requested") {
    return (
      stage.startedAt === null &&
      stage.completedAt === null &&
      stage.latencyMs === null
    );
  }
  return (
    isTimedStage(stage) &&
    stage.code !== undefined &&
    CONNECTOR_SKIPPED_CODES.has(stage.code)
  );
}

function isReceipt(value: unknown): value is ActivationVerificationReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  const stages = receipt.stages as Record<string, unknown> | undefined;
  const evidence = receipt.evidence as Record<string, unknown> | undefined;
  if (
    !hasOnlyKeys(
      receipt,
      new Set([
        "schemaVersion",
        "collection",
        "fingerprint",
        "ready",
        "generatedAt",
        "stages",
        "evidence",
      ])
    ) ||
    receipt.schemaVersion !== "1.0" ||
    typeof receipt.collection !== "string" ||
    receipt.collection.length < 1 ||
    receipt.collection.length > 128 ||
    typeof receipt.fingerprint !== "string" ||
    !HASH_PATTERN.test(receipt.fingerprint) ||
    typeof receipt.ready !== "boolean" ||
    !isDateTime(receipt.generatedAt) ||
    !stages ||
    !hasOnlyKeys(
      stages,
      new Set(["index", "lexical", "semantic", "connector"])
    ) ||
    !isStageShape(stages.index) ||
    !isStageShape(stages.lexical) ||
    !isStageShape(stages.semantic) ||
    !isStageShape(stages.connector) ||
    !evidence ||
    !hasOnlyKeys(
      evidence,
      new Set(["probeHash", "resultUri", "resultSourceHash", "connectorTarget"])
    )
  ) {
    return false;
  }

  const indexStage = stages.index as ActivationStageReceipt;
  const lexicalStage = stages.lexical as ActivationStageReceipt;
  const semanticStage = stages.semantic as ActivationStageReceipt;
  const connectorStage = stages.connector as ActivationStageReceipt;
  if (
    !isIndexStage(indexStage) ||
    !isLexicalStage(lexicalStage) ||
    !isSemanticStage(semanticStage) ||
    !isConnectorStage(connectorStage)
  ) {
    return false;
  }
  const expectedReady =
    indexStage.status === "passed" && lexicalStage.status === "passed";
  if (receipt.ready !== expectedReady) {
    return false;
  }
  const connectorCode = connectorStage.code;
  const connectorNeedsLexicalProof =
    connectorStage.status === "passed" ||
    (connectorStage.status === "failed" &&
      connectorCode !== "connector_unsupported_config");
  const unavailableBeforeConnectorProbe =
    connectorStage.status === "skipped" &&
    connectorCode === "connector_probe_unavailable";
  if (
    (connectorNeedsLexicalProof && !expectedReady) ||
    (unavailableBeforeConnectorProbe && expectedReady)
  ) {
    return false;
  }

  const validEvidence =
    (evidence.probeHash === undefined ||
      (typeof evidence.probeHash === "string" &&
        HASH_PATTERN.test(evidence.probeHash))) &&
    (evidence.resultUri === undefined ||
      (typeof evidence.resultUri === "string" &&
        evidence.resultUri.length <= 2048 &&
        RESULT_URI_PATTERN.test(evidence.resultUri))) &&
    (evidence.resultSourceHash === undefined ||
      (typeof evidence.resultSourceHash === "string" &&
        HASH_PATTERN.test(evidence.resultSourceHash))) &&
    (evidence.connectorTarget === undefined ||
      (typeof evidence.connectorTarget === "string" &&
        CONNECTOR_TARGET_PATTERN.test(evidence.connectorTarget)));
  if (!validEvidence) {
    return false;
  }

  const connectorWasRequested =
    connectorStage.code !== "connector_not_requested";
  if (
    connectorWasRequested !==
    (typeof evidence.connectorTarget === "string")
  ) {
    return false;
  }

  const hasProbeHash = typeof evidence.probeHash === "string";
  const hasResultUri = typeof evidence.resultUri === "string";
  const hasResultSourceHash = typeof evidence.resultSourceHash === "string";
  if (expectedReady) {
    return hasProbeHash && hasResultUri && hasResultSourceHash;
  }
  if (lexicalStage.code === "retrieval_mismatch") {
    return hasProbeHash && !hasResultUri && !hasResultSourceHash;
  }
  return !hasProbeHash && !hasResultUri && !hasResultSourceHash;
}

export function parseActivationReceipt(
  raw: string
): ActivationVerificationReceipt | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isReceipt(parsed) ? projectReceipt(parsed) : null;
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
  | { ok: false; error: string } {
  let projected: ActivationVerificationReceipt;
  try {
    projected = projectReceipt(receipt);
  } catch {
    return { ok: false, error: "Activation receipt is schema-invalid" };
  }
  if (!isReceipt(projected)) {
    return { ok: false, error: "Activation receipt is schema-invalid" };
  }
  const json = JSON.stringify(projected);
  if (
    new TextEncoder().encode(json).byteLength > ACTIVATION_RECEIPT_MAX_BYTES
  ) {
    return { ok: false, error: "Activation receipt exceeds 16 KiB" };
  }
  return {
    ok: true,
    json,
    projected,
    connectorTarget: projected.evidence.connectorTarget ?? "",
  };
}
