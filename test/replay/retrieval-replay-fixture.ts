import { expect } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DocumentRow,
  RetrievalTraceExportBundle,
  RetrievalTraceInput,
  StorePort,
  StoreResult,
} from "../../src/store/types";

import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import { SqliteAdapter } from "../../src/store";
import { ok } from "../../src/store/types";
import { safeRm } from "../helpers/cleanup";

export const replaySha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export interface ReplayTestHarness {
  root: string;
  store: SqliteAdapter;
  close(): Promise<void>;
  indexDocument(
    collection: string,
    relPath: string,
    content: string
  ): Promise<DocumentRow>;
  buildReceipt(input?: {
    filters?: Record<string, unknown>;
    traceId?: string;
    relPath?: string;
  }): Promise<{
    service: RetrievalTraceManagementService;
    exportId: string;
    mirrorHash: string;
  }>;
  buildZeroHitReceipt(): Promise<{
    service: RetrievalTraceManagementService;
    exportId: string;
  }>;
  storeWithBundle(
    value:
      | RetrievalTraceExportBundle
      | StoreResult<RetrievalTraceExportBundle | null>
  ): StorePort;
}

export const createReplayTestHarness = async (): Promise<ReplayTestHarness> => {
  const root = await mkdtemp(join(tmpdir(), "gno-retrieval-replay-"));
  const store = new SqliteAdapter();
  expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
    true
  );
  expect(
    (
      await store.syncCollections([
        {
          name: "notes",
          path: root,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);

  const indexDocument = async (
    collection: string,
    relPath: string,
    content: string
  ) => {
    const sourceHash = replaySha256(content);
    const mirrorHash = replaySha256(content);
    expect(
      (
        await store.upsertDocument({
          collection,
          relPath,
          sourceHash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: content.length,
          sourceMtime: "2026-07-23T00:00:00.000Z",
          mirrorHash,
          title: relPath,
        })
      ).ok
    ).toBe(true);
    expect((await store.upsertContent(mirrorHash, content)).ok).toBe(true);
    expect(
      (
        await store.upsertChunks(mirrorHash, [
          {
            seq: 0,
            pos: 0,
            text: content,
            startLine: 1,
            endLine: 1,
          },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
    const document = await store.getDocumentByUri(
      `gno://${collection}/${relPath}`
    );
    if (!document.ok || !document.value) throw new Error("document missing");
    return document.value;
  };

  const buildReceipt = async (input?: {
    filters?: Record<string, unknown>;
    traceId?: string;
    relPath?: string;
  }) => {
    const content = "Alpha decision approved";
    const traceId = input?.traceId ?? "replay-trace";
    const document = await indexDocument(
      "notes",
      input?.relPath ?? "projects/decision.md",
      content
    );
    const { mirrorHash, sourceHash } = document;
    if (!mirrorHash) throw new Error("mirror missing");
    const query = "Alpha decision";
    const trace: RetrievalTraceInput = {
      traceId,
      schemaVersion: "1.0",
      redactionMode: "replay",
      replayCapable: true,
      queryText: query,
      queryDigest: replaySha256(query),
      queryShape: { characters: query.length, terms: 2 },
      goalText: null,
      goalDigest: null,
      goalShape: { characters: 0, terms: 0 },
      filters: input?.filters ?? { collection: "notes", limit: 5 },
      fingerprints: {
        pipeline: replaySha256("pipeline"),
        model: replaySha256("model"),
        config: replaySha256("config"),
        index: replaySha256("index"),
      },
      status: "open",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: 100_000,
    };
    expect((await store.createRetrievalTrace(trace)).ok).toBe(true);
    expect(
      (
        await store.appendRetrievalTraceRun({
          runId: `${traceId}-retrieval-run`,
          traceId: trace.traceId,
          idempotencyKey: `${traceId}-retrieval-run`,
          kind: "retrieval",
          payload: {
            ranked: [
              {
                docid: document.docid,
                sourceHash,
                mirrorHash,
                uri: document.uri,
                seq: 0,
                startLine: 1,
                endLine: 1,
                passageHash: replaySha256(content),
                rank: 1,
                plannerRank: 3,
                score: 0.9,
                sources: ["bm25"],
                graphExpanded: false,
              },
            ],
            capabilities: ["lexical_search"],
            fallbackCodes: [],
          },
          createdAtMs: 1001,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await store.appendRetrievalTraceEvent({
          eventId: `${traceId}-capability`,
          traceId: trace.traceId,
          runId: `${traceId}-retrieval-run`,
          idempotencyKey: `${traceId}-capability`,
          kind: "capability",
          payload: { capability: "lexical_search", status: "used" },
          createdAtMs: 1002,
        })
      ).ok
    ).toBe(true);
    expect(
      (await store.finalizeRetrievalTrace(trace.traceId, "completed", 1003)).ok
    ).toBe(true);
    const service = new RetrievalTraceManagementService(store, {
      clock: () => 2000,
    });
    expect(
      (
        await service.label({
          traceId: trace.traceId,
          label: "relevant",
          targetRef: document.uri,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await service.label({
          traceId: trace.traceId,
          label: "missing_expected",
          targetRef: `gno://notes/${traceId}-missing.md`,
        })
      ).ok
    ).toBe(true);
    const exported = await service.export({
      traceIds: [trace.traceId],
      format: "qrels",
    });
    if (!exported.ok) throw new Error(exported.error.message);
    return {
      service,
      exportId: exported.value.manifest.exportId,
      mirrorHash,
    };
  };

  const storeWithBundle = (
    value:
      | RetrievalTraceExportBundle
      | StoreResult<RetrievalTraceExportBundle | null>
  ): StorePort =>
    new Proxy(store as StorePort, {
      get(target, property, receiver) {
        if (property === "getRetrievalTraceExportBundle") {
          return async () =>
            "ok" in value && value.ok === false ? value : ok(value);
        }
        const member = Reflect.get(target, property, receiver);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });

  const buildZeroHitReceipt = async () => {
    const content = "Previously missing target";
    const document = await indexDocument("notes", "missing.md", content);
    const traceId = "zero-hit-trace";
    const trace: RetrievalTraceInput = {
      traceId,
      schemaVersion: "1.0",
      redactionMode: "replay",
      replayCapable: true,
      queryText: content,
      queryDigest: replaySha256(content),
      queryShape: { characters: content.length, terms: 3 },
      goalText: null,
      goalDigest: null,
      goalShape: { characters: 0, terms: 0 },
      filters: { collection: "notes", limit: 5 },
      fingerprints: {
        pipeline: replaySha256("zero-pipeline"),
        model: replaySha256("zero-model"),
        config: replaySha256("zero-config"),
        index: replaySha256("zero-index"),
      },
      status: "open",
      createdAtMs: 3000,
      updatedAtMs: 3000,
      expiresAtMs: 100_000,
    };
    expect((await store.createRetrievalTrace(trace)).ok).toBe(true);
    expect(
      (
        await store.appendRetrievalTraceRun({
          runId: "zero-retrieval-run",
          traceId,
          idempotencyKey: "zero-retrieval-run",
          kind: "retrieval",
          payload: {
            ranked: [],
            capabilities: ["lexical_search"],
            fallbackCodes: [],
          },
          createdAtMs: 3001,
        })
      ).ok
    ).toBe(true);
    expect(
      (await store.finalizeRetrievalTrace(traceId, "completed", 3002)).ok
    ).toBe(true);
    const service = new RetrievalTraceManagementService(store, {
      clock: () => 4000,
    });
    expect(
      (
        await service.label({
          traceId,
          label: "missing_expected",
          targetRef: document.uri,
        })
      ).ok
    ).toBe(true);
    const exported = await service.export({
      traceIds: [traceId],
      format: "qrels",
    });
    if (!exported.ok) throw new Error(exported.error.message);
    return { service, exportId: exported.value.manifest.exportId };
  };

  return {
    root,
    store,
    indexDocument,
    buildReceipt,
    buildZeroHitReceipt,
    storeWithBundle,
    async close() {
      await store.close();
      await safeRm(root);
    },
  };
};
