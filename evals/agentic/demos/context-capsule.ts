// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import type {
  BenchmarkReport,
  BenchmarkScoreRecord,
  TrajectoryReceipt,
} from "../types";
import type { VerifiedAskPromotionArtifact } from "../verified-ask-promotion";
import type {
  ContextCapsuleDemoAdapterId,
  ContextCapsuleDemoArtifact,
  ContextCapsuleDemoLane,
} from "./context-capsule-types";

export type {
  ContextCapsuleDemoArtifact,
  ContextCapsuleDemoLane,
  ContextCapsuleRetrievalContract,
} from "./context-capsule-types";

import { canonicalFingerprint, canonicalJson } from "../canonical";
import { AGENTIC_FIXTURE_ROOT, loadAgenticFixture } from "../fixture-db";
import { benchmarkCanonicalProjection } from "../report";
import { assertAgenticSchema } from "../validation";
import { validateVerifiedAskPromotionArtifact } from "../verified-ask-promotion";
export { renderContextCapsuleDemoMarkdown } from "./context-capsule-render";

export const CONTEXT_CAPSULE_DEMO_ID = "context-capsule-demo@1";
export const CONTEXT_CAPSULE_DEMO_TASK_ID = "t0a1b2c3";
export const CONTEXT_CAPSULE_DEMO_LIFECYCLE = "cold" as const;
export const CONTEXT_CAPSULE_DEMO_TRIAL_ID = "fixture-01";
export const CONTEXT_CAPSULE_DEMO_SEED = 0;
export const CONTEXT_CAPSULE_DEMO_AGENT_ID = "fixture-agent-v1";

const BASELINE_ROOT = join(AGENTIC_FIXTURE_ROOT, "baseline", "fixture-agent");
export const CONTEXT_CAPSULE_DEMO_ROOT = join(AGENTIC_FIXTURE_ROOT, "demos");
const ADAPTERS = ["lexical", "gno-mcp", "capsule"] as const;

const labels: Record<ContextCapsuleDemoAdapterId, string> = {
  lexical: "Lexical-only baseline",
  "gno-mcp": "Current GNO primitives",
  capsule: "Context Capsule",
};

const identityKey = (value: {
  adapterId: string;
  taskId: string;
  trialId: string;
  lifecycle: string;
  seed: number | null;
  agentId: string;
}): string =>
  [
    value.adapterId,
    value.taskId,
    value.trialId,
    value.lifecycle,
    String(value.seed),
    value.agentId,
  ].join("\0");

const reportFingerprintFailures = (report: BenchmarkReport): string[] => {
  const { canonicalFingerprint: _fingerprint, ...projection } = report;
  return canonicalFingerprint(benchmarkCanonicalProjection(projection)) ===
    report.canonicalFingerprint
    ? []
    : ["source_report_fingerprint_mismatch"];
};

const claimCoverage = (score: BenchmarkScoreRecord): number =>
  score.score.substantiveClaims === 0
    ? 1
    : score.score.linkedSupportedClaims / score.score.substantiveClaims;

const stopOutcome = (receipt: TrajectoryReceipt): string => {
  const envelope = receipt.canonical.finalEnvelope;
  if (!envelope) return receipt.canonical.stopReason;
  const values = envelope.claims.map((claim) => String(claim.value.value));
  return values.length > 0
    ? `${envelope.stopReason}: ${values.join(", ")}`
    : envelope.stopReason;
};

const deriveLaneMetrics = (
  receipt: TrajectoryReceipt,
  score: BenchmarkScoreRecord
): ContextCapsuleDemoLane["metrics"] => ({
  completed: score.score.completed,
  success: score.score.success,
  substantiveClaimEvidenceCoverage: claimCoverage(score),
  agentCalls: receipt.canonical.agentCalls,
  backendInvocations: receipt.canonical.backendInvocations,
  modelVisibleUtf8Bytes: receipt.canonical.modelVisibleUtf8Bytes,
  measuredTokens: receipt.canonical.measuredTokens,
  tokenUnavailableReason:
    receipt.canonical.measuredTokens === null
      ? "The benchmark did not have one pinned comparable tokenizer."
      : null,
  endToEnd: receipt.observations.timings.endToEnd,
  stopOutcome: stopOutcome(receipt),
});

