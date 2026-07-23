import { describe, expect, test } from "bun:test";
// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import type {
  ContextCapsuleDemoArtifact,
  ContextCapsuleDemoSources,
} from "../../../evals/agentic/demos/context-capsule";

import {
  canonicalFingerprint,
  canonicalJson,
} from "../../../evals/agentic/canonical";
import {
  buildContextCapsuleDemoArtifact,
  contextCapsuleDemoFingerprint,
  CONTEXT_CAPSULE_DEMO_AGENT_ID,
  CONTEXT_CAPSULE_DEMO_ROOT,
  CONTEXT_CAPSULE_DEMO_SEED,
  CONTEXT_CAPSULE_DEMO_TRIAL_ID,
  renderContextCapsuleDemoMarkdown,
  validateContextCapsuleDemoArtifact,
} from "../../../evals/agentic/demos/context-capsule";
import { AGENTIC_FIXTURE_ROOT } from "../../../evals/agentic/fixture-db";
import { benchmarkCanonicalProjection } from "../../../evals/agentic/report";
import { validateAgenticSchema } from "../../../evals/agentic/validation";

const BASELINE_ROOT = join(AGENTIC_FIXTURE_ROOT, "baseline", "fixture-agent");

const loadSources = async (): Promise<ContextCapsuleDemoSources> => ({
  report: await Bun.file(join(BASELINE_ROOT, "report.json")).json(),
  verifiedAsk: await Bun.file(
    join(BASELINE_ROOT, "verified-ask-promotion.json")
  ).json(),
});

const resealReport = (
  sources: ContextCapsuleDemoSources
): ContextCapsuleDemoSources => {
  const { canonicalFingerprint: _fingerprint, ...projection } = sources.report;
  sources.report.canonicalFingerprint = canonicalFingerprint(
    benchmarkCanonicalProjection(projection)
  );
  return sources;
};

const resealArtifact = (
  artifact: ContextCapsuleDemoArtifact
): ContextCapsuleDemoArtifact => {
  const { canonicalFingerprint: _fingerprint, ...projection } = artifact;
  artifact.canonicalFingerprint = contextCapsuleDemoFingerprint(projection);
  return artifact;
};

const expectRejection = async (
  promise: Promise<unknown>,
  message: string
): Promise<void> => {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(message);
};

