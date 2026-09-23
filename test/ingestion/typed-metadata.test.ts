import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
// Bun has no directory creation/removal or OS/path equivalent.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SyncService } from "../../src/ingestion";
import { extractTypedMetadata } from "../../src/ingestion/typed-metadata";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

test("typed YAML preserves scalar types, Unicode, empty/false/zero values", () => {
  expect(
    extractTypedMetadata(
      '---\ngno:\n  metadata:\n    project: Zürich\n    score: 0\n    active: false\n    empty: ""\n    values: [1, 2]\n---\nbody'
    )
  ).toEqual({
    typedMetadata: {
      project: "Zürich",
      score: 0,
      active: false,
      empty: "",
      values: [1, 2],
    },
  });
  expect(extractTypedMetadata("---\nproject: ignored\n---\n")).toEqual({
    typedMetadata: {},
  });
  expect(extractTypedMetadata('---\n"gno.metadata": ignored\n---\n')).toEqual({
    typedMetadata: {},
  });
});

test.each([
  "null",
  "{nested: map}",
  "[1, false]",
  ".inf",
  "{__proto__: value}",
])("invalid opted-in metadata is diagnosed: %s", (value) => {
  const result = extractTypedMetadata(
    `---\ngno:\n  metadata:\n    value: ${value}\n---\n`
  );
  expect(result.typedMetadata).toBeUndefined();
  expect(result.metadataError).toBeString();
});

test("malformed YAML, aliases and oversized maps cannot silently become missing keys", () => {
  for (const yaml of [
    "gno:\n  metadata: [",
    "gno:\n  metadata: &x {project: *x}",
    "gno:\n  metadata:\n" +
      Array.from({ length: 65 }, (_, i) => `    key${i}: 1`).join("\n"),
  ])
    expect(
      extractTypedMetadata(`---\n${yaml}\n---\n`).metadataError
    ).toBeString();
});

test("real sync backfills unchanged metadata, preserves chunks, and repairs invalid source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gno-typed-ingest-"));
  const store = new SqliteAdapter();
  const dbPath = join(dir, "index.sqlite");
  try {
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    const collection = {
      name: "notes",
      path: dir,
      pattern: "*.md",
      include: [],
      exclude: [],
    };
    expect((await store.syncCollections([collection])).ok).toBe(true);
    const source =
      "---\ngno:\n  metadata:\n    score: 0.8\n---\n# Decision\napproved evidence";
    const path = join(dir, "decision.md");
    await Bun.write(path, source);
    const service = new SyncService();
    await service.syncCollection(collection, store);
    const before = await store.getDocument("notes", "decision.md");
    if (!before.ok || !before.value?.mirrorHash)
      throw new Error("Missing indexed document");
    expect(before.value.typedMetadata).toEqual({ score: 0.8 });
    const chunks = await store.getChunks(before.value.mirrorHash);
    const db = new Database(dbPath);
    db.run("UPDATE documents SET ingest_version=6, typed_metadata=NULL");
    expect(await store.getTypedMetadataCoverage({})).toEqual({
      ok: true,
      value: { pending: 1, invalid: 0 },
    });
    await service.syncCollection(collection, store);
    const after = await store.getDocument("notes", "decision.md");
    if (!after.ok || !after.value) throw new Error("Missing repaired document");
    expect(after.value.typedMetadata).toEqual({ score: 0.8 });
    expect(after.value.sourceHash).toBe(before.value.sourceHash);
    expect(after.value.mirrorHash).toBe(before.value.mirrorHash);
    expect(await store.getChunks(before.value.mirrorHash)).toEqual(chunks);
    expect(await Bun.file(path).text()).toBe(source);
    await Bun.write(path, source.replace("score: 0.8", "score: null"));
    await service.syncCollection(collection, store);
    expect(await store.getTypedMetadataCoverage({})).toEqual({
      ok: true,
      value: { pending: 0, invalid: 1 },
    });
    expect(
      await store.searchFts("evidence", {
        filter: { op: "not", predicate: { op: "eq", key: "score", value: 1 } },
      })
    ).toMatchObject({ ok: true, value: [] });
    expect(await store.searchFts("evidence")).toMatchObject({ ok: true });
    await Bun.write(path, source);
    await service.syncCollection(collection, store);
    expect(await store.getTypedMetadataCoverage({})).toEqual({
      ok: true,
      value: { pending: 0, invalid: 0 },
    });
    db.close();
  } finally {
    await store.close();
    await safeRm(dir);
  }
});

test("quoted alias-like text and bounded scalar aliases remain valid strings", () => {
  expect(
    extractTypedMetadata(
      '---\ngno:\n  metadata:\n    text: "include *wildcard and &literal"\n    first: &approved true\n    second: *approved\n---\n'
    )
  ).toEqual({
    typedMetadata: {
      text: "include *wildcard and &literal",
      first: true,
      second: true,
    },
  });
});

test("large ordinary frontmatter remains valid empty metadata", () => {
  expect(
    extractTypedMetadata("---\nordinary: " + "x".repeat(70_000) + "\n---\nbody")
  ).toEqual({ typedMetadata: {} });
  expect(
    extractTypedMetadata(
      "---\ngno:\n  metadata:\n    value: " + "x".repeat(70_000) + "\n---\nbody"
    ).metadataError
  ).toContain("64 KiB");
});