const buildLane = (
  adapterId: ContextCapsuleDemoAdapterId,
  receipt: TrajectoryReceipt,
  score: BenchmarkScoreRecord
): ContextCapsuleDemoLane => ({
  adapterId,
  label: labels[adapterId],
  receipt,
  score,
  metrics: deriveLaneMetrics(receipt, score),
});

const parseCapsulePayload = (
  receipt: TrajectoryReceipt
): {
  call: TrajectoryReceipt["canonical"]["calls"][number];
  payload: Record<string, unknown> & { r: unknown[] };
  fallbacks: unknown[];
} => {
  const calls = receipt.canonical.calls.filter(
    ({ deliveredToAgent, result }) =>
      deliveredToAgent && result.resultRole === "evidence_bundle"
  );
  if (calls.length !== 1 || !calls[0])
    throw new Error(
      "Demo Capsule must have exactly one delivered evidence bundle"
    );
  const call = calls[0];
  const parsed = JSON.parse(call.result.content) as unknown;
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed)))
    throw new Error("Demo Capsule payload must be an object");
  const payload = parsed as Record<string, unknown>;
  if (!Array.isArray(payload.r) || !Array.isArray(payload.r[7]))
    throw new Error("Demo Capsule payload lacks its fallback contract");
  return {
    call,
    payload: payload as Record<string, unknown> & { r: unknown[] },
    fallbacks: payload.r[7],
  };
};

const requireGitCommit = (
  git: BenchmarkReport["environment"]["git"]
): string => {
  if (!git.commit || git.dirty !== false || git.unavailableReason !== null)
    throw new Error(
      "Demo source benchmark lacks clean immutable Git provenance"
    );
  return git.commit;
};

const requireVerifiedAskGitCommit = (
  git: VerifiedAskPromotionArtifact["environment"]["git"]
): string => {
  if (!/^[a-f0-9]{40}$/.test(git.commit) || git.dirty !== false)
    throw new Error("Verified Ask source lacks clean Git provenance");
  return git.commit;
};

export interface ContextCapsuleDemoSources {
  report: BenchmarkReport;
  verifiedAsk: VerifiedAskPromotionArtifact;
}

const deriveDemoSelection = (
  report: BenchmarkReport
): ContextCapsuleDemoArtifact["sourceBenchmark"]["selection"] => {
  const cohortScores = report.scores.filter(
    ({ trialId, seed, lifecycle, agentId, adapterId }) =>
      trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID &&
      seed === CONTEXT_CAPSULE_DEMO_SEED &&
      lifecycle === CONTEXT_CAPSULE_DEMO_LIFECYCLE &&
      agentId === CONTEXT_CAPSULE_DEMO_AGENT_ID &&
      (adapterId === "gno-mcp" || adapterId === "capsule")
  );
  const taskIds = [...new Set(cohortScores.map(({ taskId }) => taskId))].sort();
  const matchingTaskIds = taskIds.filter((taskId) => {
    const gno = cohortScores.filter(
      (score) => score.taskId === taskId && score.adapterId === "gno-mcp"
    );
    const capsule = cohortScores.filter(
      (score) => score.taskId === taskId && score.adapterId === "capsule"
    );
    return (
      gno.length === 1 &&
      capsule.length === 1 &&
      gno[0]?.score.success === 0 &&
      capsule[0]?.score.success === 1
    );
  });
  return {
    rule: "cold_gno_failure_capsule_success",
    cohortTaskCount: taskIds.length,
    matchingTaskIds,
    selectedTaskId: CONTEXT_CAPSULE_DEMO_TASK_ID,
  };
};

export const contextCapsuleDemoFingerprint = (
  artifact: Omit<ContextCapsuleDemoArtifact, "canonicalFingerprint">
): string => canonicalFingerprint(artifact);

