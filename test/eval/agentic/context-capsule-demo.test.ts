import { describe, expect, test } from "bun:test";
// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import type { ContextCapsuleDemoArtifact } from "../../../evals/agentic/demos/context-capsule";

import { canonicalJson } from "../../../evals/agentic/canonical";
import {
  buildContextCapsuleDemoArtifact,
  CONTEXT_CAPSULE_DEMO_ROOT,
  renderContextCapsuleDemoMarkdown,
  validateContextCapsuleDemoArtifact,
} from "../../../evals/agentic/demos/context-capsule";
import { validateAgenticSchema } from "../../../evals/agentic/validation";

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
});