describe("Context Capsule public demo", () => {
  test("rebuilds the committed three-way artifact exactly", async () => {
    const artifact = await buildContextCapsuleDemoArtifact();
    const committed = (await Bun.file(
      join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.json")
    ).json()) as ContextCapsuleDemoArtifact;
    expect(artifact).toEqual(committed);
    expect(canonicalJson(artifact)).toBe(canonicalJson(committed));
    expect(validateAgenticSchema("context-capsule-demo", artifact)).toBeTrue();
    expect(validateContextCapsuleDemoArtifact(artifact)).toEqual([]);
    expect(
      await Bun.file(
        join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.md")
      ).text()
    ).toBe(renderContextCapsuleDemoMarkdown(artifact));
  });

  test("preserves one frozen input and the raw normalized lane receipts", async () => {
    const artifact = await buildContextCapsuleDemoArtifact();
    expect(artifact.lanes.map(({ adapterId }) => adapterId)).toEqual([
      "lexical",
      "gno-mcp",
      "capsule",
    ]);
    expect(
      new Set(
        artifact.lanes.map(
          ({ receipt }) => receipt.canonical.fingerprints.index
        )
      )
    ).toEqual(new Set([artifact.frozenInput.sharedFingerprints.index]));
    expect(
      new Set(artifact.lanes.map(({ receipt }) => receipt.canonical.taskId))
    ).toEqual(new Set([artifact.frozenInput.task.taskId]));
    expect(artifact.capsuleRetrieval.request).toEqual({
      toolName: "search",
      arguments: {
        collection: "c001",
        query: "incident identifier",
      },
    });
    expect(artifact.capsuleRetrieval.effectiveIndexFingerprint).toBe(
      artifact.frozenInput.sharedFingerprints.index
    );
    expect(artifact.capsuleRetrieval.fallbacks).toEqual([]);
    expect(artifact.capsuleRetrieval.normalizedPayload).toMatchObject({
      v: "gno-context-agent-v1",
    });
    expect(
      artifact.lanes.every(
        ({ metrics }) =>
          metrics.measuredTokens === null &&
          metrics.tokenUnavailableReason !== null
      )
    ).toBeTrue();
  });

  test("keeps verified Ask separate and rejects canonical tampering", async () => {
    const artifact = await buildContextCapsuleDemoArtifact();
    expect(artifact.verifiedAsk).toMatchObject({
      proofKind: "answer_enforcement",
      benchmarkId: "verified-ask-outcome@1",
      pairCount: 22,
      metrics: {
        baselineAnswerAccuracy: 18 / 22,
        candidateAnswerAccuracy: 18 / 22,
        baselineUnsupportedSubstantiveClaims: 4,
        candidateUnsupportedSubstantiveClaims: 0,
        unsupportedSubstantiveClaimReduction: 1,
      },
    });
    expect(artifact.verifiedAsk.excludedTasks).toEqual([
      { taskId: "t234cd5e", reason: "expected_missing_evidence" },
      { taskId: "t345de6f", reason: "expected_missing_evidence" },
    ]);
    const tampered = structuredClone(artifact);
    tampered.lanes[0]!.metrics.agentCalls += 1;
    expect(validateContextCapsuleDemoArtifact(tampered)).toContain(
      "demo_fingerprint_mismatch"
    );
  });

  test("selects the exact frozen identity from a multi-trial report", async () => {
    const sources = await loadSources();
    sources.report.environment.trials.push({
      trialId: "fixture-02",
      seed: 1,
    });
    const receipts = sources.report.receipts
      .filter(
        ({ canonical }) =>
          canonical.taskId === "t0a1b2c3" &&
          canonical.lifecycle === "cold" &&
          canonical.trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID
      )
      .map((receipt) => {
        const clone = structuredClone(receipt);
        clone.canonical.trialId = "fixture-02";
        clone.canonical.seed = 1;
        return clone;
      });
    const scores = sources.report.scores
      .filter(
        (score) =>
          score.taskId === "t0a1b2c3" &&
          score.lifecycle === "cold" &&
          score.trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID
      )
      .map((score) => ({
        ...structuredClone(score),
        trialId: "fixture-02",
        seed: 1,
      }));
    sources.report.receipts.unshift(...receipts);
    sources.report.scores.unshift(...scores);
    const artifact = await buildContextCapsuleDemoArtifact(
      resealReport(sources)
    );
    expect(
      artifact.lanes.every(
        ({ receipt }) =>
          receipt.canonical.trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID &&
          receipt.canonical.seed === CONTEXT_CAPSULE_DEMO_SEED &&
          receipt.canonical.agentId === CONTEXT_CAPSULE_DEMO_AGENT_ID
      )
    ).toBeTrue();
  });

  test("rejects ambiguous selection and source fingerprint drift", async () => {
    const duplicateSources = await loadSources();
    const duplicate = duplicateSources.report.receipts.find(
      ({ canonical }) =>
        canonical.taskId === "t0a1b2c3" &&
        canonical.lifecycle === "cold" &&
        canonical.adapterId === "capsule" &&
        canonical.trialId === CONTEXT_CAPSULE_DEMO_TRIAL_ID
    );
    expect(duplicate).toBeDefined();
    duplicateSources.report.receipts.push(structuredClone(duplicate!));
    await expectRejection(
      buildContextCapsuleDemoArtifact(resealReport(duplicateSources)),
      "Expected exactly one frozen capsule demo receipt"
    );

    const reportDrift = await loadSources();
    reportDrift.report.methodology[0] = "tampered";
    await expectRejection(
      buildContextCapsuleDemoArtifact(reportDrift),
      "source_report_fingerprint_mismatch"
    );

    const verifiedDrift = await loadSources();
    verifiedDrift.verifiedAsk.methodology[0] = "tampered";
    await expectRejection(
      buildContextCapsuleDemoArtifact(verifiedDrift),
      "Verified Ask proof is invalid"
    );
  });

  test("rejects resealed identity, metric, and Capsule payload drift", async () => {
    const artifact = await buildContextCapsuleDemoArtifact();

    const identityDrift = resealArtifact(structuredClone(artifact));
    identityDrift.frozenInput.identity.trialId = "wrong-trial";
    resealArtifact(identityDrift);
    expect(validateContextCapsuleDemoArtifact(identityDrift)).toContain(
      "demo_environment_identity_mismatch"
    );

    const metricDrift = resealArtifact(structuredClone(artifact));
    metricDrift.lanes[0]!.metrics.agentCalls += 1;
    resealArtifact(metricDrift);
    expect(validateContextCapsuleDemoArtifact(metricDrift)).toContain(
      "demo_lane_metrics_mismatch:lexical"
    );

    const fallbackDrift = resealArtifact(structuredClone(artifact));
    fallbackDrift.capsuleRetrieval.fallbacks.push("tampered");
    resealArtifact(fallbackDrift);
    expect(validateContextCapsuleDemoArtifact(fallbackDrift)).toContain(
      "demo_capsule_retrieval_contract_mismatch"
    );

    const payloadDrift = resealArtifact(structuredClone(artifact));
    payloadDrift.capsuleRetrieval.normalizedPayload = { tampered: true };
    resealArtifact(payloadDrift);
    expect(validateContextCapsuleDemoArtifact(payloadDrift)).toContain(
      "demo_capsule_retrieval_contract_mismatch"
    );
  });
});
