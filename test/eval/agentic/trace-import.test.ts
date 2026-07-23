import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RetrievalTraceQrelsArtifact } from "../../../src/core/retrieval-qrels";

import { importTraceQrels } from "../../../evals/agentic/trace-import";
import {
  createReplayTestHarness,
  replaySha256,
  type ReplayTestHarness,
} from "../../replay/retrieval-replay-fixture";

const rejectionMessage = async (
  operation: Promise<unknown>
): Promise<string> => {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
};

describe("trace qrels fn-97 import verification", () => {
  let harness: ReplayTestHarness;
  let artifact: RetrievalTraceQrelsArtifact;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
    const { service } = await harness.buildReceipt();
    const exported = await service.export({
      traceIds: ["replay-trace"],
      format: "qrels",
    });
    if (!exported.ok || exported.value.artifact.format !== "qrels") {
      throw new Error("qrels export missing");
    }
    artifact = exported.value.artifact;
  });

  afterEach(async () => {
    await harness.close();
  });

  test("rejects missing and stale canonical mirror content", async () => {
    expect(
      await rejectionMessage(
        importTraceQrels(artifact, { resolve: async () => null })
      )
    ).toContain("Trace evidence source is missing");
    expect(
      await rejectionMessage(
        importTraceQrels(artifact, {
          resolve: async () => ({ content: "stale converted content" }),
        })
      )
    ).toContain("Trace evidence mirror is stale");
  });

  test("accepts proven converted content using mirror identity", async () => {
    const converted = structuredClone(artifact);
    const ranked = converted.cases[0]?.baseline.ranked[0];
    const relevant = converted.cases[0]?.qrels.find(
      (qrel) => qrel.label === "relevant"
    );
    if (!(ranked && relevant?.evidence)) throw new Error("evidence missing");
    const originalSourceHash = replaySha256("original binary source bytes");
    ranked.sourceHash = originalSourceHash;
    relevant.target.sourceHash = originalSourceHash;
    relevant.evidence.sourceHash = originalSourceHash;

    const imported = await importTraceQrels(converted, {
      resolve: async () => ({ content: "Alpha decision approved" }),
    });
    const coordinate = imported.oracles[0]?.claims[0]?.requiredEvidence[0];
    expect(coordinate?.sourceHash).toBe(ranked.mirrorHash);
    expect(coordinate?.sourceHash).not.toBe(originalSourceHash);
    expect(imported.snapshot.files[0]?.sourceHash).toBe(ranked.mirrorHash);
  });

  test("rejects incomplete exact coordinates", async () => {
    const incomplete = structuredClone(artifact);
    const ranked = incomplete.cases[0]?.baseline.ranked[0];
    const relevant = incomplete.cases[0]?.qrels.find(
      (qrel) => qrel.label === "relevant"
    );
    if (!(ranked && relevant?.evidence)) throw new Error("evidence missing");
    ranked.endLine = 2;
    relevant.evidence.endLine = 2;
    expect(
      await rejectionMessage(
        importTraceQrels(incomplete, {
          resolve: async () => ({ content: "Alpha decision approved" }),
        })
      )
    ).toContain("exceeds source line count");
  });
});
