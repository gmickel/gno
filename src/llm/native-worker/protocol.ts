/** Internal protocol only. Dedicated IPC carries frames; stdout/stderr are diagnostics.
 * Bounds reject overload, never truncate retrieval inputs or outputs. Parent selects
 * and approves canonical local paths; the child must recheck filesystem identity
 * before loading. No model discovery, download, policy or native imports live here.
 */
import { z } from "zod";

import { NativeWorkerError } from "./errors";

export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_QUEUE_LIMIT = 64;
export const NATIVE_FRAME_BYTES = 8 * 1024 * 1024;
export const NATIVE_LOGICAL_BYTES = 64 * 1024 * 1024;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();
const localPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))
  );

export const ApprovedModelSchema = z.strictObject({
  id: z.string().min(1),
  modelUri: z.string().min(1),
  path: localPath,
  type: z.enum(["embed", "rerank", "gen", "expand"]),
});
export type ApprovedModel = z.infer<typeof ApprovedModelSchema>;
const params = z.strictObject({
  temperature: finite.optional(),
  seed: finite.optional(),
  maxTokens: finite.optional(),
  contextSize: finite.optional(),
  stop: z.array(z.string()).optional(),
  jsonSchema: z.record(z.string(), z.json()).optional(),
});
const envelope = { version: z.literal(1), generation: id, requestId: id };
// AbortSignal is process-local. The deadline travels with the request; subsequent
// cancellation targets the same generation/request identity on the control lane.
const model = {
  ...envelope,
  modelId: z.string().min(1),
  deadlineAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
};
export const NativeCancellationSchema = z.strictObject({
  ...envelope,
  cancel: z.enum(["abort", "timeout"]),
});
export type NativeCancellation = z.infer<typeof NativeCancellationSchema>;
/** Execution starts after load/context creation, never at queue admission. */
export const NativeExecutionStartedSchema = z.strictObject({
  ...envelope,
  executionStarted: z.literal(true),
});
export const NativeRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ ...model, op: z.literal("init") }),
  z.strictObject({ ...model, op: z.literal("embed"), text: z.string() }),
  z.strictObject({
    ...model,
    op: z.literal("embedBatch"),
    texts: z.array(z.string()),
  }),
  z.strictObject({
    ...model,
    op: z.literal("rerank"),
    query: z.string(),
    documents: z.array(z.string()),
  }),
  z.strictObject({
    ...model,
    op: z.literal("generate"),
    prompt: z.string(),
    params: params.optional(),
  }),
  z.strictObject({ ...model, op: z.literal("dispose") }),
]);
export type NativeRequest = z.infer<typeof NativeRequestSchema>;
const error = z.strictObject({
  code: z.enum([
    "MODEL_NOT_FOUND",
    "MODEL_NOT_CACHED",
    "MODEL_DOWNLOAD_FAILED",
    "MODEL_LOAD_FAILED",
    "MODEL_CORRUPTED",
    "INVALID_MODEL_FILE",
    "MODEL_DOWNLOAD_INTERCEPTED",
    "INFERENCE_FAILED",
    "EGRESS_DENIED",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "INVALID_URI",
    "LOCK_FAILED",
    "AUTO_DOWNLOAD_DISABLED",
    "STRUCTURED_OUTPUT_UNAVAILABLE",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  modelUri: z.string().optional(),
  cause: z.json().optional(),
  suggestion: z.string().optional(),
});
export const EmbeddingIdentitySchema = z.strictObject({
  contextSize: id,
  truncationPolicy: z.string().min(1),
  modelFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeLabel: z.string().min(1),
});
const metadata = z.strictObject({
  dimensions: id.optional(),
  structuredOutput: z.enum(["json_schema", "none"]),
  embeddingIdentity: EmbeddingIdentitySchema.optional(),
});
const score = z.strictObject({
  index: z.number().int().nonnegative(),
  score: finite,
  rank: id,
});
export const NativeLifecycleStatsSchema = z.strictObject({
  activeLeases: z.number().int().nonnegative(),
  leaseAcquisitions: z.number().int().nonnegative(),
  leaseReleases: z.number().int().nonnegative(),
  loadedModels: z.number().int().nonnegative(),
  loadAttempts: z.number().int().nonnegative(),
  loadSuccesses: z.number().int().nonnegative(),
  loadFailures: z.number().int().nonnegative(),
  inflightLoads: z.number().int().nonnegative(),
});
export const NativeResponseSchema = z.strictObject({
  ...envelope,
  op: z.enum(["init", "embed", "embedBatch", "rerank", "generate", "dispose"]),
  lifecycle: NativeLifecycleStatsSchema.optional(),
  result: z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(false), error }),
    z.strictObject({
      ok: z.literal(true),
      value: z.union([
        z.null(),
        metadata,
        z.string(),
        z.array(finite),
        z.array(z.array(finite)),
        z.array(score),
      ]),
    }),
  ]),
});
export type NativeResponse = z.infer<typeof NativeResponseSchema>;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
/**
 * Binary frame payload tag for `embed` / `embedBatch` `ok: true` responses.
 * JSON payloads always begin with `0x7b` ('{'), so `0x01` is unambiguous.
 */
