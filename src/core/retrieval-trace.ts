/** Opt-in, local-only retrieval trace recording with privacy projections. */

import { z } from "zod";

import type {
  RetrievalTraceConfig,
  RetrievalTraceRedactionMode,
} from "../config/retrieval-traces";
import type {
  RetrievalTraceAppendResult,
  RetrievalTraceEventInput,
  RetrievalTraceFingerprints,
  RetrievalTraceJudgmentInput,
  RetrievalTraceRunInput,
  RetrievalTraceTerminalStatus,
  StorePort,
  StoreResult,
} from "../store/types";

import {
  parseRetrievalTraceEventInput,
  parseRetrievalTraceJudgmentInput,
  parseRetrievalTraceRunInput,
} from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gnoUriSchema = z
  .string()
  .max(4096)
  .refine((value) => value.startsWith("gno://"), {
    message: "Evidence URI must use the canonical gno:// reader identity",
  });
const queryModeSchema = z
  .object({
    mode: z.enum(["term", "intent", "hyde"]),
    text: z.string().max(8192),
  })
  .strict();
const traceFiltersSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    minScore: z.number().min(0).max(1).optional(),
    collection: z.string().max(256).optional(),
    collections: z.array(z.string().min(1).max(256)).max(1000).optional(),
    lang: z.string().max(64).optional(),
    full: z.boolean().optional(),
    lineNumbers: z.boolean().optional(),
    tagsAll: z.array(z.string().max(512)).max(1000).optional(),
    tagsAny: z.array(z.string().max(512)).max(1000).optional(),
    since: z.string().max(128).optional(),
    until: z.string().max(128).optional(),
    categories: z.array(z.string().max(512)).max(1000).optional(),
    author: z.string().max(1024).optional(),
    intent: z.string().max(8192).optional(),
    exclude: z.array(z.string().max(1024)).max(1000).optional(),
    noExpand: z.boolean().optional(),
    noRerank: z.boolean().optional(),
    candidateLimit: z.number().int().positive().optional(),
    explain: z.boolean().optional(),
    graph: z.boolean().optional(),
    noGraph: z.boolean().optional(),
    queryLanguageHint: z.string().max(64).optional(),
    queryModes: z.array(queryModeSchema).max(100).optional(),
    uriPrefix: z.string().max(4096).optional(),
  })
  .strict();
const startTraceSchema = z
  .object({
    traceId: z.string().min(1).max(128).optional(),
    query: z.string().min(1).max(8192),
    goal: z.string().max(8192).optional(),
    filters: traceFiltersSchema.default({}),
    fingerprints: z
      .object({
        pipeline: sha256Schema,
        model: sha256Schema,
        config: sha256Schema,
        index: sha256Schema,
      })
      .strict(),
  })
  .strict();

const evidenceRefBaseSchema = z
  .object({
    docid: z.string().min(1).max(256).optional(),
    sourceHash: sha256Schema.optional(),
    mirrorHash: sha256Schema.optional(),
    uri: gnoUriSchema.optional(),
    seq: z.number().int().nonnegative().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    score: z.number().finite().optional(),
    rank: z.number().int().positive().optional(),
    plannerRank: z.number().int().positive().optional(),
    passageHash: sha256Schema.optional(),
    sources: z.array(z.string().min(1).max(128)).max(16).optional(),
    graphExpanded: z.boolean().optional(),
  })
  .strict();
const refineEvidenceRef = (
  value: z.infer<typeof evidenceRefBaseSchema>,
  context: z.RefinementCtx
): void => {
  if (!(value.docid || value.sourceHash || value.mirrorHash || value.uri)) {
    context.addIssue({
      code: "custom",
      message: "Evidence references require a stable document identity",
    });
  }
  if ((value.startLine === undefined) !== (value.endLine === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Evidence line ranges require both startLine and endLine",
    });
  }
  if (
    value.startLine !== undefined &&
    value.endLine !== undefined &&
    value.startLine > value.endLine
  ) {
    context.addIssue({
      code: "custom",
      path: ["endLine"],
      message: "Evidence endLine must not precede startLine",
    });
  }
};
const evidenceRefSchema = evidenceRefBaseSchema.superRefine(refineEvidenceRef);
const evidencePayloadSchema = z
  .object({
    evidence: z.array(evidenceRefSchema).max(10_000),
    latencyMs: z.number().finite().nonnegative().optional(),
  })
  .strict();
const retrievalPayloadSchema = z
  .object({
    ranked: z.array(evidenceRefSchema).max(10_000),
    latencyMs: z.number().finite().nonnegative().optional(),
    capabilities: z.array(z.string().min(1).max(128)).max(100).optional(),
    fallbackCodes: z.array(z.string().min(1).max(128)).max(100).optional(),
  })
  .strict();
