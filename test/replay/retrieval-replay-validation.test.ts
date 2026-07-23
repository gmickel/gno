import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ReplayRetrievalTraceInput } from "../../src/core/retrieval-replay-types";

import { createDefaultConfig } from "../../src/config";
import { parseReplayRetrievalTraceInput } from "../../src/core/retrieval-replay-validation";
import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import {
  createReplayTestHarness,
  type ReplayTestHarness,
} from "./retrieval-replay-fixture";

const replayDeps = {
  config: createDefaultConfig(),
  vectorIndex: null,
  embedPort: null,
  expandPort: null,
  rerankPort: null,
  indexName: "default",
};
const validInput = {
  exportId: "export",
  candidate: { id: "candidate", type: "hybrid" },
} as const;

describe("retrieval replay input validation", () => {
  let harness: ReplayTestHarness;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("rejects malformed candidates before reading the export manifest", async () => {
    let manifestReads = 0;
    const originalRead = harness.store.getRetrievalTraceExportBundle.bind(
      harness.store
    );
    harness.store.getRetrievalTraceExportBundle = async (exportId) => {
      manifestReads += 1;
      return await originalRead(exportId);
    };
    const invalid: unknown[] = [
      null,
      {},
      { ...validInput, extra: true },
      { exportId: "", candidate: validInput.candidate },
      { exportId: "export", candidate: null },
      { ...validInput, candidate: { id: "", type: "hybrid" } },
      { ...validInput, candidate: { id: "candidate", type: "lexical" } },
      { ...validInput, candidate: { ...validInput.candidate, extra: true } },
      { ...validInput, candidate: { ...validInput.candidate, limit: 0 } },
      { ...validInput, candidate: { ...validInput.candidate, limit: -1 } },
      { ...validInput, candidate: { ...validInput.candidate, limit: 1.5 } },
      { ...validInput, candidate: { ...validInput.candidate, limit: NaN } },
      {
        ...validInput,
        candidate: { ...validInput.candidate, limit: Number.POSITIVE_INFINITY },
      },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          candidateLimit: 10_001,
        },
      },
      { ...validInput, candidate: { ...validInput.candidate, limit: "5" } },
      { ...validInput, candidate: { ...validInput.candidate, noExpand: 1 } },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          queryModes: [{ mode: "lexical", text: "decision" }],
        },
      },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          queryModes: [{ mode: "term", text: " " }],
        },
      },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          queryModes: [
            { mode: "term", text: " café " },
            { mode: "term", text: "cafe\u0301" },
          ],
        },
      },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          queryModes: [
            { mode: "hyde", text: "first" },
            { mode: "hyde", text: "second" },
          ],
        },
      },
      {
        ...validInput,
        candidate: {
          ...validInput.candidate,
          queryModes: [{ mode: "term", text: "decision", extra: true }],
        },
      },
    ];
    const service = new RetrievalTraceManagementService(harness.store);
    for (const input of invalid) {
      const replayed = await service.replay(
        input as ReplayRetrievalTraceInput,
        replayDeps
      );
      expect(replayed.ok).toBeFalse();
      if (!replayed.ok) expect(replayed.error.code).toBe("INVALID_INPUT");
    }
    expect(manifestReads).toBe(0);
  });

  test("normalizes valid query modes and accepts finite safe bounds", () => {
    const parsed = parseReplayRetrievalTraceInput({
      exportId: " export ",
      candidate: {
        id: " candidate ",
        type: "hybrid",
        limit: 1,
        candidateLimit: 10_000,
        noExpand: false,
        noRerank: true,
        queryModes: [
          { mode: "term", text: " café " },
          { mode: "term", text: "second" },
          { mode: "intent", text: "intent" },
          { mode: "hyde", text: "hypothesis" },
        ],
      },
    });
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      exportId: "export",
      candidate: {
        id: "candidate",
        limit: 1,
        candidateLimit: 10_000,
        noExpand: false,
        noRerank: true,
        queryModes: [
          { mode: "term", text: "café" },
          { mode: "term", text: "second" },
          { mode: "intent", text: "intent" },
          { mode: "hyde", text: "hypothesis" },
        ],
      },
    });
  });
});
