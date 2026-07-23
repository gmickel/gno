import type { Config } from "../config/types";
import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextEvidenceCompilerDeps } from "../core/context-evidence";
import type { ContextVerifierDeps } from "../core/context-verifier";
import type { RetrievalTraceSession } from "../core/retrieval-trace-session";
import type { EmbeddingPort, RerankPort } from "../llm/types";
import type { QueryModeInput } from "../pipeline/types";
import type { StorePort } from "../store/types";
import type { VectorIndexPort } from "../store/vector";

export type ContextDepthPolicy = "fast" | "balanced" | "thorough";

export interface ContextCapsuleBuildInput {
  goal: string;
  query?: string;
  indexName?: string;
  collections?: string[];
  uriPrefix?: string | null;
  queryModes?: QueryModeInput[];
  tagsAll?: string[];
  tagsAny?: string[];
  categories?: string[];
  author?: string;
  lang?: string;
  intent?: string;
  exclude?: string[];
  minScore?: number;
  since?: string;
  until?: string;
  graph?: boolean;
  noRerank?: boolean;
  limit?: number;
  candidateLimit?: number;
  budgetTokens: number;
  budgetBytes?: number;
  safetyMarginTokens?: number;
  safetyMarginBytes?: number;
  depthPolicy?: ContextDepthPolicy;
}

export interface ContextCapsuleRuntimeDeps {
  store: StorePort &
    ContextEvidenceCompilerDeps<ContextCapsuleV1>["store"] &
    ContextVerifierDeps["store"];
  config: Config;
  indexName?: string;
  vectorIndex?: VectorIndexPort | null;
  embedPort?: EmbeddingPort | null;
  rerankPort?: RerankPort | null;
  countTokens?: (accountingJson: string) => number;
  tokenizerFingerprint?: string | null;
  resolveCurrentRanks?: ContextVerifierDeps["resolveCurrentRanks"];
  /** Optional non-canonical receipt session owned by the calling surface. */
  traceSession?: RetrievalTraceSession;
}

export type ContextRuntimeErrorCode =
  | "invalid_goal"
  | "invalid_budget"
  | "invalid_filter"
  | "invalid_uri"
  | "retrieval_failed";

export class ContextRuntimeError extends Error {
  readonly code: ContextRuntimeErrorCode;

  constructor(code: ContextRuntimeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ContextRuntimeError";
    this.code = code;
  }
}