const contextPayloadSchema = evidencePayloadSchema.extend({
  capsuleId: z.string().min(1).max(256),
});
const runPayloadSchemas = {
  retrieval: retrievalPayloadSchema,
  context: contextPayloadSchema,
  get: evidencePayloadSchema,
} as const;
const eventPayloadSchemas = {
  query: z.object({ filterFingerprint: sha256Schema.optional() }).strict(),
  retrieval: retrievalPayloadSchema,
  context: contextPayloadSchema,
  get: evidencePayloadSchema,
  open: evidencePayloadSchema,
  cite: evidencePayloadSchema,
  pin: evidencePayloadSchema,
  capability: z
    .object({
      capability: z.string().min(1).max(128),
      status: z.enum(["attempted", "used", "unavailable", "failed"]),
      reasonCode: z.string().min(1).max(128).optional(),
    })
    .strict(),
  complete: z
    .object({
      outcome: z.enum(["completed", "partial", "failed", "cancelled"]),
      latencyMs: z.number().finite().nonnegative().optional(),
    })
    .strict(),
} as const;
const judgmentTargetSchema = evidenceRefBaseSchema
  .omit({
    score: true,
    rank: true,
  })
  .superRefine(refineEvidenceRef);

export interface StartRetrievalTraceInput {
  traceId?: string;
  query: string;
  goal?: string;
  filters?: z.input<typeof traceFiltersSchema>;
  fingerprints: RetrievalTraceFingerprints;
}

export type RetrievalTraceWriteResult =
  | {
      recorded: false;
      traceId: null;
      replayCapable: false;
      result: "disabled";
    }
  | {
      recorded: true;
      traceId: string;
      replayCapable: boolean;
      result: RetrievalTraceAppendResult;
    };

interface RetrievalTraceRecorderDeps {
  clock?: () => number;
  idFactory?: () => string;
  /** Stable local secret loaded by the caller; required for metadata labels. */
  redactionSecret?: string;
}

/** Query + retrieval run + retrieval event + terminal event. */
export const MIN_RETRIEVAL_TRACE_RECORDS = 4;

const normalizeText = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");

const textShape = (value: string | undefined) => {
  const normalized = normalizeText(value ?? "");
  return {
    characters: Array.from(normalized).length,
    terms: normalized.trim() ? normalized.trim().split(/\s+/u).length : 0,
  };
};

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const valueShape = (value: unknown): unknown => {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const itemTypes = [
      ...new Set(
        value.map((item) =>
          item === null ? "null" : Array.isArray(item) ? "array" : typeof item
        )
      ),
    ].sort();
    return { type: "array", count: value.length, itemTypes };
  }
  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      fields[key] = valueShape((value as Record<string, unknown>)[key]);
    }
    return { type: "object", fields };
  }
  return { type: typeof value };
};

const projectMetadataObject = (
  value: Record<string, unknown>
): Record<string, unknown> => ({ shape: valueShape(value) });

const projectPayload = (
  _mode: RetrievalTraceRedactionMode,
  value: Record<string, unknown>
): Record<string, unknown> => value;

export class RetrievalTraceRecorder {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly redactionSecret: string | undefined;

