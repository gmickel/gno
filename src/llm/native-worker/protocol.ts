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
const model = { ...envelope, modelId: z.string().min(1) };
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

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new NativeWorkerError("protocol");
  return parsed.data;
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
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > NATIVE_LOGICAL_BYTES)
    throw new NativeWorkerError("oversized");
  return bytes;
}

export function parseNativeRequest(
  input: unknown,
  generation: number,
  approved: readonly ApprovedModel[]
): NativeRequest {
  encodeNativeMessage(input);
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
  request: NativeRequest
): NativeResponse {
  encodeNativeMessage(input);
  const response = parse(NativeResponseSchema, input);
  if (response.generation !== request.generation)
    throw new NativeWorkerError("stale_generation");
  if (response.requestId !== request.requestId || response.op !== request.op)
    throw new NativeWorkerError("protocol");
  if (!response.result.ok) return response;
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
      parse(z.array(finite).min(1), value);
      break;
    case "embedBatch": {
      const vectors = parse(
        z.array(z.array(finite).min(1)).length(request.texts.length),
        value
      );
      if (vectors.some((vector) => vector.length !== vectors[0]?.length))
        throw new NativeWorkerError("protocol");
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
  return response;
}

/** Binary frame header: version, generation, requestId (float64 safe integers),
 * total logical bytes, byte offset (uint32). Transport preserves frame boundaries.
 * One ordered logical message at a time per direction; diagnostics are never frames.
 */
const HEADER_BYTES = 32;
export function frameNativeMessage(
  message: NativeRequest | NativeResponse
): Uint8Array[] {
  const bytes = encodeNativeMessage(message);
  const frames: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += NATIVE_FRAME_BYTES - HEADER_BYTES
  ) {
    const part = bytes.subarray(
      offset,
      offset + NATIVE_FRAME_BYTES - HEADER_BYTES
    );
    const frame = new Uint8Array(HEADER_BYTES + part.length);
    const view = new DataView(frame.buffer);
    view.setFloat64(0, NATIVE_PROTOCOL_VERSION);
    view.setFloat64(8, message.generation);
    view.setFloat64(16, message.requestId);
    view.setUint32(24, bytes.length);
    view.setUint32(28, offset);
    frame.set(part, HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

export class NativeFrameDecoder {
  private bytes?: Uint8Array;
  private received = 0;
  private requestId = 0;

  constructor(private readonly generation: number) {
    parse(id, generation);
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
    if (!this.bytes) {
      this.bytes = new Uint8Array(total);
      this.requestId = requestId;
    }
    if (this.bytes.length !== total || this.requestId !== requestId)
      throw new NativeWorkerError("protocol");
    this.bytes.set(part, offset);
    this.received += part.length;
    if (this.received !== total) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(this.bytes)
      );
    } catch {
      throw new NativeWorkerError("protocol");
    }
    const identity = parse(z.object(envelope), decoded);
    if (
      identity.generation !== this.generation ||
      identity.requestId !== requestId
    )
      throw new NativeWorkerError("protocol");
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
  encodeNativeMessage(request);
  const overhead = encodeNativeMessage({ ...request, texts: [] }).length;
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = overhead;
  for (const text of request.texts) {
    const length = encodeNativeMessage(text).length;
    if (batch.length && size + length + 1 > NATIVE_FRAME_BYTES - HEADER_BYTES) {
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

  admit(request: NativeRequest): void {
    const snapshot = parse(NativeRequestSchema, request);
    if (request.generation !== this.generation)
      throw new NativeWorkerError("stale_generation");
    if (request.requestId <= this.highestId)
      throw new NativeWorkerError("duplicate_completion");
    if (this.pending.size >= NATIVE_QUEUE_LIMIT + 1)
      throw new NativeWorkerError("overloaded");
    encodeNativeMessage(request);
    this.highestId = request.requestId;
    this.pending.set(request.requestId, snapshot);
  }

  settle(input: unknown): NativeResponse {
    const identity = parse(z.object(envelope), input);
    if (identity.generation !== this.generation)
      throw new NativeWorkerError("stale_generation");
    const request = this.pending.get(identity.requestId);
    if (!request) throw new NativeWorkerError("duplicate_completion");
    const response = parseNativeResponse(input, request);
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
