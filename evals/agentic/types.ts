export const AGENTIC_SCHEMA_VERSION = "1.0" as const;

export const AGENT_TASK_CATEGORIES = [
  "exact_identifier",
  "ambiguity",
  "multi_document_comparison",
  "meeting_decision",
  "temporal",
  "typed_relationship",
  "code_documentation",
  "multilingual",
  "missing_evidence",
] as const;
export type AgentTaskCategory = (typeof AGENT_TASK_CATEGORIES)[number];

export const CLAIM_VALUE_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "date",
  "identifier",
] as const;
export type ClaimValueType = (typeof CLAIM_VALUE_TYPES)[number];

export interface PublicClaimDefinition {
  claimKey: string;
  valueType: ClaimValueType;
  substantive: boolean;
  required: boolean;
}

export interface AgentVisibleBrief {
  goal: string;
  instructions: string[];
}

export interface AgentTask {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  taskId: string;
  category: AgentTaskCategory;
  brief: AgentVisibleBrief;
  claims: PublicClaimDefinition[];
  allowedTools: string[];
  budgets: {
    maxAgentCalls: number;
    maxModelVisibleBytes: number;
  };
  corpus: {
    collections: string[];
  };
}

export type ClaimValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "string[]"; value: string[] }
  | { type: "date"; value: string }
  | { type: "identifier"; value: string };

export const HASH_PROVENANCE = [
  "harness_observed",
  "backend_provided",
] as const;
export type HashProvenance = (typeof HASH_PROVENANCE)[number];

export interface EvidenceCoordinate {
  uri: string;
  sourceHash: string;
  startLine: number;
  endLine: number;
  spanHash: string;
  sourceHashProvenance: HashProvenance;
  spanHashProvenance: HashProvenance;
}

export interface FinalClaim {
  claimKey: string;
  value: ClaimValue;
  citations: EvidenceCoordinate[];
}

export const GAP_REASONS = [
  "missing_evidence",
  "conflicting_evidence",
  "budget_exhausted",
  "tool_unavailable",
] as const;
export type GapReason = (typeof GAP_REASONS)[number];