export const validateContextCapsuleDemoArtifact = (
  artifact: ContextCapsuleDemoArtifact,
  sources?: ContextCapsuleDemoSources
): string[] => {
  const failures: string[] = [];
  try {
    assertAgenticSchema("context-capsule-demo", artifact);
  } catch (error) {
    failures.push(
      error instanceof Error ? error.message : "demo_schema_validation_failed"
    );
    return failures;
  }
  const { canonicalFingerprint: _fingerprint, ...projection } = artifact;
  if (
    contextCapsuleDemoFingerprint(projection) !== artifact.canonicalFingerprint
  )
    failures.push("demo_fingerprint_mismatch");
  if (
    artifact.lanes.map(({ adapterId }) => adapterId).join(",") !==
    ADAPTERS.join(",")
  )
    failures.push("demo_lane_order_or_identity_mismatch");
  if (
    artifact.sourceBenchmark.selection.selectedTaskId !==
      artifact.frozenInput.task.taskId ||
    artifact.sourceBenchmark.selection.matchingTaskIds.length !== 1 ||
    artifact.sourceBenchmark.selection.matchingTaskIds[0] !==
      artifact.frozenInput.task.taskId
  )
    failures.push("demo_selection_mismatch");
  const shared = artifact.frozenInput.sharedFingerprints;
  const identity = artifact.frozenInput.identity;
  const matchingEnvironmentTrials =
    artifact.frozenInput.environment.trials.filter(
      ({ trialId, seed }) =>
        trialId === identity.trialId && seed === identity.seed
    );
  if (
    artifact.frozenInput.environment.agentId !== identity.agentId ||
    matchingEnvironmentTrials.length !== 1 ||
    artifact.sourceBenchmark.runGitCommit !==
      artifact.frozenInput.environment.git.commit ||
    artifact.sourceBenchmark.fixtureFingerprint !== shared.corpus
  )
    failures.push("demo_environment_identity_mismatch");
  for (const lane of artifact.lanes) {
    const canonical = lane.receipt.canonical;
    if (
      lane.adapterId !== canonical.adapterId ||
      lane.label !== labels[lane.adapterId] ||
      canonical.taskId !== artifact.frozenInput.task.taskId ||
      canonical.trialId !== identity.trialId ||
      canonical.seed !== identity.seed ||
      canonical.agentId !== identity.agentId ||
      canonical.lifecycle !== artifact.frozenInput.lifecycle ||
      canonical.fingerprints.corpus !== shared.corpus ||
      canonical.fingerprints.prompt !== shared.prompt ||
      canonical.fingerprints.tools !== shared.tools ||
      canonical.fingerprints.model !== shared.model ||
      canonical.fingerprints.runtime !== shared.runtime ||
      canonical.fingerprints.index !== shared.index
    )
      failures.push(`demo_frozen_input_mismatch:${lane.adapterId}`);
    if (identityKey(canonical) !== identityKey(lane.score))
      failures.push(`demo_score_identity_mismatch:${lane.adapterId}`);
    if (
      canonicalJson(lane.metrics) !==
      canonicalJson(deriveLaneMetrics(lane.receipt, lane.score))
    )
      failures.push(`demo_lane_metrics_mismatch:${lane.adapterId}`);
  }
  const capsule = artifact.lanes.find(
    ({ adapterId }) => adapterId === "capsule"
  );
  try {
    if (!capsule) throw new Error("missing capsule lane");
    const parsed = parseCapsulePayload(capsule.receipt);
    const compactRetrieval = parsed.payload.r;
    if (
      canonicalJson(artifact.capsuleRetrieval.request) !==
        canonicalJson({
          toolName: parsed.call.toolName,
          arguments: parsed.call.arguments,
        }) ||
      artifact.capsuleRetrieval.effectiveIndexFingerprint !==
        capsule.receipt.canonical.fingerprints.index ||
      compactRetrieval?.[1] !==
        artifact.capsuleRetrieval.effectiveIndexFingerprint ||
      canonicalJson(artifact.capsuleRetrieval.capabilityStates) !==
        canonicalJson(capsule.receipt.canonical.capabilities) ||
      canonicalJson(artifact.capsuleRetrieval.fallbacks) !==
        canonicalJson(parsed.fallbacks) ||
      canonicalJson(artifact.capsuleRetrieval.normalizedPayload) !==
        canonicalJson(parsed.payload)
    )
      throw new Error("capsule contract drift");
  } catch {
    failures.push("demo_capsule_retrieval_contract_mismatch");
  }
  if (sources) {
    if (
      reportFingerprintFailures(sources.report).length > 0 ||
      artifact.sourceBenchmark.benchmarkId !== sources.report.benchmarkId ||
      artifact.sourceBenchmark.canonicalFingerprint !==
        sources.report.canonicalFingerprint ||
      artifact.sourceBenchmark.fixtureFingerprint !==
        sources.report.fixtureFingerprint ||
      artifact.sourceBenchmark.runGitCommit !==
        sources.report.environment.git.commit ||
      canonicalJson(artifact.sourceBenchmark.selection) !==
        canonicalJson(deriveDemoSelection(sources.report)) ||
      canonicalJson(artifact.frozenInput.environment) !==
        canonicalJson(sources.report.environment)
    )
      failures.push("demo_source_report_mismatch");
    if (
      artifact.verifiedAsk.benchmarkId !== sources.verifiedAsk.benchmarkId ||
      artifact.verifiedAsk.canonicalFingerprint !==
        sources.verifiedAsk.canonicalFingerprint ||
      artifact.verifiedAsk.runGitCommit !==
        sources.verifiedAsk.environment.git.commit ||
      artifact.verifiedAsk.pairCount !==
        sources.verifiedAsk.promotion.pairCount ||
      canonicalJson(artifact.verifiedAsk.excludedTasks) !==
        canonicalJson(sources.verifiedAsk.excludedTasks) ||
      canonicalJson(artifact.verifiedAsk.metrics) !==
        canonicalJson(sources.verifiedAsk.promotion.metrics)
    )
      failures.push("demo_verified_ask_source_mismatch");
  }
  return failures;
};

