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

export const CONTEXT_CAPSULE_DEMO_ID = "context-capsule-demo@1";
export const CONTEXT_CAPSULE_DEMO_TASK_ID = "t0a1b2c3";
export const CONTEXT_CAPSULE_DEMO_LIFECYCLE = "cold" as const;

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

const buildLane = (
  adapterId: ContextCapsuleDemoAdapterId,
  receipt: TrajectoryReceipt,
  score: BenchmarkScoreRecord
): ContextCapsuleDemoLane => ({
  adapterId,
  label: labels[adapterId],
  receipt,
  score,
  metrics: {
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
  },
});

const parseCapsulePayload = (receipt: TrajectoryReceipt): unknown => {
  const call = receipt.canonical.calls.find(
    ({ deliveredToAgent, result }) =>
      deliveredToAgent && result.resultRole === "evidence_bundle"
  );
  if (!call) throw new Error("Demo Capsule has no delivered evidence bundle");
  return JSON.parse(call.result.content) as unknown;
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

export const contextCapsuleDemoFingerprint = (
  artifact: Omit<ContextCapsuleDemoArtifact, "canonicalFingerprint">
): string => canonicalFingerprint(artifact);

export const validateContextCapsuleDemoArtifact = (
  artifact: ContextCapsuleDemoArtifact
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
  const shared = artifact.frozenInput.sharedFingerprints;
  for (const lane of artifact.lanes) {
    const canonical = lane.receipt.canonical;
    if (
      canonical.taskId !== artifact.frozenInput.task.taskId ||
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
  }
  const capsule = artifact.lanes.find(
    ({ adapterId }) => adapterId === "capsule"
  );
  const firstCall = capsule?.receipt.canonical.calls[0];
  if (
    !capsule ||
    !firstCall ||
    canonicalJson(artifact.capsuleRetrieval.request) !==
      canonicalJson({
        toolName: firstCall.toolName,
        arguments: firstCall.arguments,
      }) ||
    artifact.capsuleRetrieval.effectiveIndexFingerprint !==
      capsule.receipt.canonical.fingerprints.index ||
    canonicalJson(artifact.capsuleRetrieval.capabilityStates) !==
      canonicalJson(capsule.receipt.canonical.capabilities)
  )
    failures.push("demo_capsule_retrieval_contract_mismatch");
  return failures;
};

export const buildContextCapsuleDemoArtifact =
  async (): Promise<ContextCapsuleDemoArtifact> => {
    const report = (await Bun.file(
      join(BASELINE_ROOT, "report.json")
    ).json()) as BenchmarkReport;
    assertAgenticSchema("benchmark-report", report);
    const reportFailures = reportFingerprintFailures(report);
    if (reportFailures.length > 0) throw new Error(reportFailures.join(","));
    const fixture = await loadAgenticFixture();
    const task = fixture.tasks.get(CONTEXT_CAPSULE_DEMO_TASK_ID);
    const oracle = fixture.oracles.get(CONTEXT_CAPSULE_DEMO_TASK_ID);
    if (!(task && oracle))
      throw new Error("Frozen demo task or oracle is missing");
    const verifiedAsk = (await Bun.file(
      join(BASELINE_ROOT, "verified-ask-promotion.json")
    ).json()) as VerifiedAskPromotionArtifact;
    const verifiedFailures = validateVerifiedAskPromotionArtifact(
      verifiedAsk,
      fixture.oracles
    );
    if (verifiedFailures.length > 0)
      throw new Error(
        `Verified Ask proof is invalid: ${verifiedFailures.join(",")}`
      );

    const scoreByIdentity = new Map(
      report.scores.map((score) => [identityKey(score), score])
    );
    const lanes = ADAPTERS.map((adapterId) => {
      const receipt = report.receipts.find(
        ({ canonical }) =>
          canonical.taskId === CONTEXT_CAPSULE_DEMO_TASK_ID &&
          canonical.lifecycle === CONTEXT_CAPSULE_DEMO_LIFECYCLE &&
          canonical.adapterId === adapterId
      );
      if (!receipt) throw new Error(`Missing frozen ${adapterId} demo receipt`);
      const score = scoreByIdentity.get(identityKey(receipt.canonical));
      if (!score) throw new Error(`Missing frozen ${adapterId} demo score`);
      return buildLane(adapterId, receipt, score);
    });
    const capsule = lanes[2]!;
    const firstCapsuleCall = capsule.receipt.canonical.calls[0];
    if (!firstCapsuleCall)
      throw new Error("Frozen Capsule receipt has no call");
    const payload = parseCapsulePayload(capsule.receipt) as {
      r?: unknown[];
    };
    const payloadFallbacks =
      Array.isArray(payload.r) && Array.isArray(payload.r[7])
        ? payload.r[7]
        : [];
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
    const immutableGitCommit = requireGitCommit(report.environment.git);
    const partial: Omit<ContextCapsuleDemoArtifact, "canonicalFingerprint"> = {
      schemaVersion: "1.0",
      demoId: CONTEXT_CAPSULE_DEMO_ID,
      sourceBenchmark: {
        benchmarkId: report.benchmarkId,
        canonicalFingerprint: report.canonicalFingerprint,
        fixtureFingerprint: report.fixtureFingerprint,
        immutableGitCommit,
        reportPath:
          "evals/fixtures/agentic-retrieval/baseline/fixture-agent/report.json",
      },
      frozenInput: {
        task,
        expected: {
          claimKey: oracleClaim.claimKey,
          value: oracleClaim.expectedValue,
          evidence: oracleClaim.requiredEvidence,
        },
        environment: report.environment,
        lifecycle: CONTEXT_CAPSULE_DEMO_LIFECYCLE,
        sharedFingerprints,
      },
      methodology: [
        "One frozen fixture task, outer agent, trial, seed, lifecycle, corpus, prompt, tool contract, model, runtime, and effective index are compared across all three lanes.",
        "The lexical lane is the no-GNO retrieval baseline; current GNO uses shipped MCP query/get primitives; the Capsule lane uses the production model-visible Context Capsule projection.",
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
      ],
      lanes,
      capsuleRetrieval: {
        request: {
          toolName: firstCapsuleCall.toolName,
          arguments: firstCapsuleCall.arguments,
        },
        effectiveIndexFingerprint: capsule.receipt.canonical.fingerprints.index,
        capabilityStates: capsule.receipt.canonical.capabilities,
        fallbacks: payloadFallbacks,
        normalizedPayload: payload,
      },
      verifiedAsk: {
        proofKind: "answer_enforcement",
        benchmarkId: verifiedAsk.benchmarkId,
        canonicalFingerprint: verifiedAsk.canonicalFingerprint,
        immutableGitCommit: verifiedAsk.environment.git.commit,
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
    const failures = validateContextCapsuleDemoArtifact(artifact);
    if (failures.length > 0)
      throw new Error(`Context Capsule demo is invalid: ${failures.join(",")}`);
    return artifact;
  };

const metric = (value: number | null): string =>
  value === null ? "unavailable" : String(value);

export const renderContextCapsuleDemoMarkdown = (
  artifact: ContextCapsuleDemoArtifact
): string => {
  const tableRows = artifact.lanes.map(({ label, metrics }) => [
    label,
    metrics.stopOutcome,
    String(metrics.success),
    String(metrics.substantiveClaimEvidenceCoverage),
    String(metrics.agentCalls),
    String(metrics.modelVisibleUtf8Bytes),
    metric(metrics.measuredTokens),
    metric(metrics.endToEnd.valueMs),
  ]);
  const headers = [
    "Lane",
    "Stop outcome",
    "Success",
    "Evidence coverage",
    "Agent calls",
    "Context bytes",
    "Tokens",
    "Cold end-to-end ms",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index]!.length))
  );
  const formatRow = (row: readonly string[]): string =>
    `| ${row
      .map((value, index) =>
        index < 2
          ? value.padEnd(widths[index]!)
          : value.padStart(widths[index]!)
      )
      .join(" | ")} |`;
  const separator = widths.map((width, index) =>
    index < 2 ? "-".repeat(width) : `${"-".repeat(width - 1)}:`
  );
  const rows = [
    formatRow(headers),
    formatRow(separator),
    ...tableRows.map(formatRow),
  ].join("\n");
  const evidence = artifact.frozenInput.expected.evidence[0];
  const verified = artifact.verifiedAsk.metrics;
  return `# Context Capsule: one frozen agent outcome

Canonical fingerprint: \`${artifact.canonicalFingerprint}\`

This is one controlled exact-identifier task, not a general superiority claim.

## Frozen task

> ${artifact.frozenInput.task.brief.goal}

Expected answer: \`${String((artifact.frozenInput.expected.value as { value?: unknown }).value)}\`

Exact evidence: \`${evidence?.uri}:${evidence?.startLine}-${evidence?.endLine}\`  
Source SHA-256: \`${evidence?.sourceHash}\`  
Span SHA-256: \`${evidence?.spanHash}\`

## Measured outcome

${rows}

Tokens are unavailable because this run did not use one pinned comparable tokenizer.
Latency is the single matching cold-lifecycle observation on the recorded environment.

## Methodology

${artifact.methodology.map((item) => `- ${item}`).join("\n")}

Variance: ${artifact.variance.unavailableReason}

## Capsule retrieval contract

- Request: \`${canonicalJson(artifact.capsuleRetrieval.request)}\`
- Effective index: \`${artifact.capsuleRetrieval.effectiveIndexFingerprint}\`
- Fallbacks: \`${canonicalJson(artifact.capsuleRetrieval.fallbacks)}\`
- Capability states and the complete normalized payload are retained in the JSON artifact.

## Separate Verified Ask answer-enforcement proof

This is not a retrieval lane and its answer metrics are not retrieval metrics.

- Frozen paired cohort: ${artifact.verifiedAsk.pairCount}
- Excluded missing-evidence tasks: ${artifact.verifiedAsk.excludedTasks.map(({ taskId }) => taskId).join(", ")}
- Answer accuracy, raw/verified: ${verified.baselineAnswerAccuracy} / ${verified.candidateAnswerAccuracy}
- Unsupported substantive claims, raw/verified: ${verified.baselineUnsupportedSubstantiveClaims} / ${verified.candidateUnsupportedSubstantiveClaims}
- Unsupported-claim reduction: ${verified.unsupportedSubstantiveClaimReduction}

## Limitations

${artifact.limitations.map((item) => `- ${item}`).join("\n")}
`;
};

const main = async (): Promise<void> => {
  const artifact = await buildContextCapsuleDemoArtifact();
  const jsonPath = join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.json");
  const markdownPath = join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.md");
  await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await Bun.write(markdownPath, renderContextCapsuleDemoMarkdown(artifact));
  await Bun.$`bunx oxfmt ${jsonPath} ${markdownPath}`.quiet();
};

if (import.meta.main) await main();
