import { join } from "node:path";

export interface EmbeddingRuntimeSpec {
  kind: "native" | "http";
  uri: string;
}

export interface EmbeddingCandidateSpec {
  id: string;
  label: string;
  runtime: EmbeddingRuntimeSpec;
  notes?: string;
}

export interface EmbeddingSearchSpace {
  id: string;
  incumbentId: string;
  candidates: EmbeddingCandidateSpec[];
}

export interface EmbeddingHarnessConfig {
  id: string;
  sandboxRoot: string;
  allowedRoots: string[];
  mutationTargets: string[];
  disallowedRoots: string[];
  budget: {
    maxRuntimeMinutes: number;
    maxRunsPerSession?: number;
    confirmationRuns?: number;
  };
  metric: {
    baselineArtifact: string;
    validationCommand: string;
    smokeCommand: string;
    fixtures: {
      primary: string;
      secondary?: string;
    };
    decision: {
      primary: string;
      weights: Record<string, number>;
      minimums: Record<string, number>;
    };
  };
  logging: {
    runDir: string;
    requiredFields?: string[];
  };
  promotion: {
    humanApprovalRequired: boolean;
  };
}

export interface EmbeddingFixtureSummary {
  generatedAt: string;
  label: string;
  runtime: {
    embedModel: string;
    collection: string;
    corpusDir: string;
    queryCount: number;
    limit: number;
  };
  corpus: {
    docCount: number;
    languages: string[];
  };
  indexing: {
    embedded: number;
    errors: number;
    durationSeconds: number;
    searchAvailable: boolean;
  };
  vector: {
    metrics: {
      recallAt5: number;
      recallAt10: number;
      ndcgAt10: number;
      mrr: number;
    };
    latency: {
      p50Ms: number;
      p95Ms: number;
      meanMs: number;
    };
  };
  hybrid: {
    metrics: {
      recallAt5: number;
      recallAt10: number;
      ndcgAt10: number;
      mrr: number;
    };
    latency: {
      p50Ms: number;
      p95Ms: number;
      meanMs: number;
    };
  };
}

export interface EmbeddingRunArtifact {
  candidateId: string;
  label: string;
  runtime: EmbeddingRuntimeSpec;
  benchmarkPaths: Record<string, string>;
  benchmarks: Record<string, EmbeddingFixtureSummary>;
  decision: "baseline" | "keep" | "discard" | "pending";
  weightedScore: number;
  runtimeSeconds: number;
  generatedAt: string;
}

export interface ConfirmedIncumbentArtifact {
  generatedAt: string;
  incumbentId: string;
  challengerId: string;
  decision: "keep-incumbent" | "promote-challenger";
  confirmationRuns: number;
  incumbentMedian: {
    primaryVectorNdcgAt10: number;
    secondaryVectorNdcgAt10: number;
  };
  challengerMedian: {
    primaryVectorNdcgAt10: number;
    secondaryVectorNdcgAt10: number;
  };
}

export interface LeaderboardRow {
  candidateId: string;
  label: string;
  runtimeKind: EmbeddingRuntimeSpec["kind"];
  decision: EmbeddingRunArtifact["decision"];
  primaryVectorNdcgAt10: number;
  secondaryVectorNdcgAt10: number;
  primaryVectorRecallAt5: number;
  weightedScore: number;
  confirmation?: "incumbent" | "challenger";
}

export async function loadHarnessConfig(
  repoRoot: string
): Promise<EmbeddingHarnessConfig> {
  return (await Bun.file(
    join(repoRoot, "research/embeddings/autonomous/config.json")
  ).json()) as EmbeddingHarnessConfig;
}

export async function loadSearchSpace(
  repoRoot: string
): Promise<EmbeddingSearchSpace> {
  return (await Bun.file(
    join(repoRoot, "research/embeddings/autonomous/search-space.json")
  ).json()) as EmbeddingSearchSpace;
}

export async function loadRunArtifacts(
  repoRoot: string
): Promise<EmbeddingRunArtifact[]> {
  const rows: EmbeddingRunArtifact[] = [];
  const glob = new Bun.Glob("research/embeddings/autonomous/runs/*.result.json");
  for await (const relativePath of glob.scan({ cwd: repoRoot })) {
    const raw = (await Bun.file(join(repoRoot, relativePath)).json()) as
      | EmbeddingRunArtifact
      | {
          candidateId: string;
          label: string;
          runtime?: EmbeddingRuntimeSpec;
          embedModel?: string;
          benchmarkPath?: string;
          benchmark?: EmbeddingFixtureSummary;
          benchmarkPaths?: Record<string, string>;
          benchmarks?: Record<string, EmbeddingFixtureSummary>;
          decision: EmbeddingRunArtifact["decision"];
          weightedScore: number;
          runtimeSeconds: number;
          generatedAt: string;
        };
    rows.push(normalizeRunArtifact(raw));
  }
  rows.sort((left, right) => right.weightedScore - left.weightedScore);
  return rows;
}

