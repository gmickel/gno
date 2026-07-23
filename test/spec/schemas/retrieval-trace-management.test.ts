import { describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const HASH = "a".repeat(64);
const summary = {
  traceId: "trace-1",
  schemaVersion: "1.0",
  redactionMode: "metadata",
  replayCapable: false,
  status: "completed",
  queryShape: { characters: 8, terms: 2 },
  goalShape: { characters: 0, terms: 0 },
  fingerprints: {
    pipeline: HASH,
    model: HASH,
    config: HASH,
    index: HASH,
  },
  createdAtMs: 100,
  updatedAtMs: 200,
  expiresAtMs: 300,
  byteSize: 42,
  creationDigest: HASH,
} as const;

const trace = {
  ...summary,
  queryText: null,
  queryDigest: null,
  goalText: null,
  goalDigest: null,
  filters: { shape: { terms: 1 } },
};

const judgment = {
  judgmentId: "judgment-1",
  traceId: "trace-1",
  runId: null,
  idempotencyKey: "label-1",
  label: "missing_expected",
  targetKind: "document",
  targetRef: `redacted:${HASH}`,
  target: { sourceHash: HASH },
  createdAtMs: 201,
  targetBytes: 81,
  canonicalDigest: HASH,
} as const;

describe("retrieval trace management schemas", () => {
  test("validate every stable output receipt", async () => {
    const list = await loadSchema("retrieval-trace-list");
    const show = await loadSchema("retrieval-trace-show");
    const label = await loadSchema("retrieval-trace-judgment");
    const traceExport = await loadSchema("retrieval-trace-export");
    const deletion = await loadSchema("retrieval-trace-delete");
    const purge = await loadSchema("retrieval-trace-purge");

    expect(
      assertValid(
        { schemaVersion: "1.0", traces: [summary], nextCursor: null },
        list
      )
    ).toBeTrue();
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          trace,
          runs: [],
          events: [],
          judgments: [judgment],
          exports: [],
          totals: { runs: 0, events: 0, judgments: 1, exports: 0 },
          truncated: {
            runs: false,
            events: false,
            judgments: false,
            exports: false,
          },
        },
        show
      )
    ).toBeTrue();
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          result: "inserted",
          judgment,
        },
        label
      )
    ).toBeTrue();
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          result: "inserted",
          manifest: {
            exportId: "trace-export-1",
            traceIds: ["trace-1"],
            format: "agentic-receipt",
            artifactHash: HASH,
            createdAtMs: 202,
          },
          artifact: {
            schemaVersion: "1.0",
            format: "agentic-receipt",
            traces: [
              {
                trace,
                runs: [],
                events: [],
                judgments: [judgment],
              },
            ],
          },
        },
        traceExport
      )
    ).toBeTrue();
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          traceId: "trace-1",
          deleted: true,
          counts: {
            traces: 1,
            runs: 0,
            events: 0,
            judgments: 1,
            exports: 1,
            exportLinks: 1,
          },
        },
        deletion
      )
    ).toBeTrue();
    expect(
      assertValid(
        {
          schemaVersion: "1.0",
          traces: 1,
          runs: 0,
          events: 0,
          judgments: 1,
          exports: 1,
          exportLinks: 1,
          physicalCleanup: "completed",
          checkpointedFrames: 2,
          remainingWalFrames: 0,
        },
        purge
      )
    ).toBeTrue();
  });

  test("rejects extra fields and implicit negative labels", async () => {
    const list = await loadSchema("retrieval-trace-list");
    const label = await loadSchema("retrieval-trace-judgment");
    expect(
      assertInvalid(
        {
          schemaVersion: "1.0",
          traces: [{ ...summary, queryText: "must not appear in list" }],
          nextCursor: null,
        },
        list
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          schemaVersion: "1.0",
          result: "inserted",
          judgment: { ...judgment, label: "not_clicked" },
        },
        label
      )
    ).toBeTrue();
  });
});
