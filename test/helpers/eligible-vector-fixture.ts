import { Database } from "bun:sqlite";
import { expect } from "bun:test";
// Bun has no directory creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eligibleTopKFixture } from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { safeRm } from "./cleanup";

export async function createEligibleVectorFixture() {
  const fixture = eligibleTopKFixture();
  const adapter = new SqliteAdapter();

  const directory = await mkdtemp(join(tmpdir(), "eligible-top-k-"));
  const path = join(directory, "index.sqlite");
  expect((await adapter.open(path, "unicode61")).ok).toBe(true);
  expect(
    (
      await adapter.syncCollections([
        {
          name: "notes",
          path: directory,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);
  for (const { doc, chunks, tags } of fixture) {
    const inserted = await adapter.upsertDocument({
      collection: doc.collection,
      relPath: doc.relPath,
      sourceHash: doc.sourceHash,
      sourceMime: doc.sourceMime,
      sourceExt: doc.sourceExt,
      sourceSize: doc.sourceSize,
      sourceMtime: doc.sourceMtime,
      title: doc.title ?? undefined,
      mirrorHash: doc.mirrorHash ?? undefined,
      contentType: doc.contentType ?? undefined,
      categories: doc.categories ?? undefined,
      author: doc.author ?? undefined,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect(
      (
        await adapter.upsertContent(
          doc.mirrorHash!,
          chunks.map((c) => c.text).join("\n")
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.upsertChunks(
          doc.mirrorHash!,
          chunks.map((chunk) => ({
            ...chunk,
            language: chunk.language ?? undefined,
            tokenCount: chunk.tokenCount ?? undefined,
          }))
        )
      ).ok
    ).toBe(true);
    expect(
      (await adapter.setDocTags(inserted.value.id, tags, "frontmatter")).ok
    ).toBe(true);
    expect((await adapter.rebuildFtsForHash(doc.mirrorHash!)).ok).toBe(true);
    if (!doc.active)
      expect(
        (await adapter.markInactive(doc.collection, [doc.relPath])).ok
      ).toBe(true);
  }
  const db = new Database(path);
  const created = await createVectorIndexPort(db, {
    model: "eligibility-test",
    dimensions: 2,
  });
  if (!created.ok) throw new Error(created.error.message);
  const vectorIndex = created.value;
  expect(vectorIndex.searchAvailable).toBe(true);
  for (const item of fixture) {
    expect(
      (
        await vectorIndex.upsertVectors(
          item.chunks.map((chunk, index) => ({
            mirrorHash: chunk.mirrorHash,
            seq: chunk.seq,
            model: vectorIndex.model,
            embedFingerprint: "test",
            embedding: new Float32Array(item.vectors[index]!),
          }))
        )
      ).ok
    ).toBe(true);
  }

  return {
    adapter,
    db,
    vectorIndex,
    close: async () => {
      db.close();
      await adapter.close();
      await safeRm(directory);
    },
  };
}
