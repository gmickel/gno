import type {
  RetrievalTraceBundle,
  RetrievalTraceCursor,
  RetrievalTraceJudgmentRow,
  StoreResult,
} from "../store/types";
import type {
  LabelRetrievalTraceInput,
  RetrievalTraceSummary,
} from "./retrieval-trace-management-types";

import { hashTraceCanonical } from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";

export type EvidenceTarget = {
  docid?: string;
  sourceHash?: string;
  mirrorHash?: string;
  uri?: string;
  seq?: number;
  startLine?: number;
  endLine?: number;
  passageHash?: string;
};

export interface EvidenceMatch {
  target: EvidenceTarget;
  runId: string | null;
}

export const compactTarget = (target: EvidenceTarget): EvidenceTarget =>
  Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined)
  ) as EvidenceTarget;

export const summaryOf = (
  trace: RetrievalTraceBundle["trace"]
): RetrievalTraceSummary => ({
  traceId: trace.traceId,
  schemaVersion: trace.schemaVersion,
  redactionMode: trace.redactionMode,
  replayCapable: trace.replayCapable,
  status: trace.status,
  queryShape: trace.queryShape,
  goalShape: trace.goalShape,
  fingerprints: trace.fingerprints,
  createdAtMs: trace.createdAtMs,
  updatedAtMs: trace.updatedAtMs,
  expiresAtMs: trace.expiresAtMs,
  byteSize: trace.byteSize,
  creationDigest: trace.creationDigest,
});

const TRACE_CURSOR_PREFIX = "gno-trace-v1.";
const TRACE_CURSOR_KEYS = ["createdAtMs", "traceId"] as const;

export const encodeCursor = (cursor: RetrievalTraceCursor): string => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      createdAtMs: cursor.createdAtMs,
      traceId: cursor.traceId,
    })
  );
  return `${TRACE_CURSOR_PREFIX}${payload.toBase64({
    alphabet: "base64url",
    omitPadding: true,
  })}`;
};

export const decodeCursor = (
  value: string | undefined
): StoreResult<RetrievalTraceCursor | undefined> => {
  if (value === undefined) return ok(undefined);
  if (!value.startsWith(TRACE_CURSOR_PREFIX)) {
    return err("INVALID_INPUT", "Invalid trace cursor");
  }
  let decoded: unknown;
  try {
    const bytes = Uint8Array.fromBase64(
      value.slice(TRACE_CURSOR_PREFIX.length),
      {
        alphabet: "base64url",
      }
    );
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return err("INVALID_INPUT", "Invalid trace cursor");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return err("INVALID_INPUT", "Invalid trace cursor");
  }
  const record = decoded as Record<string, unknown>;
  if (
    Object.keys(record).length !== TRACE_CURSOR_KEYS.length ||
    TRACE_CURSOR_KEYS.some((key) => !(key in record))
  ) {
    return err("INVALID_INPUT", "Invalid trace cursor");
  }
  const { createdAtMs, traceId } = record;
  if (
    !Number.isSafeInteger(createdAtMs) ||
    (createdAtMs as number) < 0 ||
    typeof traceId !== "string" ||
    traceId.length < 1 ||
    traceId.length > 128
  ) {
    return err("INVALID_INPUT", "Invalid trace cursor");
  }
  return ok({ createdAtMs: createdAtMs as number, traceId });
};

export const stableTarget = (value: unknown): EvidenceTarget | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const target: EvidenceTarget = {};
  for (const key of [
    "docid",
    "sourceHash",
    "mirrorHash",
    "uri",
    "passageHash",
  ] as const) {
    if (typeof record[key] === "string") target[key] = record[key];
  }
  for (const key of ["seq", "startLine", "endLine"] as const) {
    if (typeof record[key] === "number") target[key] = record[key];
  }
  return target.docid || target.sourceHash || target.mirrorHash || target.uri
    ? target
    : null;
};

const payloadEvidence = (
  payload: Record<string, unknown>
): EvidenceTarget[] => {
  const found: EvidenceTarget[] = [];
  for (const key of ["ranked", "evidence"] as const) {
    const values = payload[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const target = stableTarget(value);
      if (target) found.push(target);
    }
  }
  return found;
};

export const allEvidence = (bundle: RetrievalTraceBundle): EvidenceMatch[] => [
  ...bundle.runs.flatMap((run) =>
    payloadEvidence(run.payload).map((target) => ({
      target,
      runId: run.runId,
    }))
  ),
  ...bundle.events.flatMap((event) =>
    payloadEvidence(event.payload).map((target) => ({
      target,
      runId: event.runId,
    }))
  ),
];

export const refMatches = (target: EvidenceTarget, ref: string): boolean =>
  [
    target.uri,
    target.docid,
    target.sourceHash,
    target.mirrorHash,
    target.passageHash,
  ].includes(ref);

export const applyTargetKind = (
  target: EvidenceTarget,
  input: LabelRetrievalTraceInput
): StoreResult<EvidenceTarget> => {
  const targetKind =
    input.targetKind ??
    (input.startLine === undefined
      ? target.seq === undefined
        ? "document"
        : "chunk"
      : "span");
  if ((input.startLine === undefined) !== (input.endLine === undefined)) {
    return err("INVALID_INPUT", "Trace span labels require both line bounds");
  }
  if (
    input.startLine !== undefined &&
    (input.startLine < 1 ||
      input.endLine! < input.startLine ||
      target.startLine !== input.startLine ||
      target.endLine !== input.endLine)
  ) {
    return err(
      "INVALID_INPUT",
      "Trace label does not match an exact evidence span"
    );
  }
  if (input.sourceHash && target.sourceHash !== input.sourceHash) {
    return err(
      "INVALID_INPUT",
      "Trace label source hash does not match evidence"
    );
  }
  if (input.docid && target.docid !== input.docid) {
    return err("INVALID_INPUT", "Trace label docid does not match evidence");
  }
  if (targetKind === "span" && target.startLine === undefined) {
    return err(
      "INVALID_INPUT",
      "Span labels require exact recorded evidence lines"
    );
  }
  if (targetKind === "chunk" && target.seq === undefined) {
    return err(
      "INVALID_INPUT",
      "Chunk labels require a recorded chunk sequence"
    );
  }
  if (targetKind === "document") {
    const { docid, sourceHash, mirrorHash, uri } = target;
    return ok(compactTarget({ docid, sourceHash, mirrorHash, uri }));
  }
  return ok(target);
};

export const targetKey = (
  targetKind: NonNullable<LabelRetrievalTraceInput["targetKind"]>,
  target: EvidenceTarget
): string => hashTraceCanonical({ targetKind, target });

export const latestForTarget = (
  judgments: RetrievalTraceJudgmentRow[],
  key: string
): RetrievalTraceJudgmentRow | undefined =>
  judgments
    .filter(
      (judgment) =>
        targetKey(
          judgment.targetKind as NonNullable<
            LabelRetrievalTraceInput["targetKind"]
          >,
          stableTarget(judgment.target) ?? {}
        ) === key
    )
    .at(-1);
