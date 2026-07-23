import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../../../src/config";
import {
  createReplayTestHarness,
  type ReplayTestHarness,
} from "../../replay/retrieval-replay-fixture";
import { assertInvalid, assertValid, loadSchema } from "./validator";

type JsonObject = Record<string, unknown>;
type JsonPath = Array<string | number>;

const HASH = "a".repeat(64);
const EVIDENCE = {
  docid: "#abc123",
  sourceHash: HASH,
  mirrorHash: HASH,
  uri: "gno://notes/projects/decision.md",
  seq: 0,
  startLine: 1,
  endLine: 1,
  score: 0.9,
  rank: 1,
  plannerRank: 1,
  passageHash: HASH,
  sources: ["bm25"],
  graphExpanded: false,
} as const;

const objectPaths = (value: unknown, path: JsonPath = []): JsonPath[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  if (!(value && typeof value === "object")) return [];
  return [
    path,
    ...Object.entries(value).flatMap(([key, child]) =>
      objectPaths(child, [...path, key])
    ),
  ];
};

const injectUnexpectedField = (value: unknown, path: JsonPath): unknown => {
  const cloned = structuredClone(value);
  let target = cloned as unknown;
  for (const part of path) {
    target = (target as Record<string | number, unknown>)[part];
  }
  (target as JsonObject).unexpectedExtension = true;
  return cloned;
};

const assertEveryObjectClosed = async (
  schemaName: string,
  fixture: unknown
): Promise<void> => {
  const schema = await loadSchema(schemaName);
  expect(assertValid(fixture, schema)).toBeTrue();
  for (const path of objectPaths(fixture)) {
    expect(
      assertInvalid(injectUnexpectedField(fixture, path), schema)
    ).toBeTrue();
  }
};

const rowBase = (id: string) => ({
  traceId: "replay-trace",
  idempotencyKey: id,
  createdAtMs: 1001,
  payloadBytes: 1,
  canonicalDigest: HASH,
});

