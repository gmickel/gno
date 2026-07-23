/** Shared query-to-evidence trace lifecycle used by every application surface. */

import type { RetrievalTraceConfig } from "../config/retrieval-traces";
import type { SearchResult, SearchResults } from "../pipeline/types";
import type {
  RetrievalTraceEventKind,
  RetrievalTraceFingerprints,
  RetrievalTraceTerminalStatus,
  StorePort,
  StoreResult,
} from "../store/types";
import type { ContextCapsuleV1 } from "./context-capsule";

import {
  SEARCH_RESULT_PLANNER_METADATA,
  SEARCH_RESULTS_TRACE_METADATA,
} from "../pipeline/types";
import { err, ok } from "../store/types";
import {
  MIN_RETRIEVAL_TRACE_RECORDS,
  RetrievalTraceRecorder,
  type RetrievalTraceWriteResult,
} from "./retrieval-trace";
import {
  type RetrievalTraceEvidence,
  RetrievalTraceEvidenceOrigins,
} from "./retrieval-trace-evidence-origin";

type EvidenceEventKind = Extract<
  RetrievalTraceEventKind,
  "get" | "open" | "cite" | "pin"
>;

export interface StartRetrievalTraceSessionInput {
  store: StorePort;
  config: RetrievalTraceConfig | undefined;
  query: string;
  goal?: string;
  filters?: Record<string, unknown>;
  /**
   * Lazy by contract: disabled tracing must not perform fingerprint or index
   * work merely to discover that no receipt will be written.
   */
  fingerprints: () =>
    | RetrievalTraceFingerprints
    | Promise<RetrievalTraceFingerprints>;
  clock?: () => number;
  idFactory?: () => string;
}

export interface RetrievalTraceSurfaceMetadata {
  traceId: string;
}

export const RETRIEVAL_TRACE_METADATA = Symbol("gno.retrievalTraceMetadata");

