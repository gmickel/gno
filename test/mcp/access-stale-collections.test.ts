/**
 * Collections the config omits (another client indexed them) under
 * collection access: a non-admin principal gets the same bytes whether or
 * not the index holds one, while an unrestricted caller is still refused
 * with STALE_COLLECTIONS naming them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type {
  RequestPrincipal,
  RequestSubject,
  ToolContext,
} from "../../src/mcp/context";

import { createDefaultConfig } from "../../src/config/defaults";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import { handleContext } from "../../src/mcp/tools/context";
import { handleGet } from "../../src/mcp/tools/get";
import { handleQuery } from "../../src/mcp/tools/query";
import { handleSearch } from "../../src/mcp/tools/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const SOURCES = { derived_from: ["sp:drives/d1/items/i1"] };

const collection = (
  name: string,
  access?: Collection["access"]
): Collection => ({
  name,
  path: `/tmp/${name}`,
  pattern: "**/*.md",
  include: [],
  exclude: [],
  ...(access ? { access } : {}),
});

/** The config every server in this test opens with. */
const CONFIGURED: Collection[] = [collection("pub", { public: true })];
/** Indexed by another client; absent from CONFIGURED. */
const HIDDEN = collection("hidden", { public: true });

interface Index {
  store: SqliteAdapter;
  directory: string;
}

const indexes: Record<"present" | "absent", Index | undefined> = {
  present: undefined,
  absent: undefined,
};

const insert = async (
  store: SqliteAdapter,
  name: string,
  relPath: string
): Promise<number> => {
  const text = `needle note ${name}/${relPath}`;
  // Capsule evidence needs canonical source and mirror hashes.
  const mirrorHash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const inserted = await store.upsertDocument({
    collection: name,
    relPath,
    sourceHash: mirrorHash,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: text.length,
    sourceMtime: "2026-10-01T00:00:00.000Z",
    title: relPath,
    mirrorHash,
    typedMetadata: SOURCES,
    ingestVersion: TYPED_METADATA_INGEST_VERSION,
  });
  if (!inserted.ok) throw new Error(inserted.error.message);
  expect((await store.upsertContent(mirrorHash, text)).ok).toBe(true);
  const chunk = { seq: 0, pos: 0, text, startLine: 1, endLine: 1 };
  expect(
    (await store.upsertChunks(mirrorHash, [{ ...chunk, language: "en" }])).ok
  ).toBe(true);
  expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  return inserted.value.id;
};

/**
 * One index with `pub/old.md` and `pub/other.md`. With `hidden`, another
 * client also indexed `hidden/new.md`, which supersedes `pub/old.md`.
 */
const openIndex = async (hidden: boolean): Promise<Index> => {
  const directory = await mkdtemp(join(tmpdir(), "access-stale-"));
  const store = new SqliteAdapter();
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect(
    (await store.syncCollections(hidden ? [...CONFIGURED, HIDDEN] : CONFIGURED))
      .ok
  ).toBe(true);
  const old = await insert(store, "pub", "old.md");
  await insert(store, "pub", "other.md");
  if (hidden) {
    const successor = await insert(store, "hidden", "new.md");
    const edge = await store.setDocEdges(
      successor,
      [{ targetDocId: old, edgeType: "supersedes", confidence: "parsed" }],
      "frontmatter-relation"
    );
    expect(edge.ok).toBe(true);
  }
  return { store, directory };
};

let principal: RequestPrincipal | undefined;
let subject: RequestSubject | undefined;

const asReader = (): void => {
  principal = { name: "assistant", admin: false, mayAssertSubject: true };
  subject = { id: "u:bob", context: "1to1", hash: "hash-u:bob" };
};
const asAdmin = (): void => {
  principal = { name: "ops", admin: true, mayAssertSubject: false };
  subject = undefined;
};
const asUnrestricted = (): void => {
  principal = undefined;
  subject = undefined;
};

const ctx = (index: Index): ToolContext =>
  ({
    store: index.store,
    config: { ...createDefaultConfig(), collections: CONFIGURED },
    collections: CONFIGURED,
    // Same paths for both indexes so the outputs can be compared byte for byte.
    actualConfigPath: "/config/access-stale.yml",
    indexName: "default",
    toolMutex: { acquire: () => Promise.resolve(() => undefined) },
    jobManager: {},
    serverInstanceId: "access-stale-test",
    writeLockPath: join(index.directory, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
    getRequestPrincipal: () => principal,
    getRequestSubject: () => subject,
    getModelAdapter: () => {
      const unavailable = async () => ({
        ok: false,
        error: { code: "MODEL_NOT_FOUND", message: "no models in this test" },
      });
      return {
        createEmbeddingPort: unavailable,
        createExpansionPort: unavailable,
        createRerankPort: unavailable,
        createGenerationPort: unavailable,
      };
    },
  }) as unknown as ToolContext;

const CALLS: Record<string, (context: ToolContext) => Promise<unknown>> = {
  gno_search: (context) =>
    handleSearch({ query: "needle", limit: 20 }, context),
  gno_query: (context) =>
    handleQuery(
      { query: "needle", limit: 20, fast: true, noGraph: true },
      context
    ),
  gno_get: (context) => handleGet({ ref: "gno://pub/old.md" }, context),
  gno_get_hidden: (context) =>
    handleGet({ ref: "gno://hidden/new.md" }, context),
  gno_context: (context) =>
    handleContext(
      {
        goal: "needle note",
        query: "needle",
        limit: 8,
        budgetTokens: 100_000,
        budgetBytes: 100_000,
        depthPolicy: "fast",
        graph: false,
        noRerank: true,
      },
      context
    ),
};

beforeAll(async () => {
  indexes.present = await openIndex(true);
  indexes.absent = await openIndex(false);
});

afterAll(async () => {
  for (const index of Object.values(indexes)) {
    if (!index) continue;
    await index.store.close();
    await safeRm(index.directory);
  }
});

describe("collections the config omits", () => {
  test("a non-admin principal gets the same bytes with or without one", async () => {
    asReader();
    for (const [name, call] of Object.entries(CALLS)) {
      const present = JSON.stringify(await call(ctx(indexes.present as Index)));
      const absent = JSON.stringify(await call(ctx(indexes.absent as Index)));
      expect({ name, present }).toEqual({ name, present: absent });
      expect(present).not.toContain("hidden");
      expect(present).not.toContain("STALE");
    }
  });

  test("the answer is a real answer, not a blanket refusal", async () => {
    asReader();
    const result = (await CALLS.gno_search?.(
      ctx(indexes.present as Index)
    )) as { isError?: boolean; structuredContent: { results: unknown[] } };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.results).toHaveLength(2);
  });

  test("unrestricted and admin callers are still refused with the names", async () => {
    for (const as of [asUnrestricted, asAdmin]) {
      as();
      const result = (await CALLS.gno_search?.(
        ctx(indexes.present as Index)
      )) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "This index holds collections the config does not list: hidden (1 document)"
      );
      const clean = (await CALLS.gno_search?.(
        ctx(indexes.absent as Index)
      )) as { isError?: boolean };
      expect(clean.isError).toBeUndefined();
    }
  });
});
