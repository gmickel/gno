/**
 * Transport-neutral memory service: `remember()` and `recall()`.
 *
 * Every surface (CLI, MCP, REST, SDK) is a thin adapter over this module.
 * The service owns the shared write lease for every write path; adapters
 * never take `.mcp-write.lock` themselves (single acquisition point, no
 * nesting — a caller that already holds the lease deadlocks/fails fast).
 *
 * This file is the facade: the contracts live in `memory-types`, validation,
 * the context fence, and receipts in `memory-fence`, the write path in
 * `memory-remember`, and retrieval in `memory-recall`. Import from here.
 *
 * @module src/core/memory
 */

import type {
  MemoryCandidate,
  MemoryMatchDiagnostics,
  MemoryServiceDeps,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
} from "./memory-types";

import { recallFacts } from "./memory-recall";
import {
  type CandidateQuery,
  findMemoryCandidates,
  rememberFact,
} from "./memory-remember";

export {
  MEMORY_CANDIDATE_POOL,
  MEMORY_EMPTY_RECALL_HINT,
  MEMORY_LEXICAL_LIKELY_THRESHOLD,
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_TOKENS,
  MEMORY_SEMANTIC_LIKELY_THRESHOLD,
  MemoryError,
} from "./memory-types";
export type {
  MemoryCandidate,
  MemoryCandidateMatch,
  MemoryDecision,
  MemoryErrorCode,
  MemoryFact,
  MemoryIdentity,
  MemoryMatchDiagnostics,
  MemoryMatchMode,
  MemoryRecallReceipt,
  MemoryServiceDeps,
  MemorySyncState,
  RecalledFact,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
} from "./memory-types";

export class MemoryService {
  private readonly deps: MemoryServiceDeps;

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps;
  }

  /**
   * Candidate pool: BM25 top-16 (any-term) within the scope intersection,
   * current facts only. Similarity by cosine when semantic is ready, else by
   * normalized-token Jaccard. Ordered by similarity desc, ties by recordId.
   */
  findCandidates(input: CandidateQuery): Promise<{
    candidates: MemoryCandidate[];
    matching: MemoryMatchDiagnostics;
  }> {
    return findMemoryCandidates(this.deps, input);
  }

  remember(input: RememberInput): Promise<RememberResult> {
    return rememberFact(this.deps, input);
  }

  recall(input: RecallInput): Promise<RecallResult> {
    return recallFacts(this.deps, input);
  }
}
