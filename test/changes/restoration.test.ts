import { expect, test } from "bun:test";
// Bun has no filesystem rename/unlink or path APIs.
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  equivalent,
  expectedOwner,
  fixture,
  openHarness,
} from "../../evals/fixtures/acceptance/ingestion-identity/oracle";
import { openVariantIdentityHarness } from "../helpers/variant-identity-harness";

test("failed new-owner sync leaves committed owner vectors and journal intact", async () => {
  const h = await openHarness();
  try {
    await h.write("Alpha.md");
    await h.sync();
    await h.embed();
    const before = h.snapshot();
    h.store
      .getRawDb()
      .run(
        `CREATE TRIGGER reject_beta BEFORE INSERT ON documents WHEN NEW.rel_path='Beta.md' BEGIN SELECT RAISE(ABORT, 'injected owner write failure'); END`
      );
    await h.write("Beta.md");
    const result = await h.sync();
    expect(result.filesErrored).toBe(1);
    expect(await h.events()).toEqual(["create"]);
    expect(equivalent(before, h.snapshot())).toBe(true);
    expect(await h.embed()).toBe(0);
  } finally {
    await h.close();
  }
});

test.each([false, true])(
  "identical restoration activates once per cycle (verified=%s)",
  async (verified) => {
    const h = await openVariantIdentityHarness(verified);
    const clean = await openVariantIdentityHarness(verified);
    try {
      await h.write("Alpha.md");
      await h.sync();
      const calls = [await h.embed()];
      const expected = [expectedOwner("Alpha.md", "Alpha")];
      expect(equivalent(expected, h.snapshot())).toBe(true);
      for (let cycle = 0; cycle < 2; cycle++) {
        await unlink(join(h.path, "Alpha.md"));
        await h.sync();
        calls.push(await h.embed());
        expect(h.snapshot()).toEqual([]);
        await h.write("Alpha.md");
        await h.sync();
        calls.push(await h.embed());
        expect(equivalent(expected, h.snapshot())).toBe(true);
        const doc = await h.store.getDocument("identity", "Alpha.md");
        expect(doc.ok && doc.value?.active).toBe(true);
        await h.sync();
        calls.push(await h.embed());
        expect(await h.events()).toEqual(
          fixture.expectations.restoration.events.slice(0, 3 + cycle * 2)
        );
      }
      expect(calls).toEqual(fixture.expectations.restoration.calls);
      expect(await h.events()).toEqual(fixture.expectations.restoration.events);
      await clean.write("Alpha.md");
      await clean.sync();
      await clean.embed();
      expect(equivalent(expected, clean.snapshot())).toBe(true);
      expect(equivalent(clean.snapshot(), h.snapshot())).toBe(true);
    } finally {
      await h.close();
      await clean.close();
    }
  }
);

test.each([false, true])(
  "filename rename recomputes changed title input and matches clean rebuild (verified=%s)",
  async (verified) => {
    const h = await openVariantIdentityHarness(verified);
    const clean = await openVariantIdentityHarness(verified);
    try {
      await h.write("Alpha.md");
      await h.sync();
      expect(await h.embed()).toBe(1);
      await rename(join(h.path, "Alpha.md"), join(h.path, "Beta.md"));
      await h.sync();
      const actualCalls = await h.embed();
      await clean.write("Beta.md");
      await clean.sync();
      expect(await clean.embed()).toBe(1);
      expect(
        equivalent([expectedOwner("Beta.md", "Beta")], clean.snapshot())
      ).toBe(true);
      expect(equivalent(clean.snapshot(), h.snapshot())).toBe(true);
      expect(actualCalls).toBe(1);
      expect(h.calls.map((call) => call.input)).toEqual([
        fixture.inputs.Alpha,
        fixture.inputs.Beta,
      ]);
      expect(await h.embed()).toBe(0);
      expect(await h.events()).toEqual(fixture.expectations.rename.events);
    } finally {
      await h.close();
      await clean.close();
    }
  }
);

test("legacy title update invalidation is atomic and recomputes actual input", async () => {
  const h = await openVariantIdentityHarness(false);
  try {
    await h.write("Alpha.md");
    await h.sync();
    expect(await h.embed()).toBe(1);
    const result = await h.store.getDocument("identity", "Alpha.md");
    if (!result.ok || !result.value)
      throw new Error("Missing fixture document");
    const row = result.value;
    const input = {
      collection: row.collection,
      relPath: row.relPath,
      sourceHash: row.sourceHash,
      sourceMime: row.sourceMime,
      sourceExt: row.sourceExt,
      sourceSize: row.sourceSize,
      sourceMtime: row.sourceMtime,
      mirrorHash: row.mirrorHash ?? undefined,
      title: "Beta",
    };
    const db = h.store.getRawDb();
    db.exec(
      "CREATE TRIGGER reject_legacy_delete BEFORE DELETE ON content_vectors BEGIN SELECT RAISE(ABORT, 'injected legacy invalidation failure'); END"
    );
    expect(await h.store.upsertDocument(input)).toMatchObject({ ok: false });
    expect(equivalent([expectedOwner("Alpha.md", "Alpha")], h.snapshot())).toBe(
      true
    );
    expect(await h.events()).toEqual(["create"]);
    db.exec("DROP TRIGGER reject_legacy_delete");
    expect(await h.store.upsertDocument(input)).toMatchObject({ ok: true });
    expect(await h.embed()).toBe(1);
    expect(equivalent([expectedOwner("Alpha.md", "Beta")], h.snapshot())).toBe(
      true
    );
    expect(await h.embed()).toBe(0);
  } finally {
    await h.close();
  }
});
