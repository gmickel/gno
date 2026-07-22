import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildActivationStatus } from "../../src/core/activation-status";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const COLLECTION_COUNT = 20;
const STATUS_BUDGET_MS = 250;

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

describe("activation status performance", () => {
  let store: SqliteAdapter;
  let tempDir: string;
  const collections = Array.from(
    { length: COLLECTION_COUNT },
    (_, index) => `collection-${index.toString().padStart(2, "0")}`
  );

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-activation-status-perf-"));
    store = new SqliteAdapter();
    expect(
      (await store.open(join(tempDir, "index.sqlite"), "unicode61")).ok
    ).toBe(true);
    expect(
      (
        await store.syncCollections(
          collections.map((name) => ({
            name,
            path: join(tempDir, name),
            pattern: "**/*.md",
            include: [],
            exclude: [],
          }))
        )
      ).ok
    ).toBe(true);

    for (const collection of collections) {
      const markdown = `# ${collection}\nZephyr${collection.replaceAll("-", "")} proves bounded lexical activation.`;
      const mirrorHash = hash(`mirror:${markdown}`);
      expect(
        (
          await store.upsertDocument({
            collection,
            relPath: "proof.md",
            sourceHash: hash(`source:${markdown}`),
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: markdown.length,
            sourceMtime: "2026-07-22T10:00:00.000Z",
            mirrorHash,
            title: collection,
          })
        ).ok
      ).toBe(true);
      expect((await store.upsertContent(mirrorHash, markdown)).ok).toBe(true);
      expect(
        (
          await store.upsertChunks(mirrorHash, [
            {
              seq: 0,
              pos: 0,
              text: markdown,
              startLine: 1,
              endLine: 2,
            },
          ])
        ).ok
      ).toBe(true);
      expect((await store.syncDocumentFts(collection, "proof.md")).ok).toBe(
        true
      );
    }
  }, 30_000);

  afterAll(async () => {
    await store.close();
    await safeRm(tempDir);
  });

  test("keeps a fingerprint-current multi-collection status build bounded", async () => {
    const warm = await buildActivationStatus(store, collections);
    expect(warm.healthy).toBe(true);

    let contentReads = 0;
    const originalGetContent = store.getContent.bind(store);
    const originalGetContentPrefix = store.getContentPrefix.bind(store);
    store.getContent = async (...args) => {
      contentReads += 1;
      return originalGetContent(...args);
    };
    store.getContentPrefix = async (...args) => {
      contentReads += 1;
      return originalGetContentPrefix(...args);
    };
    const startedAt = performance.now();
    const status = await buildActivationStatus(
      store,
      [...collections].reverse()
    );
    const elapsedMs = performance.now() - startedAt;
    store.getContent = originalGetContent;
    store.getContentPrefix = originalGetContentPrefix;

    expect(status.healthy).toBe(true);
    expect(status.collections).toHaveLength(COLLECTION_COUNT);
    expect(status.collections.map(({ collection }) => collection)).toEqual(
      collections
    );
    expect(status.connectors).toEqual([]);
    expect(contentReads).toBe(0);
    expect(elapsedMs).toBeLessThan(STATUS_BUDGET_MS);
  });
});