  constructor(
    private readonly store: StorePort,
    private readonly config: RetrievalTraceConfig | undefined,
    deps: RetrievalTraceRecorderDeps = {}
  ) {
    this.clock = deps.clock ?? Date.now;
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID());
    this.redactionSecret = deps.redactionSecret;
  }

  isEnabled(): boolean {
    return this.config?.enabled === true;
  }

  async start(
    input: StartRetrievalTraceInput
  ): Promise<StoreResult<RetrievalTraceWriteResult>> {
    if (
      !this.config?.enabled ||
      this.config.retention.maxRecordsPerTrace < MIN_RETRIEVAL_TRACE_RECORDS
    ) {
      return ok({
        recorded: false,
        traceId: null,
        replayCapable: false,
        result: "disabled",
      });
    }
    const parsed = startTraceSchema.safeParse(input);
    if (!parsed.success) {
      return err("INVALID_INPUT", parsed.error.message, parsed.error);
    }
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      return err("INVALID_INPUT", "Trace clock must return epoch milliseconds");
    }
    const traceId = parsed.data.traceId ?? this.idFactory();
    const query = normalizeText(parsed.data.query);
    const goal =
      parsed.data.goal === undefined
        ? undefined
        : normalizeText(parsed.data.goal);
    const replay = this.config.redactionMode === "replay";
    const create = await this.store.createRetrievalTrace({
      traceId,
      schemaVersion: "1.0",
      redactionMode: this.config.redactionMode,
      replayCapable: replay,
      queryText: replay ? query : null,
      queryDigest: replay ? sha256(query) : null,
      queryShape: textShape(query),
      goalText: replay ? (goal ?? null) : null,
      goalDigest: replay && goal !== undefined ? sha256(goal) : null,
      goalShape: textShape(goal),
      filters: replay
        ? parsed.data.filters
        : projectMetadataObject(parsed.data.filters),
      fingerprints: parsed.data.fingerprints,
      status: "open",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.config.retention.maxAgeDays * 86_400_000,
    });
    if (!create.ok) return create;
    const retention = await this.store.enforceRetrievalTraceRetention(
      this.config.retention,
      nowMs
    );
    if (!retention.ok) return retention;
    const retained = await this.store.getRetrievalTrace(traceId);
    if (!retained.ok) return retained;
    if (!retained.value) {
      return err(
        "CONSTRAINT_VIOLATION",
        `Retrieval trace ${traceId} exceeded retention limits and was evicted`
      );
    }
    return ok({
      recorded: true,
      traceId,
      replayCapable: replay,
      result: create.value,
    });
  }

  async appendRun(
    input: RetrievalTraceRunInput
  ): Promise<StoreResult<RetrievalTraceAppendResult | "disabled">> {
    if (!this.config?.enabled) return ok("disabled");
    const payload = runPayloadSchemas[input.kind]?.safeParse(input.payload);
    if (!payload?.success) {
      return err(
        "INVALID_INPUT",
        payload?.error.message ?? `Unknown retrieval run kind: ${input.kind}`
      );
    }
    try {
      const parsed = parseRetrievalTraceRunInput({
        ...input,
        payload: projectPayload(this.config.redactionMode, payload.data),
      });
      return await this.enforceAfterWrite(
        input.traceId,
        await this.store.appendRetrievalTraceRun(parsed)
      );
    } catch (cause) {
      return invalidTraceInput(cause, "Invalid retrieval trace run");
    }
  }

  async appendEvent(
    input: RetrievalTraceEventInput
  ): Promise<StoreResult<RetrievalTraceAppendResult | "disabled">> {
    if (!this.config?.enabled) return ok("disabled");
    const payload = eventPayloadSchemas[input.kind]?.safeParse(input.payload);
    if (!payload?.success) {
      return err(
        "INVALID_INPUT",
        payload?.error.message ?? `Unknown retrieval event kind: ${input.kind}`
      );
    }
    try {
      const parsed = parseRetrievalTraceEventInput({
        ...input,
        payload: projectPayload(this.config.redactionMode, payload.data),
      });
      return await this.enforceAfterWrite(
        input.traceId,
        await this.store.appendRetrievalTraceEvent(parsed)
      );
    } catch (cause) {
      return invalidTraceInput(cause, "Invalid retrieval trace event");
    }
  }

  async appendJudgment(
    input: RetrievalTraceJudgmentInput
  ): Promise<StoreResult<RetrievalTraceAppendResult | "disabled">> {
    if (!this.config?.enabled) return ok("disabled");
    const target = judgmentTargetSchema.safeParse(input.target);
    if (!target.success) {
      return err("INVALID_INPUT", target.error.message, target.error);
    }
    const metadata = this.config.redactionMode === "metadata";
    if (metadata && !this.redactionSecret) {
      return err(
        "INVALID_INPUT",
        "Metadata judgments require a stable local redaction secret"
      );
    }
    try {
      const parsed = parseRetrievalTraceJudgmentInput({
        ...input,
        targetRef: metadata
          ? `redacted:${sha256(`${this.redactionSecret}\0${input.targetRef}`)}`
          : input.targetRef,
        target: projectPayload(this.config.redactionMode, target.data),
      });
      return await this.enforceAfterWrite(
        input.traceId,
        await this.store.appendRetrievalTraceJudgment(parsed)
      );
    } catch (cause) {
      return invalidTraceInput(cause, "Invalid retrieval trace judgment");
    }
  }

  async finalize(
    traceId: string,
    status: RetrievalTraceTerminalStatus
  ): Promise<StoreResult<RetrievalTraceAppendResult | "disabled">> {
    if (!this.config?.enabled) return ok("disabled");
    return await this.enforceAfterWrite(
      traceId,
      await this.store.finalizeRetrievalTrace(traceId, status, this.clock())
    );
  }

  private async enforceAfterWrite(
    traceId: string,
    result: StoreResult<RetrievalTraceAppendResult>
  ): Promise<StoreResult<RetrievalTraceAppendResult>> {
    if (!result.ok || !this.config?.enabled) return result;
    const retained = await this.store.enforceRetrievalTraceRetention(
      this.config.retention,
      this.clock()
    );
    if (!retained.ok) return retained;
    const stored = await this.store.getRetrievalTrace(traceId);
    if (!stored.ok) return stored;
    if (!stored.value) {
      return err(
        "CONSTRAINT_VIOLATION",
        `Retrieval trace ${traceId} exceeded retention limits and was evicted`
      );
    }
    return result;
  }
}

const invalidTraceInput = <T>(
  cause: unknown,
  fallback: string
): StoreResult<T> =>
  err(
    "INVALID_INPUT",
    cause instanceof Error ? cause.message : fallback,
    cause
  );
