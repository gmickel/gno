/** Runtime validation and deterministic encoding for local retrieval receipts. */

import { z } from "zod";

import type {
  RetrievalTraceEventInput,
  RetrievalTraceExportInput,
  RetrievalTraceInput,
  RetrievalTraceJudgmentInput,
  RetrievalTraceRunInput,
} from "./types";

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const idempotencyKeySchema = z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH);
const epochMsSchema = z.number().int().safe().nonnegative();
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export const traceJsonObjectSchema = z.record(z.string(), jsonValueSchema);

const SAFE_RECEIPT_STRING_KEYS = new Set([
  "capability",
  "capsuleId",
  "collection",
  "code",
  "docid",
  "filterFingerprint",
  "heading",
  "id",
  "kind",
  "mirrorHash",
  "mode",
  "name",
  "outcome",
  "passageHash",
  "reasonCode",
  "ref",
  "sourceHash",
  "status",
  "type",
  "uri",
]);
const SAFE_RECEIPT_STRING_LIST_KEYS = new Set([
  "capabilities",
  "categories",
  "collections",
  "fallbackCodes",
  "fallbacks",
  "itemTypes",
  "sources",
  "tags",
]);

const validateReceiptStrings = (
  value: unknown,
  context: z.RefinementCtx,
  key = "",
  path: Array<string | number> = []
): void => {
  if (typeof value === "string") {
    if (
      !(
        SAFE_RECEIPT_STRING_KEYS.has(key) ||
        SAFE_RECEIPT_STRING_LIST_KEYS.has(key)
      )
    ) {
      context.addIssue({
        code: "custom",
        path,
        message: `String field ${key || "<root>"} is not allowed in trace receipt payloads`,
      });
    } else if (key === "uri" && !value.startsWith("gno://")) {
      context.addIssue({
        code: "custom",
        path,
        message: "Trace evidence URI must use gno://",
      });
    } else if (traceUtf8Bytes(value) > 4096) {
      context.addIssue({
        code: "custom",
        path,
        message: `String field ${key} exceeds 4096 UTF-8 bytes`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      validateReceiptStrings(child, context, key, [...path, index]);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      validateReceiptStrings(child, context, childKey, [...path, childKey]);
    }
  }
};

const traceReceiptPayloadSchema = traceJsonObjectSchema.superRefine(
  (value, context) => validateReceiptStrings(value, context)
);

const queryShapeSchema = z
  .object({
    characters: z.number().int().nonnegative(),
    terms: z.number().int().nonnegative(),
  })
  .strict();

const traceInputBaseSchema = z
  .object({
    traceId: idSchema,
    schemaVersion: z.literal("1.0"),
    redactionMode: z.enum(["metadata", "replay"]),
    replayCapable: z.boolean(),
    queryText: z.string().max(8192).nullable(),
    queryDigest: sha256Schema.nullable(),
    queryShape: queryShapeSchema,
    goalText: z.string().max(8192).nullable(),
    goalDigest: sha256Schema.nullable(),
    goalShape: queryShapeSchema,
    filters: traceJsonObjectSchema,
    fingerprints: z
      .object({
        pipeline: sha256Schema,
        model: sha256Schema,
        config: sha256Schema,
        index: sha256Schema,
      })
      .strict(),
    status: z.literal("open"),
    createdAtMs: epochMsSchema,
    updatedAtMs: epochMsSchema,
    expiresAtMs: epochMsSchema,
  })
  .strict();

export const retrievalTraceInputSchema = traceInputBaseSchema.superRefine(
  (value, context) => {
    if (value.updatedAtMs < value.createdAtMs) {
      context.addIssue({
        code: "custom",
        path: ["updatedAtMs"],
        message: "updatedAtMs must not precede createdAtMs",
      });
    }
    if (value.updatedAtMs !== value.createdAtMs) {
      context.addIssue({
        code: "custom",
        path: ["updatedAtMs"],
        message: "new traces must start with updatedAtMs equal to createdAtMs",
      });
    }
    if (value.expiresAtMs <= value.createdAtMs) {
      context.addIssue({
        code: "custom",
        path: ["expiresAtMs"],
        message: "expiresAtMs must be later than createdAtMs",
      });
    }
    const metadataInvariant =
      value.redactionMode === "metadata" &&
      !value.replayCapable &&
      value.queryText === null &&
      value.queryDigest === null &&
      value.goalText === null &&
      value.goalDigest === null;
    const replayInvariant =
      value.redactionMode === "replay" &&
      value.replayCapable &&
      value.queryText !== null &&
      value.queryDigest !== null &&
      ((value.goalText === null && value.goalDigest === null) ||
        (value.goalText !== null && value.goalDigest !== null));
    if (!(metadataInvariant || replayInvariant)) {
      context.addIssue({
        code: "custom",
        message:
          "metadata traces cannot retain query material; replay traces require explicit replay inputs",
      });
    }
    if (value.redactionMode === "replay" && value.queryText !== null) {
      const expectedDigest = new Bun.CryptoHasher("sha256")
        .update(value.queryText)
        .digest("hex");
      if (value.queryDigest !== expectedDigest) {
        context.addIssue({
          code: "custom",
          path: ["queryDigest"],
          message: "queryDigest does not match queryText",
        });
      }
      const expectedShape = shapeTraceText(value.queryText);
      if (
        value.queryShape.characters !== expectedShape.characters ||
        value.queryShape.terms !== expectedShape.terms
      ) {
        context.addIssue({
          code: "custom",
          path: ["queryShape"],
          message: "queryShape does not match queryText",
        });
      }
    }
    if (value.redactionMode === "replay" && value.goalText !== null) {
      const expectedDigest = new Bun.CryptoHasher("sha256")
        .update(value.goalText)
        .digest("hex");
      if (value.goalDigest !== expectedDigest) {
        context.addIssue({
          code: "custom",
          path: ["goalDigest"],
          message: "goalDigest does not match goalText",
        });
      }
      const expectedShape = shapeTraceText(value.goalText);
      if (
        value.goalShape.characters !== expectedShape.characters ||
        value.goalShape.terms !== expectedShape.terms
      ) {
        context.addIssue({
          code: "custom",
          path: ["goalShape"],
          message: "goalShape does not match goalText",
        });
      }
    }
  }
);

export const retrievalTraceRunInputSchema = z
  .object({
    runId: idSchema,
    traceId: idSchema,
    idempotencyKey: idempotencyKeySchema,
    kind: z.enum(["retrieval", "context", "get"]),
    payload: traceReceiptPayloadSchema,
    createdAtMs: epochMsSchema,
  })
  .strict();

export const retrievalTraceEventInputSchema = z
  .object({
    eventId: idSchema,
    traceId: idSchema,
    runId: idSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    kind: z.enum([
      "query",
      "retrieval",
      "context",
      "get",
      "open",
      "cite",
      "pin",
      "capability",
      "complete",
    ]),
    payload: traceReceiptPayloadSchema,
    createdAtMs: epochMsSchema,
  })
  .strict();

export const retrievalTraceJudgmentInputSchema = z
  .object({
    judgmentId: idSchema,
    traceId: idSchema,
    runId: idSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
    label: z.enum(["relevant", "irrelevant", "missing_expected"]),
    targetKind: z.enum(["document", "chunk", "span", "query"]),
    targetRef: z.string().min(1).max(4096),
    target: traceReceiptPayloadSchema,
    createdAtMs: epochMsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.label === "missing_expected" && value.targetKind !== "document") {
      context.addIssue({
        code: "custom",
        path: ["targetKind"],
        message: "missing_expected judgments must target a document",
      });
    }
  });

export const retrievalTraceExportInputSchema = z
  .object({
    exportId: idSchema,
    traceId: idSchema,
    format: z.enum(["agentic-receipt", "qrels"]),
    artifactHash: sha256Schema,
    createdAtMs: epochMsSchema,
  })
  .strict();

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      if (DANGEROUS_JSON_KEYS.has(key)) {
        throw new Error(`Canonical JSON rejects dangerous key ${key}`);
      }
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${key}`);
      }
      sorted[key] = canonicalizeJsonValue(child);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON rejects non-finite numbers");
  }
  return value;
};

const shapeTraceText = (
  value: string
): { characters: number; terms: number } => ({
  characters: Array.from(value).length,
  terms: value.trim() ? value.trim().split(/\s+/u).length : 0,
});

export const canonicalTraceJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));

export const traceUtf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const hashTraceCanonical = (value: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalTraceJson(value))
    .digest("hex");

/** Stable trace identity excludes terminal status and mutable updatedAtMs. */
export const hashRetrievalTraceCreation = (
  trace: RetrievalTraceInput
): string => {
  const { status: _status, updatedAtMs: _updatedAtMs, ...immutable } = trace;
  return hashTraceCanonical(immutable);
};

export const parseRetrievalTraceInput = (
  input: RetrievalTraceInput
): RetrievalTraceInput => retrievalTraceInputSchema.parse(input);

export const parseRetrievalTraceRunInput = (
  input: RetrievalTraceRunInput
): RetrievalTraceRunInput => retrievalTraceRunInputSchema.parse(input);

export const parseRetrievalTraceEventInput = (
  input: RetrievalTraceEventInput
): RetrievalTraceEventInput => retrievalTraceEventInputSchema.parse(input);

export const parseRetrievalTraceJudgmentInput = (
  input: RetrievalTraceJudgmentInput
): RetrievalTraceJudgmentInput =>
  retrievalTraceJudgmentInputSchema.parse(input);

export const parseRetrievalTraceExportInput = (
  input: RetrievalTraceExportInput
): RetrievalTraceExportInput => retrievalTraceExportInputSchema.parse(input);