export const NATIVE_BINARY_EMBED_MAGIC = 0x01;
const PREVALIDATED_EMBED_VALUE = Symbol("gno.nativeBinaryEmbedValidated");

/** Mark an embed/embedBatch vector payload already validated by binary decode. */
function markPrevalidatedEmbedValue<T extends object>(value: T): T {
  Object.defineProperty(value, PREVALIDATED_EMBED_VALUE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

/** True when `value` was decoded from a binary Float64Array frame and already verified finite/uniform. */
export function isPrevalidatedEmbedValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[PREVALIDATED_EMBED_VALUE] === true
  );
}

const NativeResponseEnvelopeSchema = z.strictObject({
  ...envelope,
  op: z.enum(["init", "embed", "embedBatch", "rerank", "generate", "dispose"]),
  lifecycle: NativeLifecycleStatsSchema.optional(),
  result: z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(false), error }),
    z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  ]),
});

const BinaryEmbedHeaderSchema = z.strictObject({
  ...envelope,
  op: z.enum(["embed", "embedBatch"]),
  lifecycle: NativeLifecycleStatsSchema.optional(),
  vectorCount: id,
  dims: id,
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new NativeWorkerError("protocol");
  return parsed.data;
}

/** Tight non-Zod validation for a non-empty finite float vector. */
export function validateFiniteVector(
  value: unknown,
  expectedDims?: number
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NativeWorkerError("protocol");
  }
  if (expectedDims !== undefined && value.length !== expectedDims) {
    throw new NativeWorkerError("protocol");
  }
  for (let i = 0; i < value.length; i += 1) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new NativeWorkerError("protocol");
    }
  }
  return value as number[];
}

/** Tight non-Zod validation for a uniform batch of non-empty finite float vectors. */
export function validateFiniteVectorBatch(
  value: unknown,
  expectedCount: number,
  expectedDims?: number
): number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new NativeWorkerError("protocol");
  }
  if (expectedCount === 0) {
    return [];
  }
  let dims = expectedDims;
  for (let i = 0; i < value.length; i += 1) {
    const row = validateFiniteVector(value[i], dims);
    if (dims === undefined) {
      dims = row.length;
    }
  }
  return value as number[][];
}

function assertLogicalByteLength(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > NATIVE_LOGICAL_BYTES
  ) {
    throw new NativeWorkerError("oversized");
  }
}

/** JSON size is measured in UTF-8 bytes, including escaping and envelope. */
export function encodeNativeMessage(input: unknown): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    throw new NativeWorkerError("protocol");
  }
  if (json === undefined) throw new NativeWorkerError("protocol");
  const bytes = UTF8_ENCODER.encode(json);
  if (bytes.length > NATIVE_LOGICAL_BYTES)
    throw new NativeWorkerError("oversized");
  return bytes;
}

/**
 * Encode `embed` / `embedBatch` `ok: true` responses into a compact, bit-exact
 * IEEE-754 Float64Array binary payload (2.5x smaller than JSON, zero float-to-
 * ASCII formatting/parsing). Returns null for non-embed/error/malformed payloads
 * so callers fall back to standard JSON encoding.
 */
