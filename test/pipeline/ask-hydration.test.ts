import { expect, setSystemTime, spyOn, test } from "bun:test";

import type { AcceptanceManifest } from "../../evals/acceptance/manifest";
import type { AcceptanceRecord } from "../../evals/acceptance/records";

import { compareAcceptance } from "../../evals/acceptance/compare";
import { acceptanceManifestFingerprint } from "../../evals/acceptance/manifest";
import { deterministicRecordFingerprint } from "../../evals/acceptance/records";
import { hydrationLongDocument } from "../../evals/fixtures/acceptance/hydration-long-doc/fixture";
import pin from "../../evals/fixtures/acceptance/hydration-long-doc/manifest.json";
import {
  buildContextCapsule,
  verifyContextCapsuleRuntime,
} from "../../src/app/context-runtime";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { generateGroundedAnswer } from "../../src/pipeline/answer";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { RequestHydration } from "../../src/pipeline/hydration";
import { createGnoClient } from "../../src/sdk/client";
import {
  askCases,
  askGeneration,
  askManifest,
  askStore,
  captureAsk,
  fixture,
  fixtureHash,
  mirrorHash,
  options,
} from "../helpers/ask-hydration";

const baselinePath = new URL(
  "../../.flow/artifacts/fn-149-request-local-retrieval-hydration-reuse/ask-before.json",
  import.meta.url
);

test("SDK Ask owns exactly one hydration through generation and releases on success and failure", async () => {
  const { store, config, dbPath, close } = await askStore();
  const client = await createGnoClient({
    config: { ...config, ftsTokenizer: "unicode61" },
    dbPath,
    indexName: "default",
    downloadPolicy: { offline: true, allowDownload: false },
  });
  const owners = new Set<RequestHydration>();
  // oxlint-disable-next-line typescript-eslint(unbound-method) -- Explicitly rebound to the spy receiver below.
  const chunks = RequestHydration.prototype.getChunksBatch;
  // oxlint-disable-next-line typescript-eslint(unbound-method) -- Explicitly rebound to the spy receiver below.
  const contents = RequestHydration.prototype.getContent;
  const chunkSpy = spyOn(
    RequestHydration.prototype,
    "getChunksBatch"
  ).mockImplementation(function (this: RequestHydration, hashes) {
    owners.add(this);
    return chunks.call(this, hashes);
  });
  const contentSpy = spyOn(
    RequestHydration.prototype,
    "getContent"
  ).mockImplementation(function (this: RequestHydration, hash) {
    owners.add(this);
    return contents.call(this, hash);
  });
  const unavailable = async () => ({
    ok: false as const,
    error: {
      code: "MODEL_NOT_CACHED" as const,
      message: "model-free test",
      retryable: false,
    },
  });
  let failure = false;
  const modelFactory = {
    createEmbeddingPort: unavailable,
    createRerankPort: unavailable,
    createGenerationPort: async () => {
      const port = askGeneration([]);
      const generate = port.generate.bind(port);
      port.generate = async (...args) => {
        expect(owners.size).toBe(1);
        const owner = [...owners][0]!;
        expect((await owner.getContent(mirrorHash)).ok).toBe(true);
        if (failure) throw new Error("active generation failed");
        return generate(...args);
      };
      return { ok: true as const, value: port };
    },
    dispose: async () => {},
  };
  (client as unknown as { llm: typeof modelFactory }).llm = modelFactory;
  try {
    for (const verify of [false, true]) {
      for (const shouldFail of [false, true]) {
        owners.clear();
        failure = shouldFail;
        const pending = client.ask("needle evidence", {
          ...options,
          answer: true,
          verify,
          noRerank: true,
        });
        if (failure) {
          const cause = await pending.catch((error: unknown) => error);
          expect(cause).toMatchObject({ message: "active generation failed" });
        } else expect((await pending).citations?.length).toBeGreaterThan(0);
        expect(owners.size).toBe(1);
        for (const owner of owners)
          expect((await owner.getContent(mirrorHash)).ok).toBe(false);
      }
    }
    // A later Ask sees an indexed title edit through the same long-lived SDK.
    owners.clear();
    failure = false;
    store
      .getRawDb()
      .run(
        "UPDATE documents SET title = 'SDK fresh title' WHERE rel_path = 'b.md'"
      );
    const fresh = await client.ask("needle evidence", {
      ...options,
      noRerank: true,
    });
    expect(fresh.results.map((result) => result.title)).toContain(
      "SDK fresh title"
    );
    for (const owner of owners)
      expect((await owner.getContent(mirrorHash)).ok).toBe(false);
  } finally {
    chunkSpy.mockRestore();
    contentSpy.mockRestore();
    await client.close();
    await close();
  }
});

