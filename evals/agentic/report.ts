import type { AdapterPreparation } from "./adapter";
import type { AgentTrial } from "./agent";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { AgenticRunnerResult } from "./runner";
import type {
  AdapterNativeIndexRecord,
  BenchmarkReport,
  BenchmarkScoreRecord,
  CapsuleReplayRecord,
  PromotionGateResult,
  TrajectoryReceipt,
} from "./types";

import packageJson from "../../package.json";
import { canonicalFingerprint, canonicalJson, sha256Bytes } from "./canonical";
import { evaluatePromotionGates, pairPromotionCohorts } from "./promotion";
import { scoreRecordFor, scoreTrajectory } from "./scoring";
import { assertAgenticSchema } from "./validation";

export const AGENTIC_BENCHMARK_ID = "agentic-retrieval@1";

export const AGENTIC_METHODOLOGY = [
  "One pinned outer-agent schedule runs identical visible tasks and tool schemas across adapters.",
  "Cold and warm cohorts reuse each adapter native immutable index; warm uses one discarded readiness probe.",
  "Deterministic hidden-oracle scoring binds typed claims to exact source lines and hashes without an LLM judge.",
  "Capsule promotion compares gno-mcp and capsule only on exact paired identities and unchanged-input payload replays.",
];

export const AGENTIC_LIMITATIONS = [
  "Controlled fixtures are regression evidence, not a representative workload claim.",
  "Fixture-agent behavior is deterministic and narrower than a general model.",
  "UTF-8 bytes are the primary context measure; tokens are null without one pinned tokenizer.",
  "Latency is environment-specific and comparable only within a matching lifecycle.",
  "qmd is optional, exact-revision pinned, and non-authoritative for Capsule promotion.",
  "The Capsule adapter is eval-only and does not define the production fn-98 contract.",
];

const identityKey = (receipt: TrajectoryReceipt): string =>
  [
    receipt.canonical.adapterId,
    receipt.canonical.taskId,
    receipt.canonical.trialId,
    receipt.canonical.lifecycle,
    String(receipt.canonical.seed),
    receipt.canonical.agentId,
  ].join("\0");

export const sortReceipts = (
  receipts: readonly TrajectoryReceipt[]
): TrajectoryReceipt[] =>
  [...receipts].sort((left, right) =>
    identityKey(left).localeCompare(identityKey(right), "en")
  );

const preparationRecords = (
  preparations: readonly Omit<AdapterPreparation, "handle">[]
): AdapterNativeIndexRecord[] =>
  preparations
    .map((preparation) => ({
      adapterId: preparation.adapterId,
      corpusFingerprint: preparation.corpusFingerprint,
      indexFingerprint: preparation.indexFingerprint,
      observations: {
        preparationMs: preparation.preparation.valueMs,
        preparationUnavailableReason: preparation.preparation.unavailableReason,
        details: structuredClone(preparation.observations),
      },
    }))
    .sort((left, right) => left.adapterId.localeCompare(right.adapterId, "en"));