function tryEncodeBinaryEmbedPayload(
  message: NativeRequest | NativeResponse
): Uint8Array | null {
  if (!("result" in message) || !message.result.ok) {
    return null;
  }
  if (message.op !== "embed" && message.op !== "embedBatch") {
    return null;
  }
  const value = message.result.value;
  let vectors: readonly (readonly number[])[];
  if (message.op === "embed") {
    if (!Array.isArray(value) || value.length === 0) return null;
    for (let i = 0; i < value.length; i += 1) {
      const v = value[i];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
    }
    vectors = [value as number[]];
  } else {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0];
    if (!Array.isArray(first) || first.length === 0) return null;
    const dims = first.length;
    for (let i = 0; i < value.length; i += 1) {
      const row = value[i];
      if (!Array.isArray(row) || row.length !== dims) return null;
      for (let j = 0; j < dims; j += 1) {
        const v = row[j];
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
      }
    }
    vectors = value as number[][];
  }

  const vectorCount = vectors.length;
  const dims = vectors[0]!.length;
  const headerObj: Record<string, unknown> = {
    version: message.version,
    generation: message.generation,
    requestId: message.requestId,
    op: message.op,
    vectorCount,
    dims,
  };
  if (message.lifecycle !== undefined) {
    headerObj.lifecycle = message.lifecycle;
  }
  const headerBytes = UTF8_ENCODER.encode(JSON.stringify(headerObj));
  const unalignedPrefix = 1 + 4 + headerBytes.length;
  const alignedOffset = (unalignedPrefix + 7) & ~7;
  const floatBytes = vectorCount * dims * 8;
  const totalBytes = alignedOffset + floatBytes;
  if (totalBytes > NATIVE_LOGICAL_BYTES) {
    throw new NativeWorkerError("oversized");
  }

  const payload = new Uint8Array(totalBytes);
  payload[0] = NATIVE_BINARY_EMBED_MAGIC;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  view.setUint32(1, headerBytes.length, true);
  payload.set(headerBytes, 5);
  let byteOffset = alignedOffset;
  for (let i = 0; i < vectorCount; i += 1) {
    const row = vectors[i]!;
    for (let j = 0; j < dims; j += 1) {
      view.setFloat64(byteOffset, row[j]!, true);
      byteOffset += 8;
    }
  }
  return payload;
}

function decodeBinaryEmbedPayload(
  payload: Uint8Array,
  expectedGeneration: number,
  expectedRequestId: number
): NativeResponse {
  if (payload.length < 5) {
    throw new NativeWorkerError("protocol");
  }
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  const headerLen = view.getUint32(1, true);
  const unalignedPrefix = 5 + headerLen;
  const alignedOffset = (unalignedPrefix + 7) & ~7;
  if (headerLen === 0 || alignedOffset > payload.length) {
    throw new NativeWorkerError("protocol");
  }
  // Ensure padding bytes are zeroed so malformed frames fail closed.
  for (let i = unalignedPrefix; i < alignedOffset; i += 1) {
    if (payload[i] !== 0) {
      throw new NativeWorkerError("protocol");
    }
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(
      UTF8_DECODER.decode(payload.subarray(5, unalignedPrefix))
    );
  } catch {
    throw new NativeWorkerError("protocol");
  }
  const header = parse(BinaryEmbedHeaderSchema, rawHeader);
  if (
    header.generation !== expectedGeneration ||
    header.requestId !== expectedRequestId
  ) {
    throw new NativeWorkerError("protocol");
  }
  if (header.op === "embed" && header.vectorCount !== 1) {
    throw new NativeWorkerError("protocol");
  }
  const expectedFloatBytes = header.vectorCount * header.dims * 8;
  if (payload.length - alignedOffset !== expectedFloatBytes) {
    throw new NativeWorkerError("protocol");
  }

  let byteOffset = alignedOffset;
  if (header.op === "embed") {
    const vec = Array.from<number>({ length: header.dims });
    for (let j = 0; j < header.dims; j += 1) {
      const val = view.getFloat64(byteOffset, true);
      if (!Number.isFinite(val)) throw new NativeWorkerError("protocol");
      vec[j] = val;
      byteOffset += 8;
    }
    return {
      version: 1,
      generation: header.generation,
      requestId: header.requestId,
      op: "embed",
      ...(header.lifecycle !== undefined
        ? { lifecycle: header.lifecycle }
        : {}),
      result: { ok: true, value: markPrevalidatedEmbedValue(vec) },
    };
  }

  const vectors = Array.from<number[]>({ length: header.vectorCount });
  for (let i = 0; i < header.vectorCount; i += 1) {
    const vec = Array.from<number>({ length: header.dims });
    for (let j = 0; j < header.dims; j += 1) {
      const val = view.getFloat64(byteOffset, true);
      if (!Number.isFinite(val)) throw new NativeWorkerError("protocol");
      vec[j] = val;
      byteOffset += 8;
    }
    vectors[i] = vec;
  }
  return {
    version: 1,
    generation: header.generation,
    requestId: header.requestId,
    op: "embedBatch",
    ...(header.lifecycle !== undefined ? { lifecycle: header.lifecycle } : {}),
    result: { ok: true, value: markPrevalidatedEmbedValue(vectors) },
  };
}