/**
 * The answer prompt states today's date (fn-218) and how to treat superseded
 * facts (fn-219), so the three generating
 * cases legitimately differ from the frozen capture. Each delta pins both
 * complete records at a fixed clock; any other difference still fails.
 */
const ASK_DATE_PROMPT_CANDIDATES: Record<string, string> = {
  raw: "dc15a32dda1ce88197d3844bd7620395a67b3677384acc770b6a713af2972576",
  verified: "a40da54b587e77b583f81f96d3dc861b2b29c244c3fea207590ba50a53b37cf0",
  unsupported:
    "922b0ec66104d2a26b6316564ce6a00611949f8a0efd52515b423d944ecca2f7",
};

test("Ask retains frozen before-source output, citation provenance and actual model arguments", async () => {
  // A local calendar date: the prompt states the date in local time.
  setSystemTime(new Date(2026, 9, 11, 12));
  const before = (await Bun.file(baselinePath).json()) as {
    manifest: AcceptanceManifest;
    runs: {
      record: AcceptanceRecord;
      counts: { reads: number; rows: number; bytes: number };
    }[];
  };
  expect(sha256Text(JSON.stringify(hydrationLongDocument()))).toBe(pin.sha256);
  expect(before.manifest.fixtures[1]?.sha256).toBe(fixtureHash);
  const after = [];
  // ask-before.json was captured at index schema 29. Hold only that identity
  // field constant so this test remains an exact hydration/ranking/input gate.
  for (const caseId of askCases) after.push(await captureAsk(caseId, true, 29));
  setSystemTime();
  const records = after.map((run) => run.record);
  const intendedDeltas = Object.entries(ASK_DATE_PROMPT_CANDIDATES).map(
    ([caseId, candidateRecordSha256]) => ({
      caseId,
      reason: "answer prompt states today's date and superseded facts",
      oracleSha256: candidateRecordSha256,
      baselineRecordSha256: deterministicRecordFingerprint(
        before.runs.find((run) => run.record.caseId === caseId)!.record
          .deterministic
      ),
      candidateRecordSha256,
    })
  );
  const baselineManifest = { ...before.manifest, intendedDeltas };
  const candidateManifest = { ...askManifest("candidate"), intendedDeltas };
  const stamp = (manifest: AcceptanceManifest, items: AcceptanceRecord[]) =>
    items.map((item) => ({
      ...item,
      manifestSha256: acceptanceManifestFingerprint(manifest),
    }));
  const compare = (candidateRecords: AcceptanceRecord[]) =>
    compareAcceptance(
      baselineManifest,
      candidateManifest,
      stamp(
        baselineManifest,
        before.runs.map((run) => run.record)
      ),
      stamp(candidateManifest, candidateRecords)
    );
  expect(compare(records)).toMatchObject({ passed: true, comparedCases: 6 });
  // Complete inputs and evidence are compared above; no candidate count reduction.
  expect(after[0]?.counts).toEqual({ reads: 2, rows: 1001, bytes: 4_638_789 });
  expect(before.runs[0]?.counts).toEqual({
    reads: 3,
    rows: 1002,
    bytes: 6_958_683,
  });
  expect(after[1]?.counts).toEqual({ reads: 4, rows: 2002, bytes: 9_277_578 });
  expect(before.runs[1]?.counts).toEqual({
    reads: 5,
    rows: 3002,
    bytes: 11_596_473,
  });
  const shortened = structuredClone(records);
  shortened[0]!.deterministic.modelInputs[0]!.input = "truncated";
  expect(compare(shortened).passed).toBe(false);
  const falseEvidence = structuredClone(records);
  falseEvidence[1]!.deterministic.scope.completeOutput = { citations: [] };
  expect(compare(falseEvidence).passed).toBe(false);
});

