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

test("characterization: identical restoration stays inactive and omits both reactivation events", async () => {
  const h = await openHarness();
  const clean = await openHarness();
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
      expect(equivalent(expected, h.snapshot())).toBe(false);
      const doc = await h.store.getDocument("identity", "Alpha.md");
      expect(doc.ok && doc.value?.active).toBe(false);
      await h.sync();
      calls.push(await h.embed());
      expect(await h.events()).toEqual(["create", "inactivate"]);
    }
    expect(calls).toEqual(fixture.expectations.restoration.calls);
    expect(await h.events()).not.toEqual(
      fixture.expectations.restoration.events
    );
    await clean.write("Alpha.md");
    await clean.sync();
    await clean.embed();
    expect(equivalent(expected, clean.snapshot())).toBe(true);
    expect(equivalent(clean.snapshot(), h.snapshot())).toBe(false);
  } finally {
    await h.close();
    await clean.close();
  }
});

test("filename rename recomputes changed title input and matches clean rebuild", async () => {
  const h = await openHarness();
  const clean = await openHarness();
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
    expect(await h.events()).toEqual(fixture.expectations.rename.events);
  } finally {
    await h.close();
    await clean.close();
  }
});