function normalizeRunArtifact(
  raw:
    | EmbeddingRunArtifact
    | {
        candidateId: string;
        label: string;
        runtime?: EmbeddingRuntimeSpec;
        embedModel?: string;
        benchmarkPath?: string;
        benchmark?: EmbeddingFixtureSummary;
        benchmarkPaths?: Record<string, string>;
        benchmarks?: Record<string, EmbeddingFixtureSummary>;
        decision: EmbeddingRunArtifact["decision"];
        weightedScore: number;
        runtimeSeconds: number;
        generatedAt: string;
      }
): EmbeddingRunArtifact {
  if ("benchmarks" in raw && raw.benchmarks && "runtime" in raw && raw.runtime) {
    return raw as EmbeddingRunArtifact;
  }

  const benchmark = "benchmark" in raw ? raw.benchmark : undefined;
  const benchmarkPath = "benchmarkPath" in raw ? raw.benchmarkPath : undefined;
  const embedModel = "embedModel" in raw ? raw.embedModel : undefined;
  return {
    candidateId: raw.candidateId,
    label: raw.label,
    runtime:
      raw.runtime ??
      ({
        kind: "native",
        uri: embedModel ?? "",
      } as EmbeddingRuntimeSpec),
    benchmarkPaths: benchmarkPath ? { canonical: benchmarkPath } : {},
    benchmarks: benchmark ? { canonical: benchmark } : {},
    decision: raw.decision,
    weightedScore: raw.weightedScore,
    runtimeSeconds: raw.runtimeSeconds,
    generatedAt: raw.generatedAt,
  };
}

export async function loadConfirmedIncumbent(
  repoRoot: string
): Promise<ConfirmedIncumbentArtifact | null> {
  const file = Bun.file(
    join(repoRoot, "research/embeddings/autonomous/runs/confirmed-incumbent.json")
  );
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as ConfirmedIncumbentArtifact;
}

export function extractFixtureMetrics(
  artifact: EmbeddingRunArtifact,
  fixtureId: string
): {
  vectorNdcgAt10: number;
  vectorRecallAt5: number;
  hybridNdcgAt10: number;
} {
  const summary = artifact.benchmarks[fixtureId];
  return {
    vectorNdcgAt10: summary?.vector.metrics.ndcgAt10 ?? 0,
    vectorRecallAt5: summary?.vector.metrics.recallAt5 ?? 0,
    hybridNdcgAt10: summary?.hybrid.metrics.ndcgAt10 ?? 0,
  };
}

export async function collectLeaderboardRows(
  repoRoot: string
): Promise<LeaderboardRow[]> {
  const config = await loadHarnessConfig(repoRoot);
  const confirmed = await loadConfirmedIncumbent(repoRoot);
  const rows = await loadRunArtifacts(repoRoot);
  return rows.map((row) => {
    const primary = extractFixtureMetrics(row, config.metric.fixtures.primary);
    const secondary = config.metric.fixtures.secondary
      ? extractFixtureMetrics(row, config.metric.fixtures.secondary)
      : {
          vectorNdcgAt10: 0,
          vectorRecallAt5: 0,
          hybridNdcgAt10: 0,
        };
    const confirmation =
      confirmed?.incumbentId === row.candidateId
        ? "incumbent"
        : confirmed?.challengerId === row.candidateId &&
            confirmed.decision === "promote-challenger"
          ? "challenger"
          : undefined;
    return {
      candidateId: row.candidateId,
      label: row.label,
      runtimeKind: row.runtime.kind,
      decision: row.decision,
      primaryVectorNdcgAt10: primary.vectorNdcgAt10,
      secondaryVectorNdcgAt10: secondary.vectorNdcgAt10,
      primaryVectorRecallAt5: primary.vectorRecallAt5,
      weightedScore: row.weightedScore,
      confirmation,
    };
  });
}

export function selectCandidates(input: {
  candidates: EmbeddingCandidateSpec[];
  completedCandidateIds: Set<string>;
  requestedCandidateIds?: Set<string>;
  includeCompleted?: boolean;
  maxRuns?: number;
}): EmbeddingCandidateSpec[] {
  const filtered = input.candidates.filter((candidate) => {
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
    return filtered;
  }
  return filtered.slice(0, input.maxRuns);
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
