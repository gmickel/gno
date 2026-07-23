import type {
  AgentTask,
  BenchmarkReport,
  BenchmarkScoreRecord,
  HiddenOracle,
  TimingObservation,
  TrajectoryReceipt,
} from "../types";
import type { VerifiedAskPromotionArtifact } from "../verified-ask-promotion";

export type ContextCapsuleDemoAdapterId = "lexical" | "gno-mcp" | "capsule";

export interface ContextCapsuleDemoLane {
  adapterId: ContextCapsuleDemoAdapterId;
  label: string;
  receipt: TrajectoryReceipt;
  score: BenchmarkScoreRecord;
  metrics: {
    completed: boolean;
    success: 0 | 1;
    substantiveClaimEvidenceCoverage: number;
    agentCalls: number;
    backendInvocations: number;
    modelVisibleUtf8Bytes: number;
    measuredTokens: number | null;
    tokenUnavailableReason: string | null;
    endToEnd: TimingObservation;
    stopOutcome: string;
  };
}

export interface ContextCapsuleRetrievalContract {
  request: {
    toolName: string;
    arguments: Record<string, unknown>;
  };
  effectiveIndexFingerprint: string;
  capabilityStates: TrajectoryReceipt["canonical"]["capabilities"];
  fallbacks: unknown[];
  normalizedPayload: unknown;
}

export interface ContextCapsuleDemoArtifact {
  schemaVersion: "1.0";
  demoId: "context-capsule-demo@1";
  canonicalFingerprint: string;
  sourceBenchmark: {
    benchmarkId: string;
    canonicalFingerprint: string;
    fixtureFingerprint: string;
    immutableGitCommit: string;
    reportPath: string;
  };
  frozenInput: {
    task: AgentTask;
    expected: {
      claimKey: string;
      value: unknown;
      evidence: HiddenOracle["claims"][number]["requiredEvidence"];
    };
    environment: BenchmarkReport["environment"];
    lifecycle: "cold";
    sharedFingerprints: {
      corpus: string;
      prompt: string;
      tools: string;
      model: string;
      runtime: string;
      index: string;
    };
  };
  methodology: string[];
  variance: {
    trialCount: 1;
    estimate: null;
    unavailableReason: string;
  };
  limitations: string[];
  lanes: ContextCapsuleDemoLane[];
  capsuleRetrieval: ContextCapsuleRetrievalContract;
  verifiedAsk: {
    proofKind: "answer_enforcement";
    benchmarkId: string;
    canonicalFingerprint: string;
    immutableGitCommit: string;
    artifactPath: string;
    pairCount: number;
    excludedTasks: VerifiedAskPromotionArtifact["excludedTasks"];
    metrics: VerifiedAskPromotionArtifact["promotion"]["metrics"];
  };
}