export const attachRetrievalTraceMetadata = <T extends object>(
  value: T,
  session: RetrievalTraceSession | undefined
): T => {
  const metadata = session?.metadata();
  if (!metadata) return value;
  Object.defineProperty(value, RETRIEVAL_TRACE_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
  return value;
};

export const getRetrievalTraceMetadata = (
  value: object
): RetrievalTraceSurfaceMetadata | undefined =>
  (value as { [RETRIEVAL_TRACE_METADATA]?: RetrievalTraceSurfaceMetadata })[
    RETRIEVAL_TRACE_METADATA
  ];

const evidenceFromResult = (
  result: SearchResult,
  fallbackRank: number
): RetrievalTraceEvidence | null => {
  const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
  const sourceHash = result.source.sourceHash;
  const mirrorHash = metadata?.mirrorHash ?? result.conversion?.mirrorHash;
  const startLine = metadata?.startLine ?? result.snippetRange?.startLine;
  const endLine = metadata?.endLine ?? result.snippetRange?.endLine;
  const passageHash = metadata?.passageHash;
  if (
    !sourceHash ||
    !mirrorHash ||
    !result.uri.startsWith("gno://") ||
    startLine === undefined ||
    endLine === undefined ||
    !passageHash
  ) {
    return null;
  }
  return {
    docid: result.docid,
    sourceHash,
    mirrorHash,
    uri: result.uri,
    startLine,
    endLine,
    passageHash,
    rank: fallbackRank,
    score: result.score,
    ...(metadata?.seq === undefined ? {} : { seq: metadata.seq }),
    ...(metadata?.retrievalRank === undefined
      ? {}
      : { plannerRank: metadata.retrievalRank }),
    ...(metadata?.sources === undefined ? {} : { sources: metadata.sources }),
    ...(metadata?.graphExpanded === undefined
      ? {}
      : { graphExpanded: metadata.graphExpanded }),
  };
};

const evidenceFromCapsule = (
  capsule: ContextCapsuleV1
): RetrievalTraceEvidence[] =>
  capsule.evidence.map((item) => ({
    docid: item.docid,
    sourceHash: item.sourceHash,
    mirrorHash: item.mirrorHash,
    uri: item.uri,
    startLine: item.startLine,
    endLine: item.endLine,
    passageHash: item.passageHash,
    ...(item.selectionRank === undefined ? {} : { rank: item.selectionRank }),
    ...(item.retrievalRank === undefined
      ? {}
      : { plannerRank: item.retrievalRank }),
    ...(item.retrievalSources === undefined
      ? {}
      : { sources: item.retrievalSources }),
    ...(item.graphExpanded === undefined
      ? {}
      : { graphExpanded: item.graphExpanded }),
  }));

export class RetrievalTraceSession {
  readonly traceId: string;

  private counter = 0;
  private available = true;
  private persistedRecords = 0;
  private terminal = false;
  private retrievalRunId: string | null = null;
  private readonly evidenceOrigins = new RetrievalTraceEvidenceOrigins();

  private constructor(
    private readonly recorder: RetrievalTraceRecorder,
    traceId: string,
    private readonly clock: () => number,
    private readonly operationId = traceId,
    private readonly maxRecords = 100_000
  ) {
    this.traceId = traceId;
  }

  static async start(
    input: StartRetrievalTraceSessionInput
  ): Promise<StoreResult<RetrievalTraceSession | null>> {
    if (input.config?.enabled !== true) return ok(null);
    if (
      input.config.retention.maxRecordsPerTrace < MIN_RETRIEVAL_TRACE_RECORDS
    ) {
      return ok(null);
    }
    const rawClock = input.clock ?? Date.now;
    let lastTimestamp = -1;
    const clock = (): number => {
      const current = rawClock();
      lastTimestamp = Math.max(current, lastTimestamp + 1);
      return lastTimestamp;
    };
    const recorder = new RetrievalTraceRecorder(input.store, input.config, {
      clock,
      idFactory: input.idFactory,
    });
    const started = await recorder.start({
      query: input.query,
      goal: input.goal,
      filters: input.filters,
      fingerprints: await input.fingerprints(),
    });
    if (!started.ok) return started;
    if (!started.value.recorded) return ok(null);
    const session = new RetrievalTraceSession(
      recorder,
      started.value.traceId,
      clock,
      started.value.traceId,
      input.config.retention.maxRecordsPerTrace
    );
    const queryEvent = await session.appendEvent("query", {});
    if (queryEvent.ok) return ok(session);
    await recorder.finalize(started.value.traceId, "failed");
    return ok(null);
  }

  static async resume(input: {
    store: StorePort;
    config: RetrievalTraceConfig | undefined;
    traceId: string;
    clock?: () => number;
  }): Promise<StoreResult<RetrievalTraceSession | null>> {
    if (input.config?.enabled !== true) return ok(null);
    const stored = await input.store.getRetrievalTrace(input.traceId);
    if (!stored.ok) return stored;
    if (!stored.value) {
      return err("NOT_FOUND", `Retrieval trace ${input.traceId} was not found`);
    }
    if (stored.value.trace.status !== "open") {
      return err(
        "CONSTRAINT_VIOLATION",
        `Retrieval trace ${input.traceId} is already ${stored.value.trace.status}`
      );
    }
    const rawClock = input.clock ?? Date.now;
    let lastTimestamp = Math.max(
      stored.value.trace.updatedAtMs,
      ...stored.value.runs.map((run) => run.createdAtMs),
      ...stored.value.events.map((event) => event.createdAtMs)
    );
    const clock = (): number => {
      lastTimestamp = Math.max(rawClock(), lastTimestamp + 1);
      return lastTimestamp;
    };
    const session = new RetrievalTraceSession(
      new RetrievalTraceRecorder(input.store, input.config, { clock }),
      input.traceId,
      clock,
      crypto.randomUUID(),
      input.config.retention.maxRecordsPerTrace
    );
    session.persistedRecords =
      stored.value.runs.length +
      stored.value.events.length +
      stored.value.judgments.length +
      stored.value.exports.length;
    session.retrievalRunId =
      stored.value.runs.filter((run) => run.kind === "retrieval").at(-1)
        ?.runId ?? null;
    session.evidenceOrigins.addStoredRuns(stored.value.runs);
    return ok(session);
  }

  metadata(): RetrievalTraceSurfaceMetadata | undefined {
    return this.available ? { traceId: this.traceId } : undefined;
  }

  async recordRetrieval(
    result: SearchResults,
    latencyMs?: number
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    if (!this.hasCapacity(2)) return ok("disabled");
    const ranked = result.results.flatMap((item, index) => {
      const evidence = evidenceFromResult(item, index + 1);
      return evidence ? [evidence] : [];
    });
    const traceMetadata = result[SEARCH_RESULTS_TRACE_METADATA];
    const capabilityOutcomes =
      traceMetadata?.capabilityOutcomes ??
      (result.meta.mode === "vector"
        ? [{ capability: "semantic_search", status: "used" as const }]
        : [
            { capability: "lexical_search", status: "used" as const },
            ...(result.meta.vectorsUsed
              ? [{ capability: "semantic_search", status: "used" as const }]
              : []),
          ]);
    const capabilities = capabilityOutcomes
      .filter((outcome) => outcome.status === "used")
      .map((outcome) => outcome.capability);
    const fallbackCodes =
      traceMetadata?.fallbackCodes ??
      result.meta.graphExpansion?.fallbackReasons ??
      [];
    const payload = {
      ranked,
      capabilities,
      fallbackCodes,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
    const runId = this.nextId("retrieval-run");
    const run = await this.recorder.appendRun({
      runId,
      traceId: this.traceId,
      idempotencyKey: runId,
      kind: "retrieval",
      payload,
      createdAtMs: this.clock(),
    });
    if (!run.ok) return this.softenWriteFailure();
    this.persistedRecords += 1;
    this.retrievalRunId = runId;
    const retrievalEvent = await this.appendEvent("retrieval", payload, runId);
    if (!retrievalEvent.ok) return retrievalEvent;
    this.evidenceOrigins.add(runId, ranked);
    for (const outcome of capabilityOutcomes) {
      const recorded = await this.recordCapability(
        outcome.capability,
        outcome.status,
        outcome.reasonCode,
        runId
      );
      if (!recorded.ok) return recorded;
    }
    return retrievalEvent;
  }

  async recordContext(
    capsule: ContextCapsuleV1,
    latencyMs?: number
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    if (!this.hasCapacity(2)) return ok("disabled");
    const payload = {
      evidence: evidenceFromCapsule(capsule),
      capsuleId: capsule.capsuleId,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
    const runId = this.nextId("context-run");
    const run = await this.recorder.appendRun({
      runId,
      traceId: this.traceId,
      idempotencyKey: runId,
      kind: "context",
      payload,
      createdAtMs: this.clock(),
    });
    if (!run.ok) return this.softenWriteFailure();
    this.persistedRecords += 1;
    const appended = await this.appendEvent("context", payload, runId);
    if (appended.ok && appended.value !== "disabled") {
      this.evidenceOrigins.addFallback(runId, payload.evidence);
    }
    return appended;
  }

  async recordEvidence(
    kind: EvidenceEventKind,
    evidence: RetrievalTraceEvidence[],
    latencyMs?: number
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    const payload = {
      evidence,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
    if (kind === "get") {
      if (!this.hasCapacity(2)) return ok("disabled");
      const runId = this.nextId("get-run");
      const run = await this.recorder.appendRun({
        runId,
        traceId: this.traceId,
        idempotencyKey: runId,
        kind,
        payload,
        createdAtMs: this.clock(),
      });
      if (!run.ok) return this.softenWriteFailure();
      this.persistedRecords += 1;
      const appended = await this.appendEvent(kind, payload, runId);
      if (appended.ok && appended.value !== "disabled") {
        this.evidenceOrigins.addFallback(runId, evidence);
      }
      return appended;
    }
    if (!this.hasCapacity(1)) return ok("disabled");
    const origins = this.evidenceOrigins.group(evidence);
    if (!origins.ok) return origins;
    if (!this.hasCapacity(origins.value.size)) return ok("disabled");
    let result: "inserted" | "duplicate" | "disabled" = "inserted";
    for (const [runId, runEvidence] of origins.value) {
      const appended = await this.appendEvent(
        kind,
        {
          evidence: runEvidence,
          ...(latencyMs === undefined ? {} : { latencyMs }),
        },
        runId
      );
      if (!appended.ok) return appended;
      result = appended.value;
    }
    return ok(result);
  }

  async recordCapability(
    capability: string,
    status: "attempted" | "used" | "unavailable" | "failed",
    reasonCode?: string,
    runId = this.retrievalRunId
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    if (!this.hasCapacity(1)) return ok("disabled");
    return this.appendEvent(
      "capability",
      {
        capability,
        status,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      },
      runId
    );
  }

  async finish(
    status: RetrievalTraceTerminalStatus,
    latencyMs?: number
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    if (this.terminal) return ok("duplicate");
    const completed = await this.appendEvent("complete", {
      outcome: status,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    });
    if (!completed.ok) {
      const finalizedAfterEventFailure = await this.recorder.finalize(
        this.traceId,
        status
      );
      this.terminal = finalizedAfterEventFailure.ok;
      return ok("disabled");
    }
    if (completed.value === "disabled") return completed;
    const finalized = await this.recorder.finalize(this.traceId, status);
    if (finalized.ok) this.terminal = true;
    return finalized;
  }

  private async appendEvent(
    kind: RetrievalTraceEventKind,
    payload: Record<string, unknown>,
    runId: string | null = null
  ): Promise<StoreResult<"inserted" | "duplicate" | "disabled">> {
    const eventId = this.nextId(kind);
    const appended = await this.recorder.appendEvent({
      eventId,
      traceId: this.traceId,
      runId,
      idempotencyKey: eventId,
      kind,
      payload,
      createdAtMs: this.clock(),
    });
    if (!appended.ok) return this.softenWriteFailure();
    this.persistedRecords += 1;
    return appended;
  }

  private hasCapacity(records: number): boolean {
    return this.persistedRecords + records + 1 <= this.maxRecords;
  }

  private async softenWriteFailure(): Promise<
    StoreResult<"inserted" | "duplicate" | "disabled">
  > {
    await this.recorder.finalize(this.traceId, "failed");
    this.available = false;
    this.terminal = true;
    return ok("disabled");
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `${this.operationId}:${kind}:${this.counter}`;
  }
}

export type { RetrievalTraceWriteResult };
export type { RetrievalTraceEvidence };

export const evidenceFromExactDocument = (input: {
  docid: string;
  uri: string;
  sourceHash?: string;
  mirrorHash?: string;
  content: string;
  startLine: number;
  endLine: number;
  seq?: number;
}): RetrievalTraceEvidence | null => {
  if (
    !input.sourceHash ||
    !input.mirrorHash ||
    !input.uri.startsWith("gno://") ||
    !input.content ||
    input.startLine < 1 ||
    input.endLine < input.startLine ||
    input.content.split("\n").length !== input.endLine - input.startLine + 1
  ) {
    return null;
  }
  return {
    docid: input.docid,
    uri: input.uri,
    sourceHash: input.sourceHash,
    mirrorHash: input.mirrorHash,
    startLine: input.startLine,
    endLine: input.endLine,
    passageHash: new Bun.CryptoHasher("sha256")
      .update(input.content)
      .digest("hex"),
    ...(input.seq === undefined ? {} : { seq: input.seq }),
  };
};