describe("retrieval trace closed schema parity", () => {
  let harness: ReplayTestHarness;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("accepts real receipts and rejects extension fields at every object", async () => {
    const { service, exportId } = await harness.buildReceipt();
    const list = await service.list();
    const show = await service.show("replay-trace");
    const judgment = await service.label({
      traceId: "replay-trace",
      label: "relevant",
      targetRef: "gno://notes/projects/decision.md",
    });
    const agentic = await service.export({
      traceIds: ["replay-trace"],
      format: "agentic-receipt",
    });
    const qrels = await service.export({
      traceIds: ["replay-trace"],
      format: "qrels",
    });
    const replay = await service.replay(
      {
        exportId,
        candidate: { id: "schema-bm25", type: "bm25", limit: 5 },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
        indexName: "default",
      }
    );
    if (
      !(
        list.ok &&
        show.ok &&
        judgment.ok &&
        agentic.ok &&
        qrels.ok &&
        replay.ok
      )
    ) {
      throw new Error("Trace contract fixture setup failed");
    }
    const deletion = await service.delete("replay-trace");
    const purge = await service.purge();
    if (!(deletion.ok && purge.ok)) {
      throw new Error("Trace deletion fixture setup failed");
    }

    const fixtures = [
      ["retrieval-trace-list", list.value],
      ["retrieval-trace-show", show.value],
      ["retrieval-trace-judgment", judgment.value],
      ["retrieval-trace-export", agentic.value],
      ["retrieval-trace-export", qrels.value],
      ["retrieval-trace-qrels", qrels.value.artifact],
      ["retrieval-trace-replay", replay.value],
      ["retrieval-trace-delete", deletion.value],
      ["retrieval-trace-purge", purge.value],
    ] as const;

    for (const [schemaName, fixture] of fixtures) {
      await assertEveryObjectClosed(schemaName, fixture);
    }
  });

  test("closes and discriminates every run, event, and judgment kind", async () => {
    const { service } = await harness.buildReceipt();
    const shown = await service.show("replay-trace");
    if (!shown.ok) throw new Error("Trace contract fixture setup failed");

    const retrievalPayload = {
      ranked: [EVIDENCE],
      capabilities: ["lexical_search"],
      fallbackCodes: [],
    };
    const contextPayload = {
      evidence: [EVIDENCE],
      capsuleId: "capsule-1",
    };
    const evidencePayload = { evidence: [EVIDENCE] };
    const runs = [
      {
        ...rowBase("run-retrieval"),
        runId: "run-retrieval",
        kind: "retrieval",
        payload: retrievalPayload,
      },
      {
        ...rowBase("run-context"),
        runId: "run-context",
        kind: "context",
        payload: contextPayload,
      },
      {
        ...rowBase("run-get"),
        runId: "run-get",
        kind: "get",
        payload: evidencePayload,
      },
    ];
    const eventPayloads = [
      ["query", { filterFingerprint: HASH }],
      ["retrieval", retrievalPayload],
      ["context", contextPayload],
      ["get", evidencePayload],
      ["open", evidencePayload],
      ["cite", evidencePayload],
      ["pin", evidencePayload],
      ["capability", { capability: "lexical_search", status: "used" }],
      ["complete", { outcome: "completed" }],
    ] as const;
    const events = eventPayloads.map(([kind, payload], index) => ({
      ...rowBase(`event-${kind}`),
      eventId: `event-${kind}`,
      runId: index === 0 || kind === "complete" ? null : "run-retrieval",
      kind,
      payload,
    }));
    const targetBase = {
      docid: EVIDENCE.docid,
      sourceHash: EVIDENCE.sourceHash,
      mirrorHash: EVIDENCE.mirrorHash,
      uri: EVIDENCE.uri,
    };
    const judgments = [
      {
        targetKind: "document",
        target: targetBase,
        label: "missing_expected",
      },
      {
        targetKind: "chunk",
        target: { ...targetBase, seq: 0, passageHash: HASH },
        label: "relevant",
      },
      {
        targetKind: "span",
        target: {
          ...targetBase,
          seq: 0,
          startLine: 1,
          endLine: 1,
          passageHash: HASH,
        },
        label: "relevant",
      },
      {
        targetKind: "query",
        target: { sourceHash: HASH },
        label: "relevant",
      },
    ].map((item, index) => ({
      judgmentId: `judgment-${item.targetKind}`,
      traceId: "replay-trace",
      runId: item.targetKind === "document" ? null : "run-retrieval",
      idempotencyKey: `judgment-${index}`,
      label: item.label,
      targetKind: item.targetKind,
      targetRef: EVIDENCE.uri,
      target: item.target,
      createdAtMs: 1010 + index,
      targetBytes: 1,
      canonicalDigest: HASH,
    }));
    const fixture = {
      ...shown.value,
      runs,
      events,
      judgments,
      totals: {
        ...shown.value.totals,
        runs: runs.length,
        events: events.length,
        judgments: judgments.length,
      },
    };
    await assertEveryObjectClosed("retrieval-trace-show", fixture);

    const qrels = await service.export({
      traceIds: ["replay-trace"],
      format: "qrels",
    });
    if (!qrels.ok) throw new Error("Qrels contract fixture setup failed");
    const qrelsCase = qrels.value.artifact.cases[0];
    if (!qrelsCase) throw new Error("Qrels case fixture missing");
    await assertEveryObjectClosed("retrieval-trace-qrels", {
      ...qrels.value.artifact,
      cases: [
        {
          ...qrelsCase,
          judgments: {
            ...qrelsCase.judgments,
            history: judgments.map(
              ({
                judgmentId,
                label,
                targetKind,
                target,
                createdAtMs,
                canonicalDigest,
              }) => ({
                judgmentId,
                label,
                targetKind,
                target,
                createdAtMs,
                canonicalDigest,
              })
            ),
          },
        },
      ],
    });

    const schema = await loadSchema("retrieval-trace-show");
    expect(
      assertInvalid(
        {
          ...fixture,
          runs: [{ ...runs[0], kind: "get" }],
        },
        schema
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...fixture,
          events: [{ ...events[0], kind: "capability" }],
        },
        schema
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...fixture,
          judgments: [
            {
              ...judgments[0],
              target: { ...targetBase, seq: 0 },
            },
          ],
        },
        schema
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...fixture,
          judgments: [
            {
              ...judgments[1],
              target: targetBase,
            },
          ],
        },
        schema
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...fixture,
          judgments: [
            {
              ...judgments[2],
              target: { ...targetBase, seq: 0 },
            },
          ],
        },
        schema
      )
    ).toBeTrue();
  });
});
