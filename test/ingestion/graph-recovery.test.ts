import { expect, test } from "bun:test";
// Bun has no directory creation or removal API.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
// Bun has no path or OS temporary-directory utility.
import { join } from "node:path";

import {
  initialSources,
  rules,
} from "../../evals/fixtures/acceptance/graph-reconciliation/fixture";
import {
  compareGraph,
  fullRebuild,
  snapshot,
} from "../../evals/fixtures/acceptance/graph-reconciliation/oracle";
import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "graph-recovery-"));
  const path = join(root, "index.sqlite");
  const collections = ["targets", "outside"].map((name) => ({
    name,
    path: join(root, name),
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  for (const collection of collections) await mkdir(collection.path);
  const store = new SqliteAdapter();
  const opened = await store.open(path, "porter");
  if (!opened.ok) throw new Error(opened.error.message);
  await store.syncCollections(collections);
  const sources = initialSources();
  for (const [relativePath, body] of Object.entries(sources))
    await Bun.write(join(root, relativePath), body);
  await new SyncService().syncAll(collections, store, {
    contentTypeRules: rules(),
  });
  return { root, path, store, collections, sources };
}

for (const failure of [
  "before-begin",
  "process-exit",
  "before-complete",
] as const) {
  test(`projection recovery after ${failure} preserves source journal and oracle parity`, async () => {
    const f = await fixture();
    let store = f.store;
    try {
      const before = store
        .getRawDb()
        .query("SELECT * FROM doc_edges ORDER BY id")
        .all();
      f.sources["targets/future.md"] = "# Future\n";
      await Bun.write(join(f.root, "targets/future.md"), "# Future\n");
      if (failure === "process-exit") {
        await store.close();
        // Exit after an actual edge write with the outer transaction open.
        // SQLite must recover it; there is no graceful close/rollback here.
        const script = `
          import { SqliteAdapter } from ${JSON.stringify(new URL("../../src/store/sqlite/adapter.ts", import.meta.url).href)};
          import { SyncService } from ${JSON.stringify(new URL("../../src/ingestion/index.ts", import.meta.url).href)};
          const store = new SqliteAdapter();
          await store.open(${JSON.stringify(f.path)}, "porter");
          const set = store.setDocEdges.bind(store);
          store.setDocEdges = async (...args) => {
            const result = await set(...args);
            if (result.ok) process.exit(73);
            return result;
          };
          await new SyncService().syncCollection(${JSON.stringify(f.collections[0])}, store,
            {contentTypeRules:${JSON.stringify(rules())}});
          process.exit(74);
        `;
        const child = Bun.spawn([process.execPath, "--eval", script], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = new Response(child.stderr).text();
        expect({ code: await child.exited, stderr: await stderr }).toEqual({
          code: 73,
          stderr: "",
        });
      } else {
        const graph = store.graphReferenceStore.bind(store);
        store.graphReferenceStore = () => ({
          ...graph(),
          [failure === "before-begin" ? "begin" : "complete"]: () => {
            throw new Error("injected projection interruption");
          },
        });
        const result = await new SyncService().syncCollection(
          f.collections[0]!,
          store,
          { contentTypeRules: rules() }
        );
        expect(result.errors[0]?.message).toContain("injected");
        await store.close();
      }
      store = new SqliteAdapter();
      expect((await store.open(f.path, "porter")).ok).toBe(true);
      const db = store.getRawDb();
      expect(db.query("SELECT * FROM doc_edges ORDER BY id").all()).toEqual(
        before
      );
      expect(
        db
          .query<{ dirty: number }, []>(
            "SELECT dirty FROM graph_projection_state"
          )
          .get()?.dirty
      ).toBe(1);
      const journal = db
        .query<{ new_uri: string; change_kind: string }, []>(
          "SELECT * FROM document_changes ORDER BY sequence"
        )
        .all();
      expect(
        journal.filter(
          (row) =>
            row.new_uri === "gno://targets/future.md" &&
            row.change_kind === "create"
        )
      ).toHaveLength(1);
      const retried = await new SyncService().syncCollection(
        f.collections[0]!,
        store,
        { contentTypeRules: rules() }
      );
      expect(retried.errors).toEqual([]);
      expect(
        db.query("SELECT dirty, in_progress FROM graph_projection_state").get()
      ).toEqual({ dirty: 0, in_progress: 0 });
      const order = db
        .query<{ path: string }, []>(
          "SELECT collection || '/' || rel_path AS path FROM documents ORDER BY id"
        )
        .all()
        .map((row) => row.path);
      expect(
        compareGraph(
          failure,
          await fullRebuild(f.sources, "mentions", order),
          await snapshot(store)
        ).failures
      ).toEqual([]);
      const edges = db.query("SELECT * FROM doc_edges ORDER BY id").all();
      expect(
        await new SyncService().reconcileTypedEdges(store, {
          contentTypeRules: rules(),
        })
      ).toEqual([]);
      expect(db.query("SELECT * FROM doc_edges ORDER BY id").all()).toEqual(
        edges
      );
      expect(
        db.query("SELECT * FROM document_changes ORDER BY sequence").all()
      ).toEqual(journal);
    } finally {
      await store.close();
      await safeRm(f.root);
    }
  });
}

test("configured and parsed edge identities survive a forced full repair", async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.root, "targets/future.md"), "# Future\n");
    await Bun.write(join(f.root, "targets/renamed.md"), "# Renamed\n");
    const service = new SyncService();
    expect(
      (
        await service.syncCollection(f.collections[0]!, f.store, {
          contentTypeRules: rules("attended"),
        })
      ).errors
    ).toEqual([]);
    const db = f.store.getRawDb();
    db.run("UPDATE doc_edges SET created_at = '2001-01-01 00:00:00'");
    const rows = db.query("SELECT * FROM doc_edges ORDER BY id").all();
    expect(rows).toHaveLength(3);
    db.exec(`CREATE TEMP TABLE repair_mutations (operation TEXT);
      CREATE TEMP TRIGGER repair_insert AFTER INSERT ON doc_edges BEGIN INSERT INTO repair_mutations VALUES ('insert'); END;
      CREATE TEMP TRIGGER repair_delete AFTER DELETE ON doc_edges BEGIN INSERT INTO repair_mutations VALUES ('delete'); END;
      CREATE TEMP TRIGGER repair_update AFTER UPDATE ON doc_edges BEGIN INSERT INTO repair_mutations VALUES ('update'); END;`);
    expect(
      await service.reconcileTypedEdges(f.store, {
        contentTypeRules: rules("attended"),
      })
    ).toEqual([]);
    expect(db.query("SELECT * FROM repair_mutations").all()).toEqual([]);
    expect(db.query("SELECT * FROM doc_edges ORDER BY id").all()).toEqual(rows);
  } finally {
    await f.store.close();
    await safeRm(f.root);
  }
});
