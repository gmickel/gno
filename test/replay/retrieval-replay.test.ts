import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RetrievalTraceExportBundle } from "../../src/store/types";

import { importTraceQrels } from "../../evals/agentic/trace-import";
import { createDefaultConfig } from "../../src/config";
import { buildRetrievalReplaySearchOptions } from "../../src/core/retrieval-replay";
import { RetrievalTraceManagementService } from "../../src/core/retrieval-trace-management";
import { SqliteAdapter } from "../../src/store";
import { err } from "../../src/store/types";
import { assertValid, loadSchema } from "../spec/schemas/validator";
import {
  createReplayTestHarness,
  replaySha256,
  type ReplayTestHarness,
} from "./retrieval-replay-fixture";

describe("retrieval qrels export and replay", () => {
  let harness: ReplayTestHarness;
  let store: SqliteAdapter;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
    store = harness.store;
  });

  afterEach(async () => {
    await harness.close();
  });

  test("exports exact qrels and imports positive plus missing fn-97 tasks", async () => {
    const { exportId, mirrorHash } = await harness.buildReceipt();
    const exported = await store.getRetrievalTraceExportBundle(exportId);
    expect(exported.ok && exported.value?.manifest.format).toBe("qrels");
    const service = new RetrievalTraceManagementService(store);
    const duplicate = await service.export({
      traceIds: ["replay-trace"],
      format: "qrels",
    });
    expect(duplicate.ok && duplicate.value.result).toBe("duplicate");
    if (!duplicate.ok) return;
    const artifact = duplicate.value.artifact;
    expect(
      assertValid(artifact, await loadSchema("retrieval-trace-qrels"))
    ).toBe(true);
    expect(artifact.cases[0]?.baseline.ranked[0]).toMatchObject({
      rank: 1,
      plannerRank: 3,
      mirrorHash,
    });
    expect(artifact.cases[0]?.qrels.map(({ label }) => label).sort()).toEqual([
      "missing_expected",
      "relevant",
    ]);
    expect(JSON.stringify(artifact)).not.toContain("Alpha decision approved");
    const imported = await importTraceQrels(artifact, {
      resolve: async ({ mirrorHash: hash }) => {
        const content = await store.getContent(hash);
        return content.ok && content.value ? { content: content.value } : null;
      },
    });
    expect(imported.tasks).toHaveLength(2);
    expect(
      imported.oracles.map(({ expectedMissing }) => expectedMissing)
    ).toEqual([[], ["missingEvidence"]]);
    expect(
      imported.snapshot.files.every((file) => file.sourceHash === mirrorHash)
    ).toBe(true);
  });

  test("replays BM25 without mutating the stored baseline", async () => {
    const { service, exportId } = await harness.buildReceipt();
    const before = await store.getRetrievalTrace("replay-trace");
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "bm25-test", type: "bm25", limit: 5 },
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
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.applied).toBe(false);
    expect(
      assertValid(replayed.value, await loadSchema("retrieval-trace-replay"))
    ).toBe(true);
    expect(
      replayed.value.cases[0]?.qrels.find(
        ({ label }) => label === "missing_expected"
      )?.sourceState
    ).toBe("missing");
    expect(
      replayed.value.cases[0]?.qrels.find(({ label }) => label === "relevant")
    ).toMatchObject({
      sourceState: "unchanged",
      candidateRank: 1,
      plannerRank: 3,
    });
    const after = await store.getRetrievalTrace("replay-trace");
    expect(after).toEqual(before);
  });

  test("reports unavailable candidates with zero candidate metrics", async () => {
    const { service, exportId } = await harness.buildReceipt();
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "vector-unavailable", type: "vector", limit: 5 },
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
    expect(replayed.ok && replayed.value.cases[0]).toMatchObject({
      verdict: "unreplayable",
      reason: "candidate_failed",
      metrics: {
        candidate: {
          precisionAtK: 0,
          recallAtK: 0,
          f1AtK: 0,
          mrr: 0,
          ndcgAtK: 0,
        },
        candidateCoverage: 0,
      },
    });
  });

  test("replays plural collections and URI-prefix scope with persisted language settings", async () => {
    expect(
      (
        await store.syncCollections([
          {
            name: "notes",
            path: harness.root,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
          {
            name: "archive",
            path: harness.root,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
          {
            name: "secret",
            path: harness.root,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    await harness.indexDocument(
      "archive",
      "decision.md",
      "Alpha decision approved"
    );
    await harness.indexDocument(
      "secret",
      "decision.md",
      "Alpha decision approved"
    );
    await harness.indexDocument(
      "notes",
      "outside.md",
      "Alpha decision approved"
    );
    const filters = {
      collections: ["archive", "notes"],
      lang: "de",
      queryLanguageHint: "de-CH",
      uriPrefix: "gno://notes/projects",
      full: false,
      lineNumbers: true,
      explain: true,
      limit: 5,
    };
    const { service, exportId } = await harness.buildReceipt({ filters });
    const stored = await store.getRetrievalTraceExportBundle(exportId);
    if (!stored.ok || !stored.value) throw new Error("export missing");
    const source = stored.value.traces[0];
    if (!source) throw new Error("trace missing");
    const qrels = await service.export({
      traceIds: [source.trace.traceId],
      format: "qrels",
    });
    if (!qrels.ok || qrels.value.artifact.format !== "qrels") {
      throw new Error("qrels missing");
    }
    const options = buildRetrievalReplaySearchOptions(
      qrels.value.artifact.cases[0]!,
      { id: "hybrid-settings", type: "hybrid" }
    );
    expect(options).toMatchObject({
      lang: "de",
      queryLanguageHint: "de-CH",
      full: false,
      lineNumbers: true,
      explain: true,
      limit: 5,
    });
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "bm25-scoped", type: "bm25" },
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
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(
      replayed.value.cases[0]?.qrels.find(({ label }) => label === "relevant")
        ?.candidateRank
    ).toBe(1);
  });

  test("preserves stable qrels reconstruction reasons", async () => {
    const { exportId } = await harness.buildReceipt();
    const stored = await store.getRetrievalTraceExportBundle(exportId);
    if (!stored.ok || !stored.value) throw new Error("export missing");
    const variants = [
      {
        reason: "query_missing",
        mutate(bundle: RetrievalTraceExportBundle) {
          bundle.traces[0]!.trace.queryText = null;
        },
      },
      {
        reason: "filters_incomplete",
        mutate(bundle: RetrievalTraceExportBundle) {
          bundle.traces[0]!.trace.filters = { unknown: true };
        },
      },
      {
        reason: "no_retrieval_run",
        mutate(bundle: RetrievalTraceExportBundle) {
          bundle.traces[0]!.runs = [];
        },
      },
    ] as const;
    for (const variant of variants) {
      const changed = structuredClone(stored.value);
      variant.mutate(changed);
      const replayed = await new RetrievalTraceManagementService(
        harness.storeWithBundle(changed)
      ).replay(
        {
          exportId,
          candidate: { id: "bm25-test", type: "bm25" },
        },
        {
          config: createDefaultConfig(),
          vectorIndex: null,
          embedPort: null,
          expandPort: null,
          rerankPort: null,
        }
      );
      expect(replayed.ok && replayed.value.reason).toBe(variant.reason);
    }
  });

  test("fails closed for missing aggregate traces and manifest hash drift", async () => {
    const { exportId } = await harness.buildReceipt();
    const missingTrace = await new RetrievalTraceManagementService(
      harness.storeWithBundle(
        err(
          "CONSTRAINT_VIOLATION",
          "Export manifest references a missing retrieval trace"
        )
      )
    ).replay(
      {
        exportId,
        candidate: { id: "bm25-test", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      }
    );
    expect(missingTrace.ok && missingTrace.value.reason).toBe("trace_missing");

    const stored = await store.getRetrievalTraceExportBundle(exportId);
    if (!stored.ok || !stored.value) throw new Error("export missing");
    const changed = structuredClone(stored.value);
    changed.manifest.artifactHash = "0".repeat(64);
    const hashMismatch = await new RetrievalTraceManagementService(
      harness.storeWithBundle(changed)
    ).replay(
      {
        exportId,
        candidate: { id: "bm25-test", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      }
    );
    expect(hashMismatch.ok && hashMismatch.value.reason).toBe(
      "manifest_hash_mismatch"
    );
  });

  test("reports stale source state as unreplayable", async () => {
    const replayState = async (
      mutate: () => Promise<void>
    ): Promise<{ state: string; reason: string | null }> => {
      const { service, exportId } = await harness.buildReceipt();
      await mutate();
      const replayed = await service.replay(
        {
          exportId,
          candidate: { id: "bm25-state", type: "bm25", limit: 5 },
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
      if (!replayed.ok) throw new Error(replayed.error.message);
      const relevant = replayed.value.cases[0]?.qrels.find(
        ({ label }) => label === "relevant"
      );
      if (!relevant) throw new Error("relevant qrel missing");
      return { state: relevant.sourceState, reason: replayed.value.reason };
    };

    const stale = await replayState(async () => {
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "projects/decision.md",
            sourceHash: replaySha256("changed-source"),
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 14,
            sourceMtime: "2026-07-23T01:00:00.000Z",
            mirrorHash: replaySha256("changed-mirror"),
            title: "changed",
          })
        ).ok
      ).toBe(true);
    });
    expect(stale).toEqual({ state: "stale", reason: "source_stale" });
  });

  test("reports inactive source state distinctly", async () => {
    const { service, exportId } = await harness.buildReceipt();
    expect(
      (await store.markInactive("notes", ["projects/decision.md"])).ok
    ).toBe(true);
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "bm25-inactive", type: "bm25", limit: 5 },
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
    expect(
      replayed.ok &&
        replayed.value.cases[0]?.qrels.find(({ label }) => label === "relevant")
          ?.sourceState
    ).toBe("inactive");
  });

  test("reports unindexed source state distinctly", async () => {
    const { service, exportId } = await harness.buildReceipt();
    expect(
      (
        await store.upsertDocument({
          collection: "notes",
          relPath: "projects/decision.md",
          sourceHash: replaySha256("Alpha decision approved"),
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: 23,
          sourceMtime: "2026-07-23T01:00:00.000Z",
          title: "unindexed",
        })
      ).ok
    ).toBe(true);
    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "bm25-unindexed", type: "bm25", limit: 5 },
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
    expect(
      replayed.ok &&
        replayed.value.cases[0]?.qrels.find(({ label }) => label === "relevant")
          ?.sourceState
    ).toBe("no_indexed_content");
  });

  test("reports a missing manifest as unreplayable", async () => {
    const replayed = await new RetrievalTraceManagementService(store).replay(
      {
        exportId: "missing-export",
        candidate: { id: "bm25-test", type: "bm25" },
      },
      {
        config: createDefaultConfig(),
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      }
    );
    expect(replayed.ok && replayed.value).toMatchObject({
      verdict: "unreplayable",
      reason: "manifest_missing",
      applied: false,
    });
  });
});
