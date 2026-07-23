import type {
  AgentVisibleCall,
  AgentVisibleToolResult,
  CanonicalAgentCall,
  EvidenceCoordinate,
  NormalizedToolResult,
  TrajectoryReceipt,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const sha256Bytes = (value: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const exactLineSpan = (
  content: string,
  startLine: number,
  endLine: number
): string => {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error("Evidence line coordinates must be integers");
  }
  if (startLine < 1 || endLine < startLine) {
    throw new Error("Evidence uses 1-based inclusive line coordinates");
  }
  const normalized = normalizeNewlines(content);
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (endLine > lines.length) {
    throw new Error(
      `Evidence line ${endLine} exceeds source line count ${lines.length}`
    );
  }
  return lines.slice(startLine - 1, endLine).join("\n");
};

export const sourceHash = (content: string): string => sha256Bytes(content);

export const spanHash = (
  content: string,
  startLine: number,
  endLine: number
): string => sha256Bytes(exactLineSpan(content, startLine, endLine));

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const assertJsonValue = (value: unknown, path: string): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Canonical JSON rejects non-finite number at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${path}.${key}`);
      }
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`Canonical JSON rejects ${typeof value} at ${path}`);
};

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
};

export const canonicalJson = (value: unknown): string => {
  assertJsonValue(value, "$");
  return JSON.stringify(sortJsonValue(value));
};

export const canonicalFingerprint = (value: unknown): string =>
  sha256Bytes(canonicalJson(value));

export const modelVisibleUtf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(canonicalJson(value)).byteLength;

const bundleContentCarriesExactEvidence = (
  result: NormalizedToolResult
): boolean => {
  if (result.resultRole !== "evidence_bundle") return false;
  try {
    const payload = JSON.parse(result.content) as { evidence?: unknown };
    if (!Array.isArray(payload.evidence)) return false;
    return result.evidence.every((expected) =>
      payload.evidence.some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return false;
        }
        const item = value as Record<string, unknown>;
        return (
          item.uri === expected.uri &&
          item.sourceHash === expected.sourceHash &&
          item.startLine === expected.startLine &&
          item.endLine === expected.endLine &&
          (item.spanHash === expected.spanHash ||
            item.passageHash === expected.spanHash) &&
          item.text === expected.text
        );
      })
    );
  } catch {
    return false;
  }
};

export const projectModelVisibleToolResult = (
  result: NormalizedToolResult
): AgentVisibleToolResult => ({
  status: result.status,
  resultRole: result.resultRole,
  content: result.content,
  // Evidence bundles already carry these exact spans in their canonical
  // content. The normalized evidence array is retained in the receipt for
  // deterministic scoring, but exposing it again would charge/deliver every
  // passage twice.
  evidence: bundleContentCarriesExactEvidence(result)
    ? []
    : result.evidence.map((item) => ({
        uri: item.uri,
        sourceHash: item.sourceHash,
        startLine: item.startLine,
        endLine: item.endLine,
        spanHash: item.spanHash,
        sourceHashProvenance: item.sourceHashProvenance,
        spanHashProvenance: item.spanHashProvenance,
        text: item.text,
      })),
  errorCode: result.errorCode,
});

export const projectAgentVisibleCalls = (
  calls: readonly CanonicalAgentCall[]
): AgentVisibleCall[] =>
  calls
    .filter((call) => call.deliveredToAgent)
    .map((call) => ({
      callIndex: call.callIndex,
      toolName: call.toolName,
      arguments: structuredClone(call.arguments),
      result: projectModelVisibleToolResult(call.result),
    }));

export const receiptCanonicalJson = (receipt: TrajectoryReceipt): string =>
  canonicalJson(receipt.canonical);

export const receiptCanonicalFingerprint = (
  receipt: TrajectoryReceipt
): string => sha256Bytes(receiptCanonicalJson(receipt));

export const evidenceKey = (evidence: EvidenceCoordinate): string =>
  [
    evidence.uri,
    evidence.sourceHash,
    evidence.startLine,
    evidence.endLine,
    evidence.spanHash,
    evidence.sourceHashProvenance,
    evidence.spanHashProvenance,
  ].join("\0");

export const assertSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
};