test("freshness verification bypasses cached content, chunks and document snapshots", async () => {
  const { store, config, close } = await askStore();
  const hydration = new RequestHydration(store);
  const deps = { store, config, hydration, indexName: "default" };
  try {
    const capsule = await buildContextCapsule(
      {
        goal: "needle evidence",
        budgetTokens: 12_000,
        graph: false,
        noRerank: true,
      },
      deps
    );
    const cached = await hydration.getContent(mirrorHash);
    expect(cached.ok && cached.value).toBe(fixture.content);
    expect(
      (await verifyContextCapsuleRuntime(capsule, deps)).evidence.every(
        (item) => item.contentStatus === "unchanged"
      )
    ).toBe(true);
    store
      .getRawDb()
      .run("UPDATE content SET markdown = ? WHERE mirror_hash = ?", [
        "changed after retrieval",
        mirrorHash,
      ]);
    const stale = await verifyContextCapsuleRuntime(capsule, deps);
    expect(
      stale.evidence.every((item) => item.contentStatus !== "unchanged")
    ).toBe(true);
    expect(await hydration.getContent(mirrorHash)).toEqual(cached);
  } finally {
    hydration.release();
    await close();
  }
});

test("answer generation keeps its snapshot during abort, releases owner, and a new request sees repairs and titles", async () => {
  const { store, config, close } = await askStore();
  const controller = new AbortController();
  const hydration = new RequestHydration(store, controller.signal);
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const inputs: Parameters<typeof askGeneration>[0] = [];
  const port = askGeneration(inputs);
  const generate = port.generate.bind(port);
  port.generate = async (...args) => {
    enter();
    await resumed;
    return generate(...args);
  };
  try {
    const result = await searchHybrid(
      {
        store,
        config,
        hydration,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "needle evidence",
      options
    );
    if (!result.ok) throw new Error(result.error.message);
    const pending = generateGroundedAnswer(
      { store, hydration, genPort: port },
      "needle evidence",
      result.value.results,
      512
    );
    await entered;
    controller.abort();
    store
      .getRawDb()
      .run("UPDATE content SET markdown = ? WHERE mirror_hash = ?", [
        "corrupt",
        mirrorHash,
      ]);
    expect((await hydration.getContent(mirrorHash)).ok).toBe(false);
    resume();
    expect((await pending)?.citations).toHaveLength(2);
    expect(JSON.stringify(inputs)).toContain("needle evidence");
    const next = new RequestHydration(store);
    try {
      expect(await next.getContent(mirrorHash)).toMatchObject({
        ok: true,
        value: "corrupt",
      });
      expect(
        await generateGroundedAnswer(
          { store, hydration: next, genPort: askGeneration([]) },
          "needle evidence",
          result.value.results.map((item) => ({ ...item, snippet: "" })),
          512
        )
      ).toBeNull();
    } finally {
      next.release();
    }
    store
      .getRawDb()
      .run("UPDATE content SET markdown = ? WHERE mirror_hash = ?", [
        fixture.content,
        mirrorHash,
      ]);
    store
      .getRawDb()
      .run("UPDATE documents SET title = 'New title' WHERE rel_path = 'b.md'");
    const repaired = new RequestHydration(store);
    try {
      const fresh = await searchHybrid(
        {
          store,
          config,
          hydration: repaired,
          vectorIndex: null,
          embedPort: null,
          expandPort: null,
          rerankPort: null,
        },
        "needle evidence",
        options
      );
      if (!fresh.ok) throw new Error(fresh.error.message);
      expect(fresh.value.results.map((item) => item.title)).toContain(
        "New title"
      );
      expect(
        (
          await generateGroundedAnswer(
            { store, hydration: repaired, genPort: askGeneration([]) },
            "needle evidence",
            fresh.value.results,
            512
          )
        )?.citations
      ).toHaveLength(2);
    } finally {
      repaired.release();
    }
  } finally {
    resume();
    hydration.release();
    await close();
  }
});
