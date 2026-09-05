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

test("scoped mutation parity, with explicit legacy restore rejection", async () => {
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
      if (step === "restore" && !comparison.passed) {
        expect(comparison.failures.map(({ field }) => field)).toEqual([
          "deterministic.scope.edges.length",
          "deterministic.scope.diagnostics[0].unresolved.total",
          "deterministic.scope.diagnostics[0].unresolved.byType.wiki",
          "deterministic.scope.diagnostics[2].unresolved.total",
          "deterministic.scope.diagnostics[2].unresolved.byType.wiki",
        ]);
      } else expect(comparison.failures).toEqual([]);
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
