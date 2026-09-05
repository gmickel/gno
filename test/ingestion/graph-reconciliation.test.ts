import { expect, test } from "bun:test";

import {
  initialSources,
  mutate,
  mutations,
  rules,
} from "../../evals/fixtures/acceptance/graph-reconciliation/fixture";
import {
  compareGraph,
  fixtureHash,
  fullRebuild,
  openFixture,
  snapshot,
} from "../../evals/fixtures/acceptance/graph-reconciliation/oracle";
import { SyncService } from "../../src/ingestion";

test("scoped mutation parity including identical-source restoration", async () => {
  const fixture = await openFixture();
  const sources = initialSources();
  const service = new SyncService();
  try {
    let hint = "mentions";
    for (const step of mutations) {
      mutate(sources, step);
      if (step === "config") hint = "attended";
      await fixture.write(sources);
      if (step === "initial" || step === "source-disappears") {
        await service.syncAll(fixture.collections, fixture.store, {
          contentTypeRules: rules(hint),
        });
      } else {
        await service.syncCollection(fixture.collections[0]!, fixture.store, {
          contentTypeRules: rules(hint),
        });
      }
      const sourceOrder = fixture.store
        .getRawDb()
        .query<{ path: string }, []>(
          "SELECT collection || '/' || rel_path AS path FROM documents ORDER BY id"
        )
        .all()
        .map(({ path }) => path);
      const expected = await fullRebuild(sources, hint, sourceOrder);
      const comparison = compareGraph(
        step,
        expected,
        await snapshot(fixture.store)
      );
      expect(comparison.failures).toEqual([]);
    }
  } finally {
    await fixture.close();
  }
}, 30_000);

test("oracle rejects selected-collection-only and old-identity-only invalidation", async () => {
  const sources = initialSources();
  const unresolved = await fullRebuild(sources, "mentions");
  mutate(sources, "add");
  const added = await fullRebuild(sources, "mentions");
  // A targets-only projection leaves the previously unresolved outside sources unchanged.
  expect(
    compareGraph("selected-collection-only", added, unresolved).passed
  ).toBe(false);
  mutate(sources, "rename");
  mutate(sources, "title");
  const renamed = await fullRebuild(sources, "mentions");
  // Old-identity invalidation clears Future but misses previously unresolved Renamed.
  const broken = structuredClone(renamed);
  const shape = broken as unknown as { edges: { dst: string }[] };
  shape.edges = shape.edges.filter(
    (edge) => edge.dst !== "gno://targets/moved.md"
  );
  expect(compareGraph("old-identity-only", renamed, broken).passed).toBe(false);
});

test("graph scenario has its own immutable fixture identity", async () => {
  const pin = await Bun.file(
    new URL(
      "../../evals/fixtures/acceptance/graph-reconciliation/manifest.json",
      import.meta.url
    )
  ).json();
  expect(fixtureHash).toBe(pin.sha256);
});

test("1001-document no-op skips global reads and outside unresolved references update without rereads", async () => {
  const fixture = await openFixture();
  const { store, collections } = fixture;
  const service = new SyncService();
  try {
    await fixture.write({ "targets/anchor.md": "# Anchor\n" });
    await service.syncCollection(collections[0]!, store);
    for (let index = 0; index < 1000; index++) {
      const hash = `closure-source-${index}`;
      const added = await store.upsertDocument({
        collection: "outside",
        relPath: `source-${index}.md`,
        sourceHash: hash,
        mirrorHash: hash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 60,
        sourceMtime: "2026-09-05T00:00:00Z",
      });
      if (!added.ok) throw new Error(added.error.message);
      await store.upsertContent(
        hash,
        '---\nrelations:\n  knows: ["targets:Future"]\n---\n# Source\n'
      );
    }
    expect(await service.reconcileTypedEdges(store)).toEqual([]);
    const db = store.getRawDb();
    db.exec(`CREATE TEMP TABLE closure_mutations (operation TEXT);
      CREATE TEMP TRIGGER closure_insert AFTER INSERT ON doc_edges BEGIN INSERT INTO closure_mutations VALUES ('insert'); END;
      CREATE TEMP TRIGGER closure_delete AFTER DELETE ON doc_edges BEGIN INSERT INTO closure_mutations VALUES ('delete'); END;`);
    let reads = 0;
    const read = store.getContent.bind(store);
    store.getContent = (hash) => {
      reads++;
      return read(hash);
    };
    const noop = await service.syncCollection(collections[0]!, store);
    expect(noop.errors).toEqual([]);
    expect(reads).toBe(0);
    expect(db.query("SELECT * FROM closure_mutations").all()).toEqual([]);
    await fixture.write({
      "targets/anchor.md": "# Anchor\n",
      "targets/future.md": "# Future\n",
    });
    const added = await service.syncCollection(collections[0]!, store);
    expect(added.errors).toEqual([]);
    expect(reads).toBe(1);
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM doc_edges").get()
        ?.n
    ).toBe(1000);
    const before = await snapshot(store);
    expect(await service.reconcileTypedEdges(store)).toEqual([]);
    expect(
      compareGraph("incoming-unresolved", await snapshot(store), before)
        .failures
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 30_000);

test("configuration, version and incomplete inventory select full recovery", async () => {
  const fixture = await openFixture();
  const { store, collections } = fixture;
  const service = new SyncService();
  try {
    await fixture.write(initialSources());
    await service.syncAll(collections, store);
    let reads = 0;
    const read = store.getContent.bind(store);
    store.getContent = (hash) => {
      reads++;
      return read(hash);
    };
    const changes = [
      "UPDATE collections SET pattern = '**/*' WHERE name = 'outside'",
      "UPDATE graph_projection_state SET version = 999",
      "DELETE FROM graph_reference_documents WHERE document_id = (SELECT min(document_id) FROM graph_reference_documents)",
    ];
    for (const change of changes) {
      reads = 0;
      store.getRawDb().exec(change);
      const result = await service.syncCollection(collections[0]!, store);
      expect(result.errors).toEqual([]);
      expect(reads).toBe(3);
      expect(
        store
          .getRawDb()
          .query("SELECT dirty, in_progress FROM graph_projection_state")
          .get()
      ).toEqual({ dirty: 0, in_progress: 0 });
    }
    // A direct link edit can coexist with a changed target. The old document
    // identities alone cannot identify that source, so this must recover fully.
    const source = await store.getDocument("outside", "peer.md");
    if (!source.ok || !source.value) throw new Error("Missing fixture source");
    expect((await store.setDocLinks(source.value.id, [], "parsed")).ok).toBe(
      true
    );
    await fixture.write({
      ...initialSources(),
      "targets/anchor.md": "# Renamed Anchor\n",
    });
    reads = 0;
    expect(
      (await service.syncCollection(collections[0]!, store)).errors
    ).toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(3);
  } finally {
    await fixture.close();
  }
});
