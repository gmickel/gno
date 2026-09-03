/**
 * Memory service contracts: binding defaults, the stable error code set, and
 * the input/result shapes shared by every surface (CLI, MCP, REST, SDK).
 *
 * Import these through `src/core/memory` (the facade re-exports them); this
 * module exists so the remember/recall implementations can share the types
 * without importing the service class.
 *
 * @module src/core/memory-types
 */

import type { Collection, Config } from "../config/types";
import type { defaultSyncService } from "../ingestion";
import type { EmbeddingPort } from "../llm/types";
import type { StorePort } from "../store/types";
import type { VectorIndexPort } from "../store/vector/types";
import type { EgressLineage } from "./egress-provenance";

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
export const MEMORY_RECALL_RETRIEVAL_LIMIT = 32;
export const MEMORY_RRF_K = 60;
export const MEMORY_DEFAULT_LOCK_WAIT_MS = 120_000;
export const MEMORY_TOKEN_BYTES_ESTIMATE = 4;

export const MEMORY_EMPTY_RECALL_HINT =
  'No memories in scope yet. Store one with: gno remember "<fact>" --scope <scope> --decision add';

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryErrorCode =
  | "MEMORY_TEXT_REQUIRED"
  | "MEMORY_TEXT_TOO_LARGE"
  | "MEMORY_QUERY_REQUIRED"
  | "MEMORY_BUDGET_INVALID"
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
  | "MEMORY_SUPERSEDE_PROJECTION_FAILED"
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
  /** Free-text evidence recorded with the fact, when one was given. */
  source?: string;
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
  /** Must surface typed-edge projection errors (`syncPaths`, not `syncFiles`). */
  syncService?: Pick<typeof defaultSyncService, "syncPaths">;
  now?: () => Date;
}