const gitEnvironment = (): BenchmarkReport["environment"]["git"] => {
  try {
    const commit = Bun.spawnSync(["/usr/bin/git", "rev-parse", "HEAD"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = Bun.spawnSync(["/usr/bin/git", "status", "--porcelain"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (commit.exitCode !== 0 || status.exitCode !== 0)
      throw new Error("git probe failed");
    const sha = commit.stdout.toString().trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("git SHA invalid");
    return {
      commit: sha,
      dirty: status.stdout.toString().trim().length > 0,
      unavailableReason: null,
    };
  } catch {
    return {
      commit: null,
      dirty: null,
      unavailableReason: "git metadata unavailable",
    };
  }
};

export const createBenchmarkEnvironment = (input: {
  fixture: LoadedAgenticFixture;
  agentId: string;
  trials: readonly AgentTrial[];
}): BenchmarkReport["environment"] => ({
  packageVersion: packageJson.version,
  bunVersion: Bun.version,
  platform: process.platform,
  architecture: process.arch,
  git: gitEnvironment(),
  fixtureVersion: input.fixture.manifest.fixtureVersion,
  agentId: input.agentId,
  trials: [...input.trials]
    .map((trial) => ({ trialId: trial.trialId, seed: trial.seed }))
    .sort((left, right) => left.trialId.localeCompare(right.trialId, "en")),
});

export const buildCapsuleReplayRecords = (
  firstRun: readonly TrajectoryReceipt[],
  secondRun: readonly TrajectoryReceipt[]
): CapsuleReplayRecord[] => {
  const first = sortReceipts(firstRun);
  const second = sortReceipts(secondRun);
  if (first.length !== second.length)
    throw new Error("Capsule replay runs have different cardinality");
  return first.map((receipt, index) => {
    const replay = second[index];
    if (!(replay && identityKey(receipt) === identityKey(replay)))
      throw new Error("Capsule replay runs have different identities");
    if (
      receipt.canonical.adapterId !== "capsule" ||
      replay.canonical.adapterId !== "capsule"
    )
      throw new Error("Capsule replay contains a non-capsule receipt");
    if (
      canonicalJson(receipt.canonical.fingerprints) !==
      canonicalJson(replay.canonical.fingerprints)
    )
      throw new Error("Capsule replay inputs have different fingerprints");
    const payloadFor = (item: TrajectoryReceipt): string => {
      const bundles = item.canonical.calls.filter(
        (call) => call.result.resultRole === "evidence_bundle"
      );
      if (bundles.length !== 1 || !bundles[0]?.result.content)
        throw new Error(
          "Capsule replay is missing one evidence-bundle payload"
        );
      const payload = bundles[0].result.content;
      if (canonicalJson(JSON.parse(payload)) !== payload)
        throw new Error("Capsule replay payload is not canonical JSON");
      return payload;
    };
    const firstPayload = payloadFor(receipt);
    const secondPayload = payloadFor(replay);
    return {
      taskId: receipt.canonical.taskId,
      adapterId: "capsule",
      trialId: receipt.canonical.trialId,
      seed: receipt.canonical.seed,
      lifecycle: receipt.canonical.lifecycle,
      agentId: receipt.canonical.agentId,
      first: {
        canonicalJson: firstPayload,
        sha256: sha256Bytes(firstPayload),
      },
      second: {
        canonicalJson: secondPayload,
        sha256: sha256Bytes(secondPayload),
      },
    };
  });
};

const promotionFor = (
  receipts: readonly TrajectoryReceipt[],
  scores: readonly BenchmarkScoreRecord[],
  replays: readonly CapsuleReplayRecord[]
): PromotionGateResult | null => {
  const baseline = receipts.filter(
    (receipt) => receipt.canonical.adapterId === "gno-mcp"
  );
  const candidate = receipts.filter(
    (receipt) => receipt.canonical.adapterId === "capsule"
  );
  if (baseline.length === 0 || candidate.length === 0) return null;
  const scoreByIdentity = new Map(
    scores.map((score) => [
      [
        score.adapterId,
        score.taskId,
        score.trialId,
        score.lifecycle,
        String(score.seed),
        score.agentId,
      ].join("\0"),
      score,
    ])
  );
  const replayByIdentity = new Map(
    replays.map((replay) => [
      [
        replay.adapterId,
        replay.taskId,
        replay.trialId,
        replay.lifecycle,
        String(replay.seed),
        replay.agentId,
      ].join("\0"),
      replay,
    ])
  );
  try {
    const scored = (receipt: TrajectoryReceipt): BenchmarkScoreRecord => {
      const score = scoreByIdentity.get(identityKey(receipt));
      if (!score) throw new Error(`score missing for ${identityKey(receipt)}`);
      return score;
    };
    const replayed = (receipt: TrajectoryReceipt): CapsuleReplayRecord => {
      const replay = replayByIdentity.get(identityKey(receipt));
      if (!replay)
        throw new Error(`Capsule replay missing for ${identityKey(receipt)}`);
      return replay;
    };
    return evaluatePromotionGates(
      pairPromotionCohorts(
        baseline.map((receipt) => ({
          receipt,
          score: scored(receipt),
        })),
        candidate.map((receipt) => ({
          receipt,
          score: scored(receipt),
          replay: replayed(receipt),
        }))
      )
    );
  } catch (error) {
    return {
      passed: false,
      pairCount: 0,
      failures: [`cohort_pairing_failed:${(error as Error).message}`],
      metrics: {
        baselineSuccessRate: null,
        candidateSuccessRate: null,
        agentCallReduction: null,
        contextByteReduction: null,
        claimLinkageRate: null,
      },
    };
  }
};

export const benchmarkCanonicalProjection = (
  report: Omit<BenchmarkReport, "canonicalFingerprint">
): unknown => ({
  schemaVersion: report.schemaVersion,
  benchmarkId: report.benchmarkId,
  fixtureFingerprint: report.fixtureFingerprint,
  environment: report.environment,
  methodology: report.methodology,
  limitations: report.limitations,
  preparations: report.preparations.map((record) => ({
    adapterId: record.adapterId,
    corpusFingerprint: record.corpusFingerprint,
    indexFingerprint: record.indexFingerprint,
  })),
  attemptedPairs: report.attemptedPairs,
  scoredPairs: report.scoredPairs,
  exclusions: report.exclusions,
  receipts: report.receipts.map((receipt) => receipt.canonical),
  scores: report.scores,
  capsuleReplays: report.capsuleReplays,
  promotion: report.promotion,
});

export const buildBenchmarkReport = (input: {
  result: AgenticRunnerResult;
  fixture: LoadedAgenticFixture;
  environment: BenchmarkReport["environment"];
  capsuleReplays?: readonly CapsuleReplayRecord[];
  expected: {
    adapterIds: readonly string[];
    taskIds: readonly string[];
    lifecycles: readonly ("cold" | "warm")[];
    trials: readonly AgentTrial[];
  };
}): BenchmarkReport => {
  const receipts = sortReceipts(input.result.receipts).map((receipt) =>
    structuredClone(receipt)
  );
  const matrixKey = (value: {
    adapterId: string;
    taskId: string;
    trialId: string;
    lifecycle: string;
  }): string =>
    [value.adapterId, value.taskId, value.trialId, value.lifecycle].join("\0");
  const expectedIdentities = input.expected.adapterIds.flatMap((adapterId) =>
    input.expected.taskIds.flatMap((taskId) =>
      input.expected.trials.flatMap((trial) =>
        input.expected.lifecycles.map((lifecycle) =>
          matrixKey({ adapterId, taskId, trialId: trial.trialId, lifecycle })
        )
      )
    )
  );
  const actualIdentities = receipts.map((receipt) =>
    matrixKey(receipt.canonical)
  );
  if (
    new Set(expectedIdentities).size !== expectedIdentities.length ||
    new Set(actualIdentities).size !== actualIdentities.length ||
    canonicalJson([...expectedIdentities].sort()) !==
      canonicalJson([...actualIdentities].sort())
  ) {
    throw new Error(
      "Benchmark receipts differ from the requested exact matrix"
    );
  }
  const scores = receipts.map((receipt) => {
    const task = input.fixture.tasks.get(receipt.canonical.taskId);
    const oracle = input.fixture.oracles.get(receipt.canonical.taskId);
    if (!(task && oracle))
      throw new Error("Receipt task is absent from fixture");
    return scoreRecordFor(receipt, scoreTrajectory(task, oracle, receipt));
  });
  const capsuleReplays = [...(input.capsuleReplays ?? [])].sort((left, right) =>
    [left.adapterId, left.taskId, left.trialId, left.lifecycle]
      .join("\0")
      .localeCompare(
        [right.adapterId, right.taskId, right.trialId, right.lifecycle].join(
          "\0"
        ),
        "en"
      )
  );
  const partial: Omit<BenchmarkReport, "canonicalFingerprint"> = {
    schemaVersion: "1.0",
    benchmarkId: AGENTIC_BENCHMARK_ID,
    fixtureFingerprint: input.fixture.snapshot.fingerprint,
    environment: input.environment,
    methodology: [...AGENTIC_METHODOLOGY],
    limitations: [...AGENTIC_LIMITATIONS],
    preparations: preparationRecords(input.result.preparations),
    attemptedPairs: expectedIdentities.length,
    scoredPairs: scores.filter((score) => score.score.scored).length,
    exclusions: scores.flatMap((record, index) => {
      if (record.score.scored) return [];
      const receipt = receipts[index] as TrajectoryReceipt;
      return [
        {
          taskId: record.taskId,
          adapterId: record.adapterId,
          trialId: record.trialId,
          seed: record.seed,
          lifecycle: record.lifecycle,
          agentId: record.agentId,
          failureClass: receipt.canonical.failure.class,
          reason:
            record.score.exclusionReason ??
            receipt.canonical.failure.code ??
            "unscored",
        },
      ];
    }),
    receipts,
    scores,
    capsuleReplays,
    promotion: promotionFor(receipts, scores, capsuleReplays),
  };
  const report: BenchmarkReport = {
    ...partial,
    canonicalFingerprint: canonicalFingerprint(
      benchmarkCanonicalProjection(partial)
    ),
  };
  assertAgenticSchema("benchmark-report", report);
  return report;
};
