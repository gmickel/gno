/** Synthetic activated-owner fixture copied from the pinned legacy capture. */
import { Database } from "bun:sqlite";
// Bun has no directory creation or path utilities.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { EmbeddingPort } from "../../src/llm/types";
import type { StoreResult } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { resolveVectorSearchIdentity } from "../../src/store/vector/variant-search";
import { createVectorVariantStore } from "../../src/store/vector/variants";
import { canonicalFingerprint } from "../agentic/canonical";
import { scalingCorpus } from "./eligible-scaling";
const fixtureVersion = "eligible-variant-scaling-v1";
export const model = "synthetic:eligible-scaling-v1";
export const embedPort: EmbeddingPort = {
  modelUri: model,
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
  getIdentity: () => ({
    contextSize: 512,
    truncationPolicy: "synthetic-tail-v1",
    modelFingerprint: "known-2d-v1",
    runtimeFingerprint: "known-cpu-v1",
  }),
};
export const identity = resolveVectorSearchIdentity(embedPort)!;
export const must = <T>(value: StoreResult<T>): T => {
  if (!value.ok) throw new Error(`${value.error.code}: ${value.error.message}`);
  return value.value;
};
export async function reader(path: string) {
  const store = new SqliteAdapter();
  must(await store.open(path, "unicode61"));
  const db = new Database(path);
  const vector = must(
    await createVectorIndexPort(db, { model, dimensions: 2 })
  );
  if (!vector.searchAvailable)
    throw new Error(`VEC_SEARCH_UNAVAILABLE: ${vector.loadError}`);
  return { store, db, vector };
}
export type Client = Awaited<ReturnType<typeof reader>>;
export async function setup(size: number, previousDirectory: string) {
  if (!process.env.TMPDIR)
    throw new Error("Set isolated TMPDIR outside the repository");
  const directory = await mkdtemp(
    join(process.env.TMPDIR, `variant-scaling-${size}-`)
  );
  const path = join(directory, "index.sqlite");
  const source = new Database(join(previousDirectory, "index.sqlite"), {
    readonly: true,
  });
  try {
    source.query("VACUUM INTO ?").run(path);
  } finally {
    source.close();
  }
  const client = await reader(path);
  const fixture = scalingCorpus(size);
  const target = fixture.at(-1)!;
  client.db.query("UPDATE documents SET title='Alpha' WHERE id=?").run(size);
  const owners = fixture.map((item) => ({
    id: item.index + 1,
    uri: item.uri,
    hash: item.hash,
    title: item.rare ? "Alpha" : "Record",
    text: item.text,
    active: item.active,
    rare: item.rare,
    beta: false,
  }));
  for (const [offset, title] of [
    [1, "Beta"],
    [2, "Alpha"],
  ] as const) {
    const relPath = `scope/title-owner-${offset}.md`;
    const inserted = must(
      await client.store.upsertDocument({
        collection: "scaling",
        relPath,
        sourceHash: canonicalFingerprint({
          version: fixtureVersion,
          size,
          title,
          offset,
        }),
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: target.text.length,
        sourceMtime: "2026-09-01T00:00:00.000Z",
        title,
        mirrorHash: target.hash,
      })
    );
    must(
      await client.store.setDocTags(
        inserted.id,
        [offset === 1 ? "beta" : "alpha-copy"],
        "frontmatter"
      )
    );
    owners.push({
      id: inserted.id,
      uri: `gno://scaling/${relPath}`,
      hash: target.hash,
      title,
      text: target.text,
      active: true,
      rare: false,
      beta: offset === 1,
    });
  }
  must(await client.store.rebuildFtsForHash(target.hash));
  const variants = await createVectorVariantStore(client.db, identity);
  for (;;) {
    const pending = variants.pending({ limit: 1000 });
    if (!pending.length) break;
    variants.write(
      pending.map((owner) => ({
        owner,
        embedding: new Float32Array(
          owner.documentId === size || owner.documentId === size + 2
            ? [1, 0]
            : owner.documentId === size + 1
              ? [0, 1]
              : fixture[owner.documentId - 1]!.vector
        ),
      }))
    );
  }
  variants.activate(variants.epoch());
  if (!variants.hasActivated() || !variants.isActive())
    throw new Error("Synthetic partition did not activate");
  return { client, owners, variants, path, directory };
}
export type State = Awaited<ReturnType<typeof setup>>;
