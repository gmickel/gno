/**
 * Context Capsule fingerprints under collection access: a scoped caller's
 * Capsule is byte for byte the same whether or not the index and config hold
 * state it may not read (a hidden collection with documents and contexts,
 * and documents in a readable collection without valid `derived_from`).
 * Unrestricted callers keep fingerprints over the complete index and config.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config, Context } from "../../src/config/types";
import type { TypedMetadata } from "../../src/core/typed-metadata";
import type {
  RequestPrincipal,
  RequestSubject,
  ToolContext,
} from "../../src/mcp/context";

import { createDefaultConfig } from "../../src/config/defaults";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import { handleContext } from "../../src/mcp/tools/context";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const SOURCES = { derived_from: ["sp:drives/d1/items/i1"] };

const collection = (
  name: string,
  access: Collection["access"]
): Collection => ({
  name,
  path: `/tmp/${name}`,
  pattern: "**/*.md",
  include: [],
  exclude: [],
  access,
  egressPolicy: "remote",
});

const PUB = collection("pub", { public: true });
const SECRET = collection("secret", {
  accessRef: { sys: "sp", ref: "drives/x/root" },
});

const VISIBLE_CONTEXTS: Context[] = [
  { scopeType: "global", scopeKey: "/", text: "Team notes." },
  { scopeType: "collection", scopeKey: "pub:", text: "Public handbook." },
];
const HIDDEN_CONTEXTS: Context[] = [
  { scopeType: "collection", scopeKey: "secret:", text: "Board minutes." },
  {
    scopeType: "prefix",
    scopeKey: "gno://secret/deals",
    text: "Pending deals.",
  },
];

type Doc = [path: string, text: string, metadata: TypedMetadata];

const VISIBLE_DOCS: Doc[] = [
  ["pub/handbook.md", "needle handbook onboarding steps", SOURCES],
];
const HIDDEN_DOCS: Doc[] = [
  // Readable collection, but not servable: no `derived_from`.
  ["pub/unsourced.md", "needle unsourced draft", {}],
  // Readable collection, but not servable: malformed `derived_from`.
  ["pub/malformed.md", "needle malformed draft", { derived_from: ["x"] }],
  ["secret/deals/merger.md", "needle merger terms", SOURCES],
  ["secret/minutes.md", "needle board minutes", SOURCES],
];

interface World {
  store: SqliteAdapter;
  directory: string;
  collections: Collection[];
  config: Config;
}

const openWorld = async (hidden: boolean): Promise<World> => {
  const directory = await mkdtemp(join(tmpdir(), "access-capsule-fp-"));
  const store = new SqliteAdapter();
  const collections = hidden ? [PUB, SECRET] : [PUB];
  const contexts = hidden
    ? [...VISIBLE_CONTEXTS, ...HIDDEN_CONTEXTS]
    : VISIBLE_CONTEXTS;
  const config = { ...createDefaultConfig(), collections, contexts };
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(collections)).ok).toBe(true);
  expect((await store.syncContexts(contexts)).ok).toBe(true);
  for (const [path, text, typedMetadata] of hidden
    ? [...VISIBLE_DOCS, ...HIDDEN_DOCS]
    : VISIBLE_DOCS) {
    const [name, ...rest] = path.split("/");
    const relPath = rest.join("/");
    // Capsule evidence needs canonical source and mirror hashes.
    const mirrorHash = new Bun.CryptoHasher("sha256")
      .update(text)
      .digest("hex");
    const inserted = await store.upsertDocument({
      collection: name ?? "",
      relPath,
      sourceHash: mirrorHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: relPath,
      mirrorHash,
      typedMetadata,
      ingestVersion: TYPED_METADATA_INGEST_VERSION,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await store.upsertContent(mirrorHash, text)).ok).toBe(true);
    const chunk = { seq: 0, pos: 0, text, startLine: 1, endLine: 1 };
    expect(
      (await store.upsertChunks(mirrorHash, [{ ...chunk, language: "en" }])).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  }
  return { store, directory, collections, config };
};

let present: World;
let absent: World;

const READER: [RequestPrincipal, RequestSubject] = [
  { name: "assistant", admin: false, mayAssertSubject: true },
  { id: "u:bob", context: "1to1", hash: "hash-u:bob" },
];

const ctx = (
  world: World,
  caller: [RequestPrincipal, RequestSubject] | undefined
): ToolContext =>
  ({
    store: world.store,
    config: world.config,
    collections: world.collections,
    actualConfigPath: join(world.directory, "config.yml"),
    indexName: "default",
    toolMutex: { acquire: () => Promise.resolve(() => undefined) },
    jobManager: {},
    serverInstanceId: "access-capsule-fingerprints-test",
    writeLockPath: join(world.directory, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
    getRequestPrincipal: () => caller?.[0],
    getRequestSubject: () => caller?.[1],
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

interface CapsuleShape {
  fingerprints: { config: string; retrieval: string };
  retrieval: { indexSnapshot: { before: string; after: string } };
  evidence: { uri: string }[];
}

const build = async (
  world: World,
  caller: [RequestPrincipal, RequestSubject] | undefined,
  collections?: string[]
) => {
  const result = await handleContext(
    {
      goal: "needle onboarding",
      query: "needle",
      ...(collections ? { collections } : {}),
      limit: 8,
      budgetTokens: 100_000,
      budgetBytes: 100_000,
      depthPolicy: "fast",
      graph: false,
      noRerank: true,
    },
    ctx(world, caller)
  );
  expect(result.isError).toBeUndefined();
  return result;
};

beforeAll(async () => {
  present = await openWorld(true);
  absent = await openWorld(false);
});

afterAll(async () => {
  for (const world of [present, absent]) {
    await world.store.close();
    await safeRm(world.directory);
  }
});

describe("scoped Context Capsule fingerprints", () => {
  test("hidden state present vs absent: byte-identical Capsule", async () => {
    const withHidden = await build(present, READER);
    const withoutHidden = await build(absent, READER);
    const capsule = withHidden.structuredContent as unknown as CapsuleShape;
    expect(capsule.evidence.map((item) => item.uri)).toEqual([
      "gno://pub/handbook.md",
    ]);
    expect(JSON.stringify(withHidden)).toBe(JSON.stringify(withoutHidden));
    expect(JSON.stringify(withHidden)).not.toContain("secret");
  });

  test("the same holds when the caller names its collection", async () => {
    expect(JSON.stringify(await build(present, READER, ["pub"]))).toBe(
      JSON.stringify(await build(absent, READER, ["pub"]))
    );
  });

  test("unrestricted callers still fingerprint the complete state", async () => {
    const full = (await build(present, undefined, ["pub"]))
      .structuredContent as unknown as CapsuleShape;
    const bare = (await build(absent, undefined, ["pub"]))
      .structuredContent as unknown as CapsuleShape;
    // The hidden collection, its contexts and the documents a scoped caller
    // may not read are part of the complete config and index.
    expect(full.fingerprints.config).not.toBe(bare.fingerprints.config);
    expect(full.retrieval.indexSnapshot.after).not.toBe(
      bare.retrieval.indexSnapshot.after
    );
    expect(full.fingerprints.retrieval).not.toBe(bare.fingerprints.retrieval);
  });
});
