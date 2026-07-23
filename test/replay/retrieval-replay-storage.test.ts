import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:path has no Bun path utility equivalent.
import { join } from "node:path";

import { createDefaultConfig } from "../../src/config";
import {
  createReplayTestHarness,
  type ReplayTestHarness,
} from "./retrieval-replay-fixture";

const replayDeps = () => ({
  config: createDefaultConfig(),
  vectorIndex: null,
  embedPort: null,
  expandPort: null,
  rerankPort: null,
  indexName: "default",
});

describe("retrieval replay SQLite invalidation", () => {
  let harness: ReplayTestHarness;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("detects shortened manifest membership after a real trace cascade", async () => {
    const first = await harness.buildReceipt({
      traceId: "cascade-a",
      relPath: "projects/cascade-a.md",
    });
    await harness.buildReceipt({
      traceId: "cascade-b",
      relPath: "projects/cascade-b.md",
    });
    const aggregate = await first.service.export({
      traceIds: ["cascade-a", "cascade-b"],
      format: "qrels",
    });
    if (!aggregate.ok) throw new Error(aggregate.error.message);
    const exportId = aggregate.value.manifest.exportId;

    const raw = new Database(join(harness.root, "index.sqlite"));
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("DELETE FROM retrieval_traces WHERE trace_id = ?", ["cascade-b"]);
    const remaining = raw
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM retrieval_trace_export_traces WHERE export_id = ?`
      )
      .get(exportId)?.count;
    const manifest = raw
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM retrieval_trace_exports WHERE export_id = ?"
      )
      .get(exportId)?.count;
    raw.close();
    expect(remaining).toBe(1);
    expect(manifest).toBe(1);

    const replayed = await first.service.replay(
      {
        exportId,
        candidate: { id: "cascade-bm25", type: "bm25" },
      },
      replayDeps()
    );
    expect(replayed.ok && replayed.value).toMatchObject({
      verdict: "unreplayable",
      reason: "manifest_hash_mismatch",
      applied: false,
    });
  });

  test("reports source_missing after the indexed document disappears", async () => {
    const { service, exportId } = await harness.buildReceipt();
    const raw = new Database(join(harness.root, "index.sqlite"));
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("DELETE FROM documents WHERE collection = ? AND rel_path = ?", [
      "notes",
      "projects/decision.md",
    ]);
    raw.close();

    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "missing-bm25", type: "bm25" },
      },
      replayDeps()
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({
      verdict: "unreplayable",
      reason: "source_missing",
      cases: [
        {
          verdict: "unreplayable",
          reason: "source_missing",
          qrels: [
            {
              label: "relevant",
              sourceState: "missing",
              candidateRank: null,
            },
            { label: "missing_expected" },
          ],
        },
      ],
    });
  });

  test("resolves a moved source hash before a reused URI", async () => {
    const { service, exportId } = await harness.buildReceipt();
    expect(
      (await harness.store.markInactive("notes", ["projects/decision.md"])).ok
    ).toBe(true);
    await harness.indexDocument(
      "notes",
      "moved/decision.md",
      "Alpha decision approved"
    );
    await harness.indexDocument(
      "notes",
      "projects/decision.md",
      "Alpha decision replacement"
    );

    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "moved-source-bm25", type: "bm25" },
      },
      replayDeps()
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(
      replayed.value.cases[0]?.qrels.find((qrel) => qrel.label === "relevant")
    ).toMatchObject({
      sourceState: "unchanged",
      candidateRank: 1,
    });
  });

  test("reports a reused URI as stale when its source hash disappeared", async () => {
    const { service, exportId } = await harness.buildReceipt();
    await harness.indexDocument(
      "notes",
      "projects/decision.md",
      "Alpha decision replacement"
    );

    const replayed = await service.replay(
      {
        exportId,
        candidate: { id: "reused-uri-bm25", type: "bm25" },
      },
      replayDeps()
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value).toMatchObject({
      verdict: "unreplayable",
      reason: "source_stale",
      cases: [
        {
          qrels: [
            {
              label: "relevant",
              sourceState: "stale",
            },
            { label: "missing_expected" },
          ],
        },
      ],
    });
  });
});
