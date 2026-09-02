/**
 * Transport-neutral memory service: `remember()` and `recall()`.
 *
 * Every surface (CLI, MCP, REST, SDK) is a thin adapter over this module.
 * The service owns the shared write lease for every write path; adapters
 * never take `.mcp-write.lock` themselves (single acquisition point, no
 * nesting — a caller that already holds the lease deadlocks/fails fast).
 *
 * Fencing limits (documented contract): the fence rejects (a) input whose
 * normalized-text hash matches a span hash on a presented recall receipt and
 * (b) input declaring `derivedFrom` gno:// origins. A paraphrase of recalled
 * text that carries neither is indistinguishable from an original fact and
 * cannot be fenced.
 *
 * @module src/core/memory
 */

// node:fs/promises for mkdir (no Bun equivalent for recursive dir creation)
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { dirname, join } from "node:path";

import type { Collection, Config } from "../config/types";
import type { EmbeddingPort } from "../llm/types";
import type { SearchResult } from "../pipeline/types";
import type { DocumentRow, FtsResult, StorePort } from "../store/types";
import type { VectorIndexPort } from "../store/vector/types";
import type { EgressLineage } from "./egress-provenance";

import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { searchBm25 } from "../pipeline/search";
import { searchVectorWithEmbedding } from "../pipeline/vsearch";
import { selectContextEvidence } from "./context-budget";
import { mergeEgressLineages } from "./egress-provenance";
import { withWriteLock } from "./file-lock";
import { atomicCreate } from "./file-ops";
import {
  buildMemoryRecordId,
  buildMemoryRecordRelPath,
  hashMemoryText,
  invalidMemoryScopeReason,
  MEMORY_MAX_FACT_BYTES,
  MEMORY_MAX_SCOPES,
  MEMORY_SUPERSEDES_EDGE,
  memoryCosine,
  memoryJaccard,
  normalizeMemoryScopes,
  normalizeMemoryText,
  serializeMemoryRecord,
  validateMemoryRecord,
  type MemoryRecordFrontmatter,
} from "./memory-record";

// ─────────────────────────────────────────────────────────────────────────────
// Binding defaults (tunable here, documented in docs/MEMORY.md)
// ─────────────────────────────────────────────────────────────────────────────

/** BM25 candidate pool size for remember() candidate matching. */
export const MEMORY_CANDIDATE_POOL = 16;
/** Cosine threshold for a semantic likely-match. */
export const MEMORY_SEMANTIC_LIKELY_THRESHOLD = 0.83;
/** Normalized-token Jaccard threshold for a lexical likely-match. */
export const MEMORY_LEXICAL_LIKELY_THRESHOLD = 0.5;
/** Default recall budget. */
export const MEMORY_RECALL_MAX_FACTS = 8;
export const MEMORY_RECALL_MAX_TOKENS = 512;
/** Retrieval depth per leg before fusion and budgeting. */
const RECALL_RETRIEVAL_LIMIT = 32;
const RRF_K = 60;
const DEFAULT_LOCK_WAIT_MS = 120_000;
const TOKEN_BYTES_ESTIMATE = 4;

export const MEMORY_EMPTY_RECALL_HINT =
  'No memories in scope yet. Store one with: gno remember "<fact>" --scope <scope> --decision add';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryErrorCode =
  | "MEMORY_TEXT_REQUIRED"
  | "MEMORY_TEXT_TOO_LARGE"
  | "MEMORY_QUERY_REQUIRED"
  | "MEMORY_COLLECTION_REQUIRED"
  | "MEMORY_COLLECTION_NOT_FOUND"
  | "MEMORY_COLLECTION_UNMANAGED"
  | "MEMORY_SCOPES_REQUIRED"
  | "MEMORY_SCOPES_INVALID"
  | "MEMORY_IDENTITY_REQUIRED"
  | "MEMORY_DECISION_INVALID"
  | "MEMORY_PREDECESSOR_REQUIRED"
  | "MEMORY_PREDECESSOR_NOT_FOUND"
  | "MEMORY_PREDECESSOR_HASH_MISMATCH"
  | "MEMORY_SUPERSEDE_CONFLICT"
  | "MEMORY_FENCED_REPLAY"
  | "MEMORY_FENCED_DERIVED"
  | "MEMORY_WRITE_LEASE_BUSY"
  | "MEMORY_SYNC_FAILED"
  | "MEMORY_QUERY_FAILED";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryIdentity {
  caller: string;
  session: string;
}

