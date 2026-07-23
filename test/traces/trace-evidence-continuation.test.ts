import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary directory creation has no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os and node:path: Bun has no equivalent temp/path helpers.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextCapsuleV1 } from "../../src/core/context-capsule";

import { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const PASSAGE = "complete first line\ncomplete second line";
const PASSAGE_HASH = new Bun.CryptoHasher("sha256")
  .update(PASSAGE)
  .digest("hex");
const enabledConfig = {
  enabled: true,
  redactionMode: "replay",
  retention: {
    maxAgeDays: 30,
    maxTraces: 100,
    maxRecordsPerTrace: 100,
    maxBytes: 1024 * 1024,
  },
} as const;

describe("retrieval trace evidence continuation", () => {
  let testDir = "";
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-trace-evidence-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBeTrue();
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("links deterministic Capsule identity without mutating canonical bytes", async () => {
    let id = 0;
    const capsule = {
      capsuleId: HASH_D,
      evidence: [
        {
          docid: "#abcdef",
          sourceHash: HASH_A,
          mirrorHash: HASH_B,
          uri: "gno://notes/exact.md",
          startLine: 10,
          endLine: 11,
          passageHash: PASSAGE_HASH,
          retrievalRank: 7,
        },
      ],
    } as unknown as ContextCapsuleV1;
    const canonicalBytes = JSON.stringify(capsule);

    for (const expectedTraceId of ["context-trace-1", "context-trace-2"]) {
      const started = await RetrievalTraceSession.start({
        store: adapter,
        config: enabledConfig,
        query: "exact",
        goal: "build evidence",
        idFactory: () => `context-trace-${++id}`,
        clock: () => 2_000 + id,
        fingerprints: () => ({
          pipeline: HASH_A,
          model: HASH_B,
          config: HASH_C,
          index: HASH_D,
        }),
      });
      if (!started.ok || !started.value) throw new Error("trace did not start");
      expect(started.value.traceId).toBe(expectedTraceId);
      const context = await started.value.recordContext(capsule);
      if (!context.ok) throw new Error(JSON.stringify(context.error));
      expect((await started.value.finish("completed")).ok).toBeTrue();
    }

    expect(JSON.stringify(capsule)).toBe(canonicalBytes);
    expect(canonicalBytes).not.toContain("context-trace");
    const first = await adapter.getRetrievalTrace("context-trace-1");
    expect(first.ok && first.value?.events[1]?.payload).toMatchObject({
      capsuleId: HASH_D,
      evidence: [{ passageHash: PASSAGE_HASH }],
    });
  });

  test("separate continuation sessions append collision-free get/open events", async () => {
    const started = await RetrievalTraceSession.start({
      store: adapter,
      config: enabledConfig,
      query: "continue",
      idFactory: () => "continued-trace",
      clock: () => 3_000,
      fingerprints: () => ({
        pipeline: HASH_A,
        model: HASH_B,
        config: HASH_C,
        index: HASH_D,
      }),
    });
    if (!started.ok || !started.value) throw new Error("trace did not start");
    const evidence = {
      docid: "#abcdef",
      sourceHash: HASH_A,
      mirrorHash: HASH_B,
      uri: "gno://notes/exact.md",
      startLine: 10,
      endLine: 11,
      passageHash: PASSAGE_HASH,
    };
    for (const kind of ["get", "open"] as const) {
      const resumed = await RetrievalTraceSession.resume({
        store: adapter,
        config: enabledConfig,
        traceId: "continued-trace",
        clock: () => 3_100,
      });
      if (!resumed.ok || !resumed.value)
        throw new Error("trace did not resume");
      expect(
        (await resumed.value.recordEvidence(kind, [evidence])).ok
      ).toBeTrue();
    }
    const stored = await adapter.getRetrievalTrace("continued-trace");
    expect(
      stored.ok && stored.value?.events.map((event) => event.kind)
    ).toEqual(["query", "get", "open"]);
  });
});