export function parseNativeRequest(
  input: unknown,
  generation: number,
  approved: readonly ApprovedModel[],
  knownByteLength?: number
): NativeRequest {
  if (knownByteLength !== undefined) {
    assertLogicalByteLength(knownByteLength);
  } else {
    encodeNativeMessage(input);
  }
  const request = parse(NativeRequestSchema, input);
  if (request.generation !== generation)
    throw new NativeWorkerError("stale_generation");
  const descriptor = approved.find((entry) => entry.id === request.modelId);
  if (!descriptor) throw new NativeWorkerError("protocol");
  parse(ApprovedModelSchema, descriptor);
  const compatible =
    request.op === "init" ||
    request.op === "dispose" ||
    (request.op === "embed" || request.op === "embedBatch"
      ? descriptor.type === "embed"
      : request.op === "rerank"
        ? descriptor.type === "rerank"
        : descriptor.type === "gen" || descriptor.type === "expand");
  if (!compatible) throw new NativeWorkerError("protocol");
  return request;
}

export function parseNativeResponse(
  input: unknown,
  request: NativeRequest,
  knownByteLength?: number
): NativeResponse {
  if (knownByteLength !== undefined) {
    assertLogicalByteLength(knownByteLength);
  } else {
    encodeNativeMessage(input);
  }
  const response = parse(NativeResponseEnvelopeSchema, input);
  if (response.generation !== request.generation)
    throw new NativeWorkerError("stale_generation");
  if (response.requestId !== request.requestId || response.op !== request.op)
    throw new NativeWorkerError("protocol");
  if (!response.result.ok) return response as NativeResponse;
  const value = response.result.value;
  switch (request.op) {
    case "init":
      parse(metadata, value);
      break;
    case "dispose":
      parse(z.null(), value);
      break;
    case "generate":
      parse(z.string(), value);
      break;
    case "embed":
      if (!isPrevalidatedEmbedValue(value)) {
        validateFiniteVector(value);
      }
      break;
    case "embedBatch": {
      if (!isPrevalidatedEmbedValue(value)) {
        validateFiniteVectorBatch(value, request.texts.length);
      } else if ((value as number[][]).length !== request.texts.length) {
        throw new NativeWorkerError("protocol");
      }
      break;
    }
    case "rerank": {
      const scores = parse(
        z.array(score).length(request.documents.length),
        value
      );
      if (
        new Set(scores.map((entry) => entry.index)).size !== scores.length ||
        new Set(scores.map((entry) => entry.rank)).size !== scores.length ||
        scores.some(
          (entry) => entry.index >= scores.length || entry.rank > scores.length
        )
      )
        throw new NativeWorkerError("protocol");
      break;
    }
    default:
      throw new NativeWorkerError("protocol");
  }
  return response as NativeResponse;
}