export const buildContextCapsuleDemoArtifact = async (
  providedSources?: ContextCapsuleDemoSources
): Promise<ContextCapsuleDemoArtifact> => {
  const report =
    providedSources?.report ??
    ((await Bun.file(
      join(BASELINE_ROOT, "report.json")
    ).json()) as BenchmarkReport);
  assertAgenticSchema("benchmark-report", report);
  const reportFailures = reportFingerprintFailures(report);
  if (reportFailures.length > 0) throw new Error(reportFailures.join(","));
  const fixture = await loadAgenticFixture();
  const task = fixture.tasks.get(CONTEXT_CAPSULE_DEMO_TASK_ID);
  const oracle = fixture.oracles.get(CONTEXT_CAPSULE_DEMO_TASK_ID);
  if (!(task && oracle))
    throw new Error("Frozen demo task or oracle is missing");
  const verifiedAsk =
    providedSources?.verifiedAsk ??
    ((await Bun.file(
      join(BASELINE_ROOT, "verified-ask-promotion.json")
    ).json()) as VerifiedAskPromotionArtifact);
  const verifiedFailures = validateVerifiedAskPromotionArtifact(
    verifiedAsk,
    fixture.oracles
  );
  if (verifiedFailures.length > 0)
    throw new Error(
      `Verified Ask proof is invalid: ${verifiedFailures.join(",")}`
    );

  const lanes = ADAPTERS.map((adapterId) => {
    const receipts = report.receipts.filter(
      ({ canonical }) =>
        canonical.taskId === CONTEXT_CAPSULE_DEMO_TASK_ID &&
        canonical.lifecycle === CONTEXT_CAPSULE_DEMO_LIFECYCLE &&
        canonical.trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID &&
        canonical.seed === CONTEXT_CAPSULE_DEMO_SEED &&
        canonical.agentId === CONTEXT_CAPSULE_DEMO_AGENT_ID &&
        canonical.adapterId === adapterId
    );
    if (receipts.length !== 1 || !receipts[0])
      throw new Error(
        `Expected exactly one frozen ${adapterId} demo receipt; found ${receipts.length}`
      );
    const receipt = receipts[0];
    const scores = report.scores.filter(
      (score) => identityKey(score) === identityKey(receipt.canonical)
    );
    if (scores.length !== 1 || !scores[0])
      throw new Error(
        `Expected exactly one frozen ${adapterId} demo score; found ${scores.length}`
      );
    const score = scores[0];
    return buildLane(adapterId, receipt, score);
  });
  const capsule = lanes[2]!;
  const capsulePayload = parseCapsulePayload(capsule.receipt);
  const sharedFingerprints = {
    corpus: capsule.receipt.canonical.fingerprints.corpus,
    prompt: capsule.receipt.canonical.fingerprints.prompt,
    tools: capsule.receipt.canonical.fingerprints.tools,
    model: capsule.receipt.canonical.fingerprints.model,
    runtime: capsule.receipt.canonical.fingerprints.runtime,
    index: capsule.receipt.canonical.fingerprints.index,
  };
  const oracleClaim = oracle.claims[0];
  if (!oracleClaim) throw new Error("Frozen demo oracle has no claim");
  const runGitCommit = requireGitCommit(report.environment.git);
  const selection = deriveDemoSelection(report);
  if (
    selection.cohortTaskCount !== 24 ||
    selection.matchingTaskIds.length !== 1 ||
    selection.matchingTaskIds[0] !== CONTEXT_CAPSULE_DEMO_TASK_ID
  )
    throw new Error(
      "Demo selection rule no longer identifies the sole expected task in the 24-task cohort"
    );
  const partial: Omit<ContextCapsuleDemoArtifact, "canonicalFingerprint"> = {
    schemaVersion: "1.0",
    demoId: CONTEXT_CAPSULE_DEMO_ID,
    sourceBenchmark: {
      benchmarkId: report.benchmarkId,
      canonicalFingerprint: report.canonicalFingerprint,
      fixtureFingerprint: report.fixtureFingerprint,
      runGitCommit,
      reportPath:
        "evals/fixtures/agentic-retrieval/baseline/fixture-agent/report.json",
      selection,
    },
    frozenInput: {
      task,
      expected: {
        claimKey: oracleClaim.claimKey,
        value: oracleClaim.expectedValue,
        evidence: oracleClaim.requiredEvidence,
      },
      environment: report.environment,
      identity: {
        trialId: CONTEXT_CAPSULE_DEMO_TRIAL_ID,
        seed: CONTEXT_CAPSULE_DEMO_SEED,
        agentId: CONTEXT_CAPSULE_DEMO_AGENT_ID,
      },
      lifecycle: CONTEXT_CAPSULE_DEMO_LIFECYCLE,
      sharedFingerprints,
    },
    methodology: [
      "One frozen fixture task, outer agent, trial, seed, lifecycle, corpus, prompt, tool contract, model, runtime, and effective index are compared across all three lanes.",
      "The lexical lane is the no-GNO retrieval baseline; current GNO uses shipped MCP query/get primitives; the Capsule lane is an evaluation-only lexical prototype using the production model-visible Context Capsule serialization contract.",
      "Exact hidden-oracle values and source spans score the final structured envelope without an LLM judge.",
      "UTF-8 bytes include each complete normalized model-visible tool-result envelope. Tokens remain unavailable because the run did not use one pinned comparable tokenizer.",
      "End-to-end latency is reported only for the matching cold lifecycle on the recorded environment; preparation is outside the scored interval.",
    ],
    variance: {
      trialCount: 1,
      estimate: null,
      unavailableReason:
        "This deterministic demonstration has one frozen trial; it is not a statistical latency or quality estimate.",
    },
    limitations: [
      ...report.limitations,
      "This page reports one controlled exact-identifier task. It does not extrapolate general product superiority.",
      "This task is the sole cold-lifecycle current-GNO failure / Capsule success case among the authoritative 24-task cohort; it was selected to demonstrate the behavioral difference, not as a representative sample.",
      "The Capsule lane is an evaluation-only lexical prototype. Its recorded latency is not the shipped Context Capsule path and is not product-equivalent.",
    ],
    lanes,
    capsuleRetrieval: {
      request: {
        toolName: capsulePayload.call.toolName,
        arguments: capsulePayload.call.arguments,
      },
      effectiveIndexFingerprint: capsule.receipt.canonical.fingerprints.index,
      capabilityStates: capsule.receipt.canonical.capabilities,
      fallbacks: capsulePayload.fallbacks,
      normalizedPayload: capsulePayload.payload,
    },
    verifiedAsk: {
      proofKind: "answer_enforcement",
      benchmarkId: verifiedAsk.benchmarkId,
      canonicalFingerprint: verifiedAsk.canonicalFingerprint,
      runGitCommit: requireVerifiedAskGitCommit(verifiedAsk.environment.git),
      artifactPath:
        "evals/fixtures/agentic-retrieval/baseline/fixture-agent/verified-ask-promotion.json",
      pairCount: verifiedAsk.promotion.pairCount,
      excludedTasks: verifiedAsk.excludedTasks,
      metrics: verifiedAsk.promotion.metrics,
    },
  };
  const artifact = {
    ...partial,
    canonicalFingerprint: contextCapsuleDemoFingerprint(partial),
  };
  const failures = validateContextCapsuleDemoArtifact(artifact, {
    report,
    verifiedAsk,
  });
  if (failures.length > 0)
    throw new Error(`Context Capsule demo is invalid: ${failures.join(",")}`);
  return artifact;
};
