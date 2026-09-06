import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { createVectorVariantStore } from "../../../src/store/vector/variants";

export const statusIdentity = {
  model: "status-model",
  modelFingerprint: "verified-weights",
  contextSize: 512,
  truncationPolicy: "truncate-tail-v1",
  dimensions: 2,
};

/** Synthetic shared-content fixture, also usable by live CLI/API QA. */
export async function createVariantStatusFixture(
  dbPath: string,
  model = statusIdentity.model
) {
  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, "unicode61");
  if (!opened.ok) throw new Error(opened.error.message);
  await store.syncCollections(
    ["notes", "archive"].map((name) => ({
      name,
      path: `/synthetic/${name}`,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }))
  );
  for (const [collection, relPath, title, mirrorHash] of [
    ["notes", "alpha.md", "Alpha", "shared"],
    ["notes", "beta.md", "Beta", "shared"],
    ["archive", "alpha.md", "Alpha", "shared"],
    ["archive", "inactive.md", "Inactive", "inactive"],
  ] as const) {
    const result = await store.upsertDocument({
      collection,
      relPath,
      title,
      mirrorHash,
      sourceHash: `${collection}-${relPath}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 20,
      sourceMtime: "2026-09-06T00:00:00Z",
    });
    if (!result.ok) throw new Error(result.error.message);
  }
  for (const mirrorHash of ["shared", "inactive"]) {
    await store.upsertContent(mirrorHash, "Synthetic status fixture");
    await store.upsertChunks(
      mirrorHash,
      Array.from({ length: mirrorHash === "shared" ? 2 : 1 }, (_, seq) => ({
        seq,
        pos: seq,
        text: `Synthetic chunk ${seq}`,
        startLine: seq + 1,
        endLine: seq + 1,
      }))
    );
  }
  const db = store.getRawDb();
  db.run("UPDATE documents SET active = 0 WHERE rel_path = 'inactive.md'");
  const variants = await createVectorVariantStore(db, {
    ...statusIdentity,
    model,
  });
  variants.write(
    variants
      .pending()
      .map((owner) => ({ owner, embedding: new Float32Array([1, 0]) }))
  );
  variants.activate(variants.epoch());
  return { store, variants };
}
