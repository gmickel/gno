import { join } from "node:path";

export interface CandidateSpec {
  id: string;
  mix: string;
  promptProfile: string;
  learningRate: number;
  seed?: number;
}

export interface SearchSpace {
  id: string;
  baseTrainingConfig: string;
  candidates: CandidateSpec[];
}

export interface HarnessConfig {
  id: string;
  allowedRoots: string[];
  mutationTargets: string[];
  budget: {
    maxRuntimeMinutes: number;
    maxChangedFiles: number;
    maxRunsPerSession?: number;
    maxCommitsPerRun?: number;
  };
  metric: {
    baselineArtifact: string;
    validationCommand: string;
    smokeCommand: string;
    promotionSplit: string;
    decision: {
      primary: string;
      weights: {
        ndcgAt10: number;
        schemaSuccessRate: number;
        askRecallAt5: number;
        p95Ms: number;
      };
      minimums: {
        ndcgDelta: number;
        schemaDelta: number;
      };
    };
  };
  logging: {
    runDir: string;
    requiredFields?: string[];
  };
  search?: {
    referenceRun?: string;
    referenceBestValLoss?: number;
    earlyStop?: {
      enabled: boolean;
      minIteration: number;
      maxBestValLoss: number;
      maxValLossDelta?: number;
    };
  };
  promotion: {
    humanApprovalRequired: boolean;
    rollbackOnRegression?: boolean;
  };
}

export interface BenchmarkCandidate {
  retrieval?: {
    metrics?: { ndcgAt10?: number };
    latencies?: { total?: { p95Ms?: number } };
    bySet?: { ask?: { metric?: { recallAt5?: number } } };
  };
  expansion?: { schemaSuccessRate?: number };
}

export interface RunResultArtifact {
  runName: string;
  candidateId: string;
  mix: string;
  promptProfile: string;
  learningRate: number;
  logPath: string;
  trainingConfigPath: string;
  earlyStop?: {
    iteration: number;
    bestValLoss: number;
    threshold: number;
    reason: string;
  };
  benchmark?: BenchmarkCandidate;
}

export interface PolicyArtifact {
  experimentId: string;
  policyId: string;
  runName: string;
  targets: string[];
  metricCommand: string;
  deltas: {
    ndcgAt10: number;
    schemaSuccessRate: number;
    askRecallAt5: number;
    p95Ms: number;
    weightedScore?: number;
  };
  decision: "keep" | "discard";
  humanApprovalRequired: boolean;
  runtimeSeconds: number;
}

export interface ConfirmedIncumbentArtifact {
  generatedAt: string;
  incumbentRun: string;
  challengerRun: string;
  repeatPath: string;
  decision: "keep-incumbent" | "promote-challenger";
  rationale: string;
  incumbentMedian: {
    ndcgAt10: number;
    askRecallAt5: number;
    schemaSuccessRate: number;
    p95Ms: number;
  };
  challengerMedian: {
    ndcgAt10: number;
    askRecallAt5: number;
    schemaSuccessRate: number;
    p95Ms: number;
  };
}

export interface LeaderboardRow {
  runName: string;
  candidateId: string;
  ndcgAt10: number;
  askRecallAt5: number;
  schemaSuccessRate: number;
  p95Ms: number;
  decision: "keep" | "discard" | "pending";
  weightedScore: number;
  confirmation?: "incumbent" | "challenger";
}

export const runNameForCandidate = (candidateId: string): string =>
  `auto-${candidateId}`;

export async function loadHarnessConfig(
  repoRoot: string
): Promise<HarnessConfig> {
  return (await Bun.file(
    join(repoRoot, "research/finetune/autonomous/config.json")
  ).json()) as HarnessConfig;
}

export async function loadSearchSpace(repoRoot: string): Promise<SearchSpace> {
  return (await Bun.file(
    join(repoRoot, "research/finetune/autonomous/search-space.json")
  ).json()) as SearchSpace;
}