/** Binary frame header: version, generation, requestId (float64 safe integers),
 * total logical bytes, byte offset (uint32). Transport preserves frame boundaries.
 * One ordered logical message at a time per direction; diagnostics are never frames.
 */
const HEADER_BYTES = 32;

export function frameNativeBytes(
  identity: { generation: number; requestId: number },
  bytes: Uint8Array
): Uint8Array[] {
  if (bytes.length === 0 || bytes.length > NATIVE_LOGICAL_BYTES) {
    throw new NativeWorkerError("oversized");
  }
  const frames: Uint8Array[] = [];
  const maxPart = NATIVE_FRAME_BYTES - HEADER_BYTES;
  for (let offset = 0; offset < bytes.length; offset += maxPart) {
    const part = bytes.subarray(offset, offset + maxPart);
    const frame = new Uint8Array(HEADER_BYTES + part.length);
    const view = new DataView(frame.buffer);
    view.setFloat64(0, NATIVE_PROTOCOL_VERSION);
    view.setFloat64(8, identity.generation);
    view.setFloat64(16, identity.requestId);
    view.setUint32(24, bytes.length);
    view.setUint32(28, offset);
    frame.set(part, HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

export function frameNativeMessage(
  message: NativeRequest | NativeResponse
): Uint8Array[] {
  const bytes =
    tryEncodeBinaryEmbedPayload(message) ?? encodeNativeMessage(message);
  return frameNativeBytes(message, bytes);
}

export class NativeFrameDecoder {
  private bytes?: Uint8Array;
  private received = 0;
  private requestId = 0;
  private lastDecodedBytes = 0;

  constructor(private readonly generation: number) {
    parse(id, generation);
  }

  /** Logical payload byte length of the most recently decoded message. */
  get lastDecodedByteLength(): number {
    return this.lastDecodedBytes;
  }

  reset(): void {
    this.bytes = undefined;
    this.received = 0;
    this.requestId = 0;
  }

  push(frame: Uint8Array): unknown {
    try {
      return this.accept(frame);
    } catch (cause) {
      this.reset();
      throw cause;
    }
  }

  private accept(frame: Uint8Array): unknown {
    if (frame.length <= HEADER_BYTES || frame.length > NATIVE_FRAME_BYTES)
      throw new NativeWorkerError("oversized");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (view.getFloat64(0) !== NATIVE_PROTOCOL_VERSION)
      throw new NativeWorkerError("protocol");
    if (view.getFloat64(8) !== this.generation)
      throw new NativeWorkerError("stale_generation");
    const requestId = parse(id, view.getFloat64(16));
    const total = view.getUint32(24);
    const offset = view.getUint32(28);
    const part = frame.subarray(HEADER_BYTES);
    if (!total || total > NATIVE_LOGICAL_BYTES)
      throw new NativeWorkerError("oversized");
    if (offset !== this.received || offset + part.length > total)
      throw new NativeWorkerError("protocol");

    // Zero-copy fast path for single-frame messages (the common case).
    let payload: Uint8Array;
    if (!this.bytes && offset === 0 && part.length === total) {
      payload = part;
    } else {
      if (!this.bytes) {
        this.bytes = new Uint8Array(total);
        this.requestId = requestId;
      }
      if (this.bytes.length !== total || this.requestId !== requestId)
        throw new NativeWorkerError("protocol");
      this.bytes.set(part, offset);
      this.received += part.length;
      if (this.received !== total) return;
      payload = this.bytes;
    }

    let decoded: unknown;
    if (payload[0] === NATIVE_BINARY_EMBED_MAGIC) {
      decoded = decodeBinaryEmbedPayload(payload, this.generation, requestId);
    } else {
      try {
        decoded = JSON.parse(UTF8_DECODER.decode(payload));
      } catch {
        throw new NativeWorkerError("protocol");
      }
      const identity = parse(z.object(envelope), decoded);
      if (
        identity.generation !== this.generation ||
        identity.requestId !== requestId
      )
        throw new NativeWorkerError("protocol");
    }
    this.lastDecodedBytes = total;
    this.reset();
    return decoded;
  }
}

/** Split only between texts, retaining order and exact text. The complete original
 * operation must fit the logical ceiling. Each part fits a single transport frame.
 * Large individual texts remain intact and use byte framing instead of truncation.
 */
export function splitEmbeddingRequest(
  request: Extract<NativeRequest, { op: "embedBatch" }>
): string[][] {
  const maxFramePayload = NATIVE_FRAME_BYTES - HEADER_BYTES;
  // O(N) char-length fast path: worst-case JSON UTF-8 expansion is 6 bytes per
  // UTF-16 code unit (`\uXXXX`) plus 2 quote bytes + 1 comma per item + ~256 B
  // envelope overhead. When even the worst case fits in one frame, return
  // immediately without allocating JSON or UTF-8 buffers.
  let upperBound = 512 + request.modelId.length * 6;
  for (let i = 0; i < request.texts.length; i += 1) {
    upperBound += request.texts[i]!.length * 6 + 3;
    if (upperBound > maxFramePayload) {
      break;
    }
  }
  if (upperBound <= maxFramePayload) {
    return [request.texts];
  }

  const overhead = encodeNativeMessage({ ...request, texts: [] }).length;
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = overhead;
  let totalSize = overhead;
  for (let i = 0; i < request.texts.length; i += 1) {
    const text = request.texts[i]!;
    const length = encodeNativeMessage(text).length;
    totalSize += length + (i > 0 ? 1 : 0);
    if (totalSize > NATIVE_LOGICAL_BYTES) {
      throw new NativeWorkerError("oversized");
    }
    if (batch.length && size + length + 1 > maxFramePayload) {
      batches.push(batch);
      batch = [];
      size = overhead;
    }
    size += length + (batch.length ? 1 : 0);
    batch.push(text);
  }
  if (batch.length || !batches.length) batches.push(batch);
  return batches;
}

/** Admission counts one active + 64 queued logical operations, never batch parts.
 * Monotonic IDs prohibit reuse without an unbounded completed-ID cache. Runtime
 * serializes execution and delivers each returned response once; timeout/exit drains
 * pending entries, so late responses cannot resolve a replacement generation.
 */
export class NativeRequestLedger {
  private readonly pending = new Map<number, NativeRequest>();
  private highestId = 0;
  constructor(readonly generation: number) {
    parse(id, generation);
  }
  get size(): number {
    return this.pending.size;
  }

  admit(request: NativeRequest, knownByteLength?: number): void {
    const snapshot = parse(NativeRequestSchema, request);
    if (request.generation !== this.generation)
      throw new NativeWorkerError("stale_generation");
    if (request.requestId <= this.highestId)
      throw new NativeWorkerError("duplicate_completion");
    if (this.pending.size >= NATIVE_QUEUE_LIMIT + 1)
      throw new NativeWorkerError("overloaded");
    if (knownByteLength !== undefined) {
      assertLogicalByteLength(knownByteLength);
    } else {
      encodeNativeMessage(request);
    }
    this.highestId = request.requestId;
    this.pending.set(request.requestId, snapshot);
  }

  /** Only the client queue owner may remove an operation never dispatched. */
  cancelQueued(requestId: number): void {
    if (!this.pending.delete(requestId))
      throw new NativeWorkerError("protocol");
  }

  settle(input: unknown, knownByteLength?: number): NativeResponse {
    const identity = parse(z.object(envelope), input);
    if (identity.generation !== this.generation)
      throw new NativeWorkerError("stale_generation");
    const request = this.pending.get(identity.requestId);
    if (!request) throw new NativeWorkerError("duplicate_completion");
    const response = parseNativeResponse(input, request, knownByteLength);
    this.pending.delete(request.requestId);
    return response;
  }

  failAll(failure: NativeWorkerError): NativeResponse[] {
    const responses = Array.from(
      this.pending.values(),
      (request): NativeResponse => ({
        version: 1,
        generation: this.generation,
        requestId: request.requestId,
        op: request.op,
        result: { ok: false, error: parse(error, failure.detail) },
      })
    );
    this.pending.clear();
    return responses;
  }
}