/** Content-free receipt bound to caller + session; travels with recall. */
export interface MemoryRecallReceipt extends MemoryIdentity {
  issuedAt: string;
  memoryIds: string[];
  spanHashes: string[];
  digest: string;
}

export type MemoryDecision = "add" | "supersede";

export interface RememberInput extends MemoryIdentity {
  text: string;
  collection: string;
  scopes: string[];
  /** Absent → candidate proposal only (writes nothing). */
  decision?: MemoryDecision;
  predecessorUri?: string;
  predecessorHash?: string;
  receipt?: MemoryRecallReceipt;
  /** Declared origins; any gno:// origin is fenced. */
  derivedFrom?: string[];
  source?: string;
}

export interface MemoryFact {
  uri: string;
  docid: string;
  recordId: string;
  text: string;
  scopes: string[];
  caller: string;
  session: string;
  createdAt: string;
  contentHash: string;
  supersedes: string[];
}

export type MemoryCandidateMatch = "exact" | "likely" | "weak";

export interface MemoryCandidate extends MemoryFact {
  similarity: number;
  match: MemoryCandidateMatch;
}

export type MemoryMatchMode = "semantic" | "lexical";

export interface MemoryMatchDiagnostics {
  mode: MemoryMatchMode;
  /** Present when semantic matching was unavailable and lexical was used. */
  semanticUnavailable?: string;
  threshold: number;
}

export interface MemorySyncState {
  status: "completed" | "failed";
  error?: string;
}

export type RememberResult =
  | {
      outcome: "existing";
      record: MemoryFact;
      matching: MemoryMatchDiagnostics;
    }
  | {
      outcome: "candidates";
      candidates: MemoryCandidate[];
      matching: MemoryMatchDiagnostics;
    }
  | {
      outcome: "added" | "superseded";
      record: MemoryFact;
      absPath: string;
      sync: MemorySyncState;
      matching: MemoryMatchDiagnostics;
    };

export interface RecallInput extends MemoryIdentity {
  query: string;
  collection: string;
  scopes: string[];
  maxFacts?: number;
  maxTokens?: number;
}

export interface RecalledFact extends MemoryFact {
  score: number;
  spanHash: string;
  egressLineage: EgressLineage;
}

export interface RecallResult {
  facts: RecalledFact[];
  receipt: MemoryRecallReceipt;
  budget: {
    maxFacts: number;
    maxTokens: number;
    usedTokens: number;
    omitted: number;
  };
  retrieval: {
    mode: "hybrid" | "lexical";
    semanticUnavailable?: string;
  };
  /** Strictest source policy across every returned fact (absent when empty). */
  egressLineage?: EgressLineage;
  /** Self-teaching line, present only when no fact was returned. */
  hint?: string;
}

export interface MemoryServiceDeps {
  store: StorePort;
  config: Config;
  collections: readonly Collection[];
  /** Absolute `.mcp-write.lock` path (shared write lease namespace). */
  lockPath: string;
  lockWaitMs?: number;
  embedPort?: EmbeddingPort | null;
  vectorIndex?: VectorIndexPort | null;
  syncService?: Pick<typeof defaultSyncService, "syncFiles">;
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / TOKEN_BYTES_ESTIMATE);
}

function requireIdentity(input: MemoryIdentity): MemoryIdentity {
  const caller = input.caller?.trim();
  const session = input.session?.trim();
  if (!caller || !session) {
    throw new MemoryError(
      "MEMORY_IDENTITY_REQUIRED",
      "caller and session identity are required on every remember/recall call (receipts bind to them)."
    );
  }
  return { caller, session };
}

function requireScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) {
    throw new MemoryError(
      "MEMORY_SCOPES_REQUIRED",
      "Explicit scopes are required; there is no implicit global scope."
    );
  }
  const normalized = normalizeMemoryScopes(scopes as string[]);
  if (normalized.length === 0) {
    throw new MemoryError(
      "MEMORY_SCOPES_REQUIRED",
      "Explicit scopes are required; there is no implicit global scope."
    );
  }
  if (normalized.length > MEMORY_MAX_SCOPES) {
    throw new MemoryError(
      "MEMORY_SCOPES_INVALID",
      `At most ${MEMORY_MAX_SCOPES} scopes per call.`
    );
  }
  for (const scope of normalized) {
    const reason = invalidMemoryScopeReason(scope);
    if (reason) throw new MemoryError("MEMORY_SCOPES_INVALID", reason);
  }
  return normalized;
}

function requireManagedCollection(
  collections: readonly Collection[],
  name: string | undefined
): Collection {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) {
    throw new MemoryError(
      "MEMORY_COLLECTION_REQUIRED",
      "A memory collection is required."
    );
  }
  const collection = collections.find(
    (candidate) => candidate.name.toLowerCase() === wanted
  );
  if (!collection) {
    throw new MemoryError(
      "MEMORY_COLLECTION_NOT_FOUND",
      `Collection not found: ${wanted}`
    );
  }
  if (collection.memoryManaged !== true) {
    throw new MemoryError(
      "MEMORY_COLLECTION_UNMANAGED",
      `Collection "${collection.name}" is not memory-managed. Set memoryManaged: true on it in the config to allow remember/recall; other collections stay read-only for memory.`
    );
  }
  return collection;
}

function requireFactText(text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new MemoryError("MEMORY_TEXT_REQUIRED", "Fact text is required.");
  }
  if (text.includes("\0")) {
    throw new MemoryError(
      "MEMORY_TEXT_REQUIRED",
      "Fact text must be text, not binary-like data."
    );
  }
  if (utf8Bytes(text) > MEMORY_MAX_FACT_BYTES) {
    throw new MemoryError(
      "MEMORY_TEXT_TOO_LARGE",
      `Fact text exceeds ${MEMORY_MAX_FACT_BYTES} bytes; remember stores single facts, not documents (use gno capture).`
    );
  }
  return text.trim();
}

function requireDecision(decision: unknown): MemoryDecision | undefined {
  if (decision === undefined || decision === null) return undefined;
  if (decision === "add" || decision === "supersede") return decision;
  throw new MemoryError(
    "MEMORY_DECISION_INVALID",
    'decision must be omitted, "add", or "supersede".'
  );
}