export async function loadRunResult(
  repoRoot: string,
  runName: string
): Promise<RunResultArtifact | null> {
  const file = Bun.file(
    join(repoRoot, "research/finetune/autonomous/runs", `${runName}.result.json`)
  );
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as RunResultArtifact;
}

export async function loadPolicyArtifact(
  repoRoot: string,
  runName: string
): Promise<PolicyArtifact | null> {
  const file = Bun.file(
    join(repoRoot, "research/finetune/autonomous/runs", `policy-${runName}.json`)
  );
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as PolicyArtifact;
}

export async function collectLeaderboardRows(
  repoRoot: string
): Promise<LeaderboardRow[]> {
  const rows: LeaderboardRow[] = [];
  const confirmed = await loadConfirmedIncumbent(repoRoot);
  const glob = new Bun.Glob("research/finetune/autonomous/runs/*.result.json");
  for await (const relativePath of glob.scan({ cwd: repoRoot })) {
    const result = (await Bun.file(join(repoRoot, relativePath)).json()) as RunResultArtifact;
    const policy = await loadPolicyArtifact(repoRoot, result.runName);
    const confirmation =
      confirmed?.incumbentRun === result.runName
        ? "incumbent"
        : confirmed?.challengerRun === result.runName &&
            confirmed.decision === "promote-challenger"
          ? "challenger"
          : undefined;
    rows.push({
      runName: result.runName,
      candidateId: result.candidateId,
      ndcgAt10: result.benchmark?.retrieval?.metrics?.ndcgAt10 ?? 0,
      askRecallAt5:
        result.benchmark?.retrieval?.bySet?.ask?.metric?.recallAt5 ?? 0,
      schemaSuccessRate: result.benchmark?.expansion?.schemaSuccessRate ?? 0,
      p95Ms: result.benchmark?.retrieval?.latencies?.total?.p95Ms ?? 0,
      decision: policy?.decision ?? "pending",
      weightedScore: policy?.deltas.weightedScore ?? Number.NEGATIVE_INFINITY,
      confirmation,
    });
  }

  rows.sort((left, right) => {
    if (right.weightedScore !== left.weightedScore) {
      return right.weightedScore - left.weightedScore;
    }
    if (right.ndcgAt10 !== left.ndcgAt10) {
      return right.ndcgAt10 - left.ndcgAt10;
    }
    return right.schemaSuccessRate - left.schemaSuccessRate;
  });
  return rows;
}

export async function loadConfirmedIncumbent(
  repoRoot: string
): Promise<ConfirmedIncumbentArtifact | null> {
  const file = Bun.file(
    join(repoRoot, "research/finetune/autonomous/runs/confirmed-incumbent.json")
  );
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as ConfirmedIncumbentArtifact;
}

export function selectCandidates(input: {
  candidates: CandidateSpec[];
  completedCandidateIds: Set<string>;
  requestedCandidateIds?: Set<string>;
  includeCompleted?: boolean;
  maxRuns?: number;
}): CandidateSpec[] {
  const rows = input.candidates.filter((candidate) => {
    if (
      input.requestedCandidateIds &&
      !input.requestedCandidateIds.has(candidate.id)
    ) {
      return false;
    }
    if (!input.includeCompleted && input.completedCandidateIds.has(candidate.id)) {
      return false;
    }
    return true;
  });

  if (input.maxRuns === undefined) {
    return rows;
  }
  return rows.slice(0, input.maxRuns);
}

export function pickBestKeepCandidate(
  rows: LeaderboardRow[]
): LeaderboardRow | null {
  return (
    rows
      .filter((row) => row.decision === "keep")
      .sort((left, right) => {
        if (right.weightedScore !== left.weightedScore) {
          return right.weightedScore - left.weightedScore;
        }
        if (right.ndcgAt10 !== left.ndcgAt10) {
          return right.ndcgAt10 - left.ndcgAt10;
        }
        return right.schemaSuccessRate - left.schemaSuccessRate;
      })[0] ?? null
  );
}
