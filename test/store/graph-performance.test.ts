import { expect, test } from "bun:test";

import { sizes } from "../../evals/fixtures/acceptance/graph-reconciliation/fixture";
import { openFixture } from "../../evals/fixtures/acceptance/graph-reconciliation/oracle";
import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

const DOCUMENT_COUNT = 250;
const LINK_COUNT = 750;
const GRAPH_STALL_REGRESSION_BUDGET_MS = 1500;

for (const size of sizes) {
  test(`unchanged sync and full repair retain edge rows for ${size} docs`, async () => {
    const fixture = await openFixture();
    const { store } = fixture;
    try {
      await fixture.write({ "targets/anchor.md": "# Anchor\n" });
      const service = new SyncService();
      await service.syncCollection(fixture.collections[0]!, store);
      for (let index = 1; index < size; index++) {
        const mirrorHash = `graph-baseline-${index}`;
        const result = await store.upsertDocument({
          collection: "outside",
          relPath: `source-${index}.md`,
          sourceHash: mirrorHash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: 80,
          sourceMtime: "2026-09-05T00:00:00Z",
          mirrorHash,
        });
        if (!result.ok) throw new Error(result.error.message);
        await store.upsertContent(
          mirrorHash,
          '---\nrelations:\n  knows: ["targets:Anchor"]\n---\n# Source\n'
        );
      }
      expect(await service.reconcileTypedEdges(store)).toEqual([]);
      const db = store.getRawDb();
      db.exec(`CREATE TEMP TABLE edge_counts (operation TEXT);
        CREATE TEMP TRIGGER count_edge_insert AFTER INSERT ON doc_edges BEGIN INSERT INTO edge_counts VALUES ('insert'); END;
        CREATE TEMP TRIGGER count_edge_delete AFTER DELETE ON doc_edges BEGIN INSERT INTO edge_counts VALUES ('delete'); END;
        CREATE TEMP TRIGGER count_edge_update AFTER UPDATE ON doc_edges BEGIN INSERT INTO edge_counts VALUES ('update'); END;`);
      let reads = 0;
      const getContent = store.getContent.bind(store);
      store.getContent = (hash) => {
        reads++;
        return getContent(hash);
      };
      await service.syncCollection(fixture.collections[0]!, store);
      const counts = db
        .query<{ operation: string; count: number }, []>(
          "SELECT operation, count(*) AS count FROM edge_counts GROUP BY operation ORDER BY operation"
        )
        .all();
      // Current production budget; frozen fn150.1 baseline artifacts retain the
      // original size reads and 2*(size-1) DELETE/INSERT measurements.
      expect({ reads, counts }).toEqual({
        reads: 0,
        counts: [],
      });
      const originalRows = db
        .query("SELECT * FROM doc_edges ORDER BY id")
        .all();
      expect(await service.reconcileTypedEdges(store)).toEqual([]);
      expect(reads).toBe(size);
      expect(db.query("SELECT * FROM edge_counts").all()).toEqual([]);
      expect(db.query("SELECT * FROM doc_edges ORDER BY id").all()).toEqual(
        originalRows
      );
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM doc_edges"
          )
          .get()?.count
      ).toBe(size - 1);
    } finally {
      await fixture.close();
    }
  }, 30_000);
}

test("getGraph resolves a moderate link inventory without starving timers", async () => {
  const adapter = new SqliteAdapter();
  const opened = await adapter.open(":memory:", "porter");
  expect(opened.ok).toBe(true);
  const collections = await adapter.syncCollections([
    {
      name: "notes",
      path: "/tmp",
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ]);
  expect(collections.ok).toBe(true);

  try {
    const db = adapter.getRawDb();
    const insertDocument = db.prepare(`
      INSERT INTO documents (
        collection, rel_path, source_hash, source_mime, source_ext,
        source_size, source_mtime, docid, uri, title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < DOCUMENT_COUNT; index += 1) {
        const name = `doc-${index}`;
        insertDocument.run(
          "notes",
          `${name}.md`,
          `hash-${index}`,
          "text/markdown",
          ".md",
          100,
          "2026-08-06T00:00:00Z",
          `#${index.toString(16).padStart(8, "0")}`,
          `gno://notes/${name}.md`,
          name
        );
      }
    })();

    const insertLink = db.prepare(`
      INSERT INTO doc_links (
        source_doc_id, link_type, target_ref, target_ref_norm,
        start_line, start_col, end_line, end_col
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < LINK_COUNT; index += 1) {
        const sourceId = (index % DOCUMENT_COUNT) + 1;
        const target = `doc-${(index * 17 + 1) % DOCUMENT_COUNT}`;
        insertLink.run(
          sourceId,
          "wiki",
          target,
          target,
          index + 1,
          1,
          index + 1,
          10
        );
      }
    })();

    let timerDelayMs = 0;
    const timerStartedAt = performance.now();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerDelayMs = performance.now() - timerStartedAt;
        resolve();
      }, 10);
    });
    const graphStartedAt = performance.now();
    const graph = await adapter.getGraph({
      collection: "notes",
      limitNodes: DOCUMENT_COUNT,
      limitEdges: LINK_COUNT,
    });
    const graphDurationMs = performance.now() - graphStartedAt;
    await timer;

    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.links).toHaveLength(DOCUMENT_COUNT);
    expect(graph.value.links.every(({ weight }) => weight === 3)).toBe(true);
    expect(graph.value.report.unresolvedLinks.total).toBe(0);
    expect(graphDurationMs).toBeLessThan(GRAPH_STALL_REGRESSION_BUDGET_MS);
    expect(timerDelayMs).toBeLessThan(GRAPH_STALL_REGRESSION_BUDGET_MS);
  } finally {
    await adapter.close();
  }
});