function applyFence(input: RememberInput, spanHash: string): void {
  if (input.receipt?.spanHashes?.includes(spanHash)) {
    throw new MemoryError(
      "MEMORY_FENCED_REPLAY",
      "Rejected: this text replays a span from the presented recall receipt. Recalled memories are context, not new facts."
    );
  }
  const derived = (input.derivedFrom ?? []).filter((origin) =>
    origin.trim().startsWith("gno://")
  );
  if (derived.length > 0) {
    throw new MemoryError(
      "MEMORY_FENCED_DERIVED",
      `Rejected: input declares GNO-derived origin (${derived.join(", ")}). Facts derived from GNO's own output are not stored.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Record materialization
// ─────────────────────────────────────────────────────────────────────────────

async function readFact(
  store: StorePort,
  doc: Pick<DocumentRow, "uri" | "docid" | "mirrorHash">
): Promise<MemoryFact | null> {
  if (!doc.mirrorHash) return null;
  const content = await store.getContent(doc.mirrorHash);
  if (!content.ok || content.value === null) return null;
  const validation = validateMemoryRecord(content.value);
  if (!validation.ok) return null;
  const { frontmatter, supersedes, text } = validation.record;
  return {
    uri: doc.uri,
    docid: doc.docid,
    recordId: frontmatter.recordId,
    text,
    scopes: frontmatter.scopes,
    caller: frontmatter.caller,
    session: frontmatter.session,
    createdAt: frontmatter.createdAt,
    contentHash: frontmatter.contentHash,
    supersedes,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryService {
  private readonly deps: MemoryServiceDeps;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get lockWaitMs(): number {
    return this.deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  }

  /**
   * Candidate pool: BM25 top-16 (any-term) within the scope intersection,
   * current facts only. Similarity by cosine when semantic is ready, else by
   * normalized-token Jaccard. Ordered by similarity desc, ties by recordId.
   */
  async findCandidates(input: {
    text: string;
    collection: string;
    scopes: string[];
  }): Promise<{
    candidates: MemoryCandidate[];
    matching: MemoryMatchDiagnostics;
  }> {
    const { store } = this.deps;
    const normalizedText = normalizeMemoryText(input.text);
    const ftsResult = await store.searchFts(normalizedText, {
      limit: MEMORY_CANDIDATE_POOL,
      collection: input.collection,
      memoryScopesAny: input.scopes,
      excludeSuperseded: true,
      anyTerm: true,
      snippet: false,
    });
    // INVALID_INPUT means the text has no searchable terms: an empty pool.
    if (!ftsResult.ok && ftsResult.error.code !== "INVALID_INPUT") {
      throw new MemoryError("MEMORY_QUERY_FAILED", ftsResult.error.message);
    }
    const rows: FtsResult[] = ftsResult.ok ? ftsResult.value : [];
    const seen = new Set<string>();
    const facts: MemoryFact[] = [];
    for (const row of rows) {
      if (!row.uri || !row.docid || seen.has(row.uri)) continue;
      seen.add(row.uri);
      const fact = await readFact(store, {
        uri: row.uri,
        docid: row.docid,
        mirrorHash: row.mirrorHash,
      });
      if (fact) facts.push(fact);
    }

    const incomingHash = hashMemoryText(input.text);
    let matching: MemoryMatchDiagnostics = {
      mode: "lexical",
      threshold: MEMORY_LEXICAL_LIKELY_THRESHOLD,
    };
    let similarities: number[] | null = null;
    const embedPort = this.deps.embedPort ?? null;
    if (embedPort && facts.length > 0) {
      const embedded = await embedPort.embedBatch([
        normalizedText,
        ...facts.map((fact) => normalizeMemoryText(fact.text)),
      ]);
      if (embedded.ok && embedded.value.length === facts.length + 1) {
        const [query, ...vectors] = embedded.value;
        similarities = vectors.map((vector) =>
          memoryCosine(query ?? [], vector)
        );
        matching = {
          mode: "semantic",
          threshold: MEMORY_SEMANTIC_LIKELY_THRESHOLD,
        };
      } else {
        matching.semanticUnavailable = embedded.ok
          ? "embedding batch returned an unexpected shape"
          : embedded.error.message;
      }
    } else if (!embedPort) {
      matching.semanticUnavailable = "no embedding model available";
    }

    const candidates: MemoryCandidate[] = facts.map((fact, index) => {
      const exact = fact.contentHash === incomingHash;
      const similarity = exact
        ? 1
        : (similarities?.[index] ?? memoryJaccard(input.text, fact.text));
      const match: MemoryCandidateMatch = exact
        ? "exact"
        : similarity >= matching.threshold
          ? "likely"
          : "weak";
      return { ...fact, similarity, match };
    });
    candidates.sort(
      (left, right) =>
        right.similarity - left.similarity ||
        compareCodeUnits(left.recordId, right.recordId)
    );
    return { candidates, matching };
  }

  async remember(rawInput: RememberInput): Promise<RememberResult> {
    const { store, collections, config } = this.deps;
    const identity = requireIdentity(rawInput);
    const text = requireFactText(rawInput.text);
    const collection = requireManagedCollection(
      collections,
      rawInput.collection
    );
    const scopes = requireScopes(rawInput.scopes);
    const decision = requireDecision(rawInput.decision);
    const contentHash = hashMemoryText(text);
    applyFence(rawInput, contentHash);

    if (decision === "supersede") {
      if (!rawInput.predecessorUri?.trim() || !rawInput.predecessorHash) {
        throw new MemoryError(
          "MEMORY_PREDECESSOR_REQUIRED",
          "supersede requires predecessorUri and predecessorHash."
        );
      }
    }

    const { candidates, matching } = await this.findCandidates({
      text,
      collection: collection.name,
      scopes,
    });
    const exact = candidates.find((candidate) => candidate.match === "exact");
    if (exact && decision !== "supersede") {
      const { similarity: _similarity, match: _match, ...record } = exact;
      return { outcome: "existing", record, matching };
    }
    if (decision === undefined) {
      return { outcome: "candidates", candidates, matching };
    }

    const createdAt = this.now().toISOString();
    const frontmatter: MemoryRecordFrontmatter = {
      recordId: buildMemoryRecordId({
        contentHash,
        createdAt,
        caller: identity.caller,
        session: identity.session,
      }),
      scopes,
      caller: identity.caller,
      session: identity.session,
      createdAt,
      contentHash,
    };
    const relPath = buildMemoryRecordRelPath(frontmatter);
    const absPath = join(collection.path, relPath);

    let leased: RememberResult;
    try {
      leased = await withWriteLock(
        this.deps.lockPath,
        async () => {
          const supersedes: string[] = [];
          if (decision === "supersede") {
            supersedes.push(
              await this.verifyPredecessor(
                collection.name,
                rawInput.predecessorUri as string,
                rawInput.predecessorHash as string
              )
            );
          }
          await mkdir(dirname(absPath), { recursive: true });
          await atomicCreate(
            absPath,
            serializeMemoryRecord({ frontmatter, supersedes, text })
          );
          const syncResults = await (
            this.deps.syncService ?? defaultSyncService
          ).syncFiles(
            collection,
            store,
            [relPath],
            withContentTypeRules(
              { runUpdateCmd: false, gitPull: false },
              config
            )
          );
          const syncResult = syncResults[0];
          const doc = await store.getDocument(collection.name, relPath);
          const sync: MemorySyncState =
            syncResult?.status === "error" || !doc.ok || doc.value === null
              ? {
                  status: "failed",
                  error:
                    syncResult?.errorMessage ??
                    syncResult?.errorCode ??
                    "memory record was written but is not retrievable yet",
                }
              : { status: "completed" };
          if (sync.status === "failed") {
            throw new MemoryError(
              "MEMORY_SYNC_FAILED",
              `Memory record written to ${absPath} but lexical sync failed: ${sync.error}. Run gno update to retry indexing.`
            );
          }
          const record: MemoryFact = {
            uri: (doc as { value: DocumentRow }).value.uri,
            docid: (doc as { value: DocumentRow }).value.docid,
            recordId: frontmatter.recordId,
            text,
            scopes,
            caller: identity.caller,
            session: identity.session,
            createdAt,
            contentHash,
            supersedes,
          };
          return {
            outcome: decision === "supersede" ? "superseded" : "added",
            record,
            absPath,
            sync,
            matching,
          };
        },
        this.lockWaitMs
      );
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("LOCKED")) {
        throw new MemoryError(
          "MEMORY_WRITE_LEASE_BUSY",
          `Could not acquire the shared write lease at ${this.deps.lockPath} within ${this.lockWaitMs}ms: another write holds it. The memory service takes the lease itself; callers must not pre-hold it.`
        );
      }
      throw error;
    }
    return leased;
  }

  /** Under the lease: predecessor exists, hash matches, no successor yet. */
  private async verifyPredecessor(
    collection: string,
    predecessorUri: string,
    predecessorHash: string
  ): Promise<string> {
    const { store } = this.deps;
    const docResult = await store.getDocumentByUri(predecessorUri.trim());
    if (!docResult.ok) {
      throw new MemoryError("MEMORY_QUERY_FAILED", docResult.error.message);
    }
    const doc = docResult.value;
    if (!doc || !doc.active || doc.collection !== collection) {
      throw new MemoryError(
        "MEMORY_PREDECESSOR_NOT_FOUND",
        `Predecessor ${predecessorUri} is not a current record in collection "${collection}".`
      );
    }
    const predecessor = await readFact(store, doc);
    if (!predecessor) {
      throw new MemoryError(
        "MEMORY_PREDECESSOR_NOT_FOUND",
        `Predecessor ${predecessorUri} is not a valid managed memory record.`
      );
    }
    if (predecessor.contentHash !== predecessorHash) {
      throw new MemoryError(
        "MEMORY_PREDECESSOR_HASH_MISMATCH",
        `Predecessor ${predecessorUri} has content hash ${predecessor.contentHash}, not ${predecessorHash}. Recall it again before superseding.`
      );
    }
    const successors = await store.getEdgeBacklinksForDoc(doc.id, {
      edgeType: MEMORY_SUPERSEDES_EDGE,
    });
    if (!successors.ok) {
      throw new MemoryError("MEMORY_QUERY_FAILED", successors.error.message);
    }
    if (successors.value.length > 0) {
      const successor = successors.value[0];
      throw new MemoryError(
        "MEMORY_SUPERSEDE_CONFLICT",
        `Predecessor ${predecessorUri} was already superseded by ${successor?.sourceUri ?? "another record"}. Recall the current fact and decide again.`
      );
    }
    return doc.uri;
  }

  async recall(rawInput: RecallInput): Promise<RecallResult> {
    const { store, collections, config } = this.deps;
    const identity = requireIdentity(rawInput);
    const query = rawInput.query?.trim();
    if (!query) {
      throw new MemoryError("MEMORY_QUERY_REQUIRED", "A query is required.");
    }
    const collection = requireManagedCollection(
      collections,
      rawInput.collection
    );
    const scopes = requireScopes(rawInput.scopes);
    const maxFacts = rawInput.maxFacts ?? MEMORY_RECALL_MAX_FACTS;
    const maxTokens = rawInput.maxTokens ?? MEMORY_RECALL_MAX_TOKENS;
    if (
      !Number.isSafeInteger(maxFacts) ||
      maxFacts < 1 ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 1
    ) {
      throw new MemoryError(
        "MEMORY_QUERY_REQUIRED",
        "maxFacts and maxTokens must be positive integers."
      );
    }

    const memoryFilter = { scopes, excludeSuperseded: true };
    const legs: Array<{ source: "bm25" | "vector"; results: SearchResult[] }> =
      [];
    const bm25 = await searchBm25(store, query, {
      collection: collection.name,
      limit: RECALL_RETRIEVAL_LIMIT,
      memoryFilter,
    });
    if (!bm25.ok) {
      if (bm25.error.code !== "INVALID_INPUT") {
        throw new MemoryError("MEMORY_QUERY_FAILED", bm25.error.message);
      }
    } else {
      legs.push({ source: "bm25", results: bm25.value.results });
    }

    const retrieval: RecallResult["retrieval"] = { mode: "lexical" };
    const embedPort = this.deps.embedPort ?? null;
    const vectorIndex = this.deps.vectorIndex ?? null;
    if (embedPort && vectorIndex?.searchAvailable) {
      // The eligible set is one unbounded in-query scope+supersession filter;
      // the vector leg only ever ranks inside it.
      const eligible = await store.listMemoryEligibleDocuments({
        collection: collection.name,
        scopes,
        excludeSuperseded: true,
      });
      if (!eligible.ok) {
        throw new MemoryError("MEMORY_QUERY_FAILED", eligible.error.message);
      }
      const allowedMirrorHashes = [
        ...new Set(eligible.value.map((row) => row.mirrorHash)),
      ];
      if (allowedMirrorHashes.length > 0) {
        const embedded = await embedPort.embed(query);
        if (embedded.ok) {
          const vector = await searchVectorWithEmbedding(
            { store, vectorIndex, embedPort, config },
            query,
            new Float32Array(embedded.value),
            {
              collection: collection.name,
              limit: RECALL_RETRIEVAL_LIMIT,
              retrievalScope: { allowedMirrorHashes },
            }
          );
          if (vector.ok) {
            legs.push({ source: "vector", results: vector.value.results });
            retrieval.mode = "hybrid";
          } else {
            retrieval.semanticUnavailable = vector.error.message;
          }
        } else {
          retrieval.semanticUnavailable = embedded.error.message;
        }
      } else {
        retrieval.mode = "hybrid";
      }
    } else {
      retrieval.semanticUnavailable = embedPort
        ? "vector index unavailable"
        : "no embedding model available";
    }

    // Reciprocal-rank fusion keyed by URI (fact identity), deterministic ties.
    const fused = new Map<string, { result: SearchResult; score: number }>();
    for (const leg of legs) {
      for (const [index, result] of leg.results.entries()) {
        const entry = fused.get(result.uri) ?? { result, score: 0 };
        entry.score += 1 / (RRF_K + index + 1);
        fused.set(result.uri, entry);
      }
    }
    const ranked = [...fused.values()].sort(
      (left, right) =>
        right.score - left.score ||
        compareCodeUnits(left.result.uri, right.result.uri)
    );

    const materialized: Array<{ fact: RecalledFact; rank: number }> = [];
    for (const [index, entry] of ranked.entries()) {
      const { result } = entry;
      if (!result.conversion?.mirrorHash || !result.egressLineage) continue;
      const fact = await readFact(store, {
        uri: result.uri,
        docid: result.docid,
        mirrorHash: result.conversion.mirrorHash,
      });
      if (!fact) continue;
      materialized.push({
        rank: index + 1,
        fact: {
          ...fact,
          score: entry.score,
          spanHash: fact.contentHash,
          egressLineage: result.egressLineage,
        },
      });
    }

    const selection = selectContextEvidence({
      candidates: materialized.map(({ fact, rank }) => ({
        candidateId: fact.uri,
        uri: fact.uri,
        docid: fact.docid,
        startLine: 1,
        endLine: 1,
        passageHash: fact.contentHash,
        sourceHash: fact.contentHash,
        mirrorHash: fact.contentHash,
        text: fact.text,
        facets: [fact.uri],
        retrievalRank: rank,
        value: fact,
      })),
      requestedFacets: materialized.map(({ fact }) => fact.uri),
      limits: {
        requestedBytes: maxTokens * TOKEN_BYTES_ESTIMATE,
        requestedTokens: maxTokens,
        safetyMarginBytes: 0,
        safetyMarginTokens: 0,
        documentShareNumerator: 1,
        documentShareDenominator: 1,
      },
      projectCanonical: (state) => {
        const texts = state.selected.map((item) => item.value.text);
        return {
          value: texts,
          usedBytes: texts.reduce((sum, item) => sum + utf8Bytes(item), 0),
          usedTokens: texts.reduce(
            (sum, item) => sum + estimateTokens(item),
            0
          ),
        };
      },
    });
    const facts = selection.selected
      .slice(0, maxFacts)
      .map((item) => item.value);
    const usedTokens = facts.reduce(
      (sum, fact) => sum + estimateTokens(fact.text),
      0
    );

    const issuedAt = this.now().toISOString();
    const memoryIds = facts.map((fact) => fact.docid);
    const spanHashes = [...new Set(facts.map((fact) => fact.spanHash))].sort();
    const receipt: MemoryRecallReceipt = {
      caller: identity.caller,
      session: identity.session,
      issuedAt,
      memoryIds,
      spanHashes,
      digest: new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify({
            caller: identity.caller,
            session: identity.session,
            issuedAt,
            memoryIds,
            spanHashes,
          })
        )
        .digest("hex"),
    };

    return {
      facts,
      receipt,
      budget: {
        maxFacts,
        maxTokens,
        usedTokens,
        omitted: materialized.length - facts.length,
      },
      retrieval,
      ...(facts.length > 0
        ? {
            egressLineage: mergeEgressLineages(
              facts.map((fact) => fact.egressLineage)
            ),
          }
        : { hint: MEMORY_EMPTY_RECALL_HINT }),
    };
  }
}