export const STOP_REASONS = [
  "complete",
  "abstained",
  "budget_exhausted",
  "tool_unavailable",
  "error",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface FinalEnvelope {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  claims: FinalClaim[];
  gaps: Array<{ claimKey: string; reason: GapReason }>;
  abstained: boolean;
  stopReason: StopReason;
}

export const NORMALIZER_IDS = [
  "exact-v1",
  "trim-lower-v1",
  "identifier-v1",
  "iso-date-v1",
  "string-set-v1",
] as const;
export type NormalizerId = (typeof NORMALIZER_IDS)[number];

export interface OracleClaim {
  claimKey: string;
  expectedValue: ClaimValue;
  normalizer: {
    id: NormalizerId;
    version: 1;
  };
  requiredEvidence: EvidenceCoordinate[];
  optionalEvidence: EvidenceCoordinate[];
  forbiddenEvidence: EvidenceCoordinate[];
}

export interface HiddenOracle {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  taskId: string;
  claims: OracleClaim[];
  expectedMissing: string[];
  expectedScope: {
    collection: string | null;
    filters: Record<string, string | number | boolean>;
  };
  completion: {
    expectAbstention: boolean;
    maxAgentCalls: number;
    maxModelVisibleBytes: number;
    failOnUnexpectedEvidence: boolean;
  };
  leakCanaries: string[];
}

export interface NormalizedToolEvidence extends EvidenceCoordinate {
  text: string;
  backendSourceHash: string | null;
  backendSpanHash: string | null;
  backendHashUnavailableReason: string | null;
}

export interface NormalizedToolResult {
  status: "ok" | "error";
  resultRole: "candidates" | "source" | "evidence_bundle";
  content: string;
  evidence: NormalizedToolEvidence[];
  errorCode: string | null;
}

/** Exact tool-result payload exposed to either outer-agent lane. */
export interface AgentVisibleToolResult {
  status: "ok" | "error";
  resultRole: "candidates" | "source" | "evidence_bundle";
  content: string;
  evidence: Array<
    EvidenceCoordinate & {
      text: string;
    }
  >;
  errorCode: string | null;
}

export interface AgentVisibleCall {
  callIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: AgentVisibleToolResult;
}

export interface CanonicalAgentCall {
  callIndex: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: NormalizedToolResult;
  modelVisibleUtf8Bytes: number;
  measuredTokens: number | null;
  tokenizerFingerprint: string | null;
  backendInvocations: number;
}

export type CapabilityState = "supported" | "unsupported" | "unavailable";

export interface AdapterCapabilitySnapshot {
  backendInvocationAccounting: boolean;
  startupTiming: boolean;
  modelLoadTiming: boolean;
  toolTiming: boolean;
  tools: Record<"search" | "get" | "multi_get", CapabilityState>;
  exactLineSpans: CapabilityState;
  measuredTokens: CapabilityState;
  backendHashes: CapabilityState;
  lifecycle: Record<"cold" | "warm", CapabilityState>;
}

export const FAILURE_CLASSES = [
  "none",
  "harness_error",
  "agent_error",
  "product_error",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface TrajectoryCanonical {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  taskId: string;
  adapterId: string;
  trialId: string;
  seed: number | null;
  lifecycle: "cold" | "warm";
  agentId: string;
  capabilities: AdapterCapabilitySnapshot;
  calls: CanonicalAgentCall[];
  agentCalls: number;
  backendInvocations: number;
  modelVisibleUtf8Bytes: number;
  measuredTokens: number | null;
  finalEnvelope: FinalEnvelope | null;
  stopReason: StopReason;
  failure: {
    class: FailureClass;
    code: string | null;
    redactedMessage: string | null;
  };
  fingerprints: {
    corpus: string;
    prompt: string;
    tools: string;
    model: string;
    runtime: string;
    config: string;
    index: string;
  };
}

export interface TimingObservation {
  valueMs: number | null;
  unavailableReason: string | null;
}

export interface TrajectoryObservations {
  recordedAt: string;
  timings: {
    preparation: TimingObservation;
    startup: TimingObservation;
    modelLoad: TimingObservation;
    tool: TimingObservation;
    driver: TimingObservation;
    endToEnd: TimingObservation;
  };
  process: {
    peakRssBytes: number | null;
    unavailableReason: string | null;
  };
  tempPaths: string[];
  diagnostics: string[];
}

export interface TrajectoryReceipt {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  canonical: TrajectoryCanonical;
  observations: TrajectoryObservations;
}

export interface TaskScore {
  taskId: string;
  scored: boolean;
  exclusionReason: string | null;
  success: 0 | 1;
  completed: boolean;
  supportedClaims: string[];
  unsupportedClaims: string[];
  missingRequiredClaims: string[];
  forbiddenEvidenceClaims: string[];
  invalidOutputs: string[];
  correctAbstention: boolean;
  prematureStop: boolean;
  unnecessaryRead: boolean;
  collectionCorrect: boolean;
  filtersCorrect: boolean;
  substantiveClaims: number;
  linkedSupportedClaims: number;
}

export interface BenchmarkScoreRecord {
  taskId: string;
  adapterId: string;
  trialId: string;
  seed: number | null;
  lifecycle: "cold" | "warm";
  agentId: string;
  score: TaskScore;
}

export interface CapsuleReplayRecord {
  taskId: string;
  adapterId: "capsule";
  trialId: string;
  seed: number | null;
  lifecycle: "cold" | "warm";
  agentId: string;
  first: { canonicalJson: string; sha256: string };
  second: { canonicalJson: string; sha256: string };
}

export interface PromotionPair {
  taskId: string;
  trialId: string;
  lifecycle: "cold" | "warm";
  baseline: { receipt: TrajectoryReceipt; score: BenchmarkScoreRecord };
  candidate: {
    receipt: TrajectoryReceipt;
    score: BenchmarkScoreRecord;
    replay: CapsuleReplayRecord;
  };
}

export interface PromotionGateResult {
  passed: boolean;
  pairCount: number;
  failures: string[];
  metrics: {
    baselineSuccessRate: number | null;
    candidateSuccessRate: number | null;
    agentCallReduction: number | null;
    contextByteReduction: number | null;
    claimLinkageRate: number | null;
  };
}

export interface BenchmarkReport {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  benchmarkId: string;
  canonicalFingerprint: string;
  fixtureFingerprint: string;
  environment: {
    packageVersion: string;
    bunVersion: string;
    platform: string;
    architecture: string;
    git: {
      commit: string | null;
      dirty: boolean | null;
      unavailableReason: string | null;
    };
    fixtureVersion: string;
    agentId: string;
    trials: Array<{ trialId: string; seed: number | null }>;
  };
  methodology: string[];
  limitations: string[];
  preparations: AdapterNativeIndexRecord[];
  attemptedPairs: number;
  scoredPairs: number;
  exclusions: Array<{
    taskId: string;
    adapterId: string;
    trialId: string;
    seed: number | null;
    lifecycle: "cold" | "warm";
    agentId: string;
    failureClass: FailureClass;
    reason: string;
  }>;
  receipts: TrajectoryReceipt[];
  scores: BenchmarkScoreRecord[];
  capsuleReplays: CapsuleReplayRecord[];
  promotion: PromotionGateResult | null;
}

export interface FixtureManifestFile {
  path: string;
  kind: "task" | "oracle" | "corpus";
  sha256: string;
  taskId: string;
  collection: string | null;
}

export interface AgenticFixtureManifest {
  schemaVersion: typeof AGENTIC_SCHEMA_VERSION;
  fixtureVersion: string;
  license: string;
  provenance: string;
  taskCount: number;
  files: FixtureManifestFile[];
  corpusFingerprint: string;
}

export interface CorpusSnapshotFile {
  readonly taskId: string;
  readonly collection: string;
  readonly relPath: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly content: string;
}

export interface CorpusSnapshot {
  fixtureVersion: string;
  fingerprint: string;
  files: readonly CorpusSnapshotFile[];
}

export interface NativeIndexPreparation {
  taskIds: readonly string[];
  corpusFingerprint: string;
  indexFingerprint: string;
  dbPath: string;
  rootPath: string;
  documentCount: number;
  collectionCount: number;
  observations: {
    preparationMs: number;
    filesProcessed: number;
    filesErrored: number;
  };
}

export interface AdapterNativeIndexRecord {
  adapterId: string;
  corpusFingerprint: string;
  indexFingerprint: string;
  observations: {
    preparationMs: number | null;
    preparationUnavailableReason: string | null;
    details: Record<string, string | number | boolean | null>;
  };
}
