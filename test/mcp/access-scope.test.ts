import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { TypedMetadata } from "../../src/core/typed-metadata";
import type {
  RequestPrincipal,
  RequestSubject,
  ToolContext,
} from "../../src/mcp/context";

import { CollectionSchema } from "../../src/config/types";
import {
  accessRuleAdmits,
  authorizedCollectionNames,
  derivedFromIssue,
} from "../../src/core/access-scope";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import {
  assertMemoryReadable,
  assertMemoryWritable,
  mcpAccessScope,
  provenanceRetrievalScope,
} from "../../src/mcp/tools/access";
import { handleGet } from "../../src/mcp/tools/get";
import { handleMultiGet } from "../../src/mcp/tools/multi-get";
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

const COLLECTIONS: Collection[] = [
  collection("pub", { public: true }),
  collection("firm", {
    accessRef: { sys: "sp", ref: "drives/f/root" },
    firmwide: true,
  }),
  collection("secret", { accessRef: { sys: "sp", ref: "drives/x/root" } }),
  collection("mine", { owner: "u:alice" }),
  collection("legacy"),
];

const DOCS: {
  collection: string;
  relPath: string;
  metadata?: TypedMetadata;
}[] = [
  { collection: "pub", relPath: "a.md", metadata: SOURCES },
  { collection: "pub", relPath: "nosrc.md" },
  { collection: "pub", relPath: "bad.md", metadata: { derived_from: ["x"] } },
  { collection: "firm", relPath: "f.md", metadata: SOURCES },
  { collection: "secret", relPath: "s.md", metadata: SOURCES },
  { collection: "mine", relPath: "m.md", metadata: SOURCES },
  { collection: "legacy", relPath: "l.md", metadata: SOURCES },
];

const store = new SqliteAdapter();
let directory: string;
let principal: RequestPrincipal | undefined;
let subject: RequestSubject | undefined;

const as = (
  next: { admin?: boolean } | undefined,
  id?: string,
  context?: RequestSubject["context"]
): void => {
  principal = next
    ? { name: "assistant", admin: next.admin ?? false, mayAssertSubject: true }
    : undefined;
  subject = id ? { id, context, hash: `hash-${id}` } : undefined;
};

const ctx = (): ToolContext =>
  ({
    store,
    config: { version: "1.0", collections: COLLECTIONS } as Config,
    collections: COLLECTIONS,
    actualConfigPath: join(directory, "config.yml"),
    indexName: "default",
    toolMutex: { acquire: () => Promise.resolve(() => undefined) },
    jobManager: {},
    serverInstanceId: "access-scope-test",
    writeLockPath: join(directory, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
    getRequestPrincipal: () => principal,
    getRequestSubject: () => subject,
  }) as unknown as ToolContext;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "access-scope-"));
  expect(
    (await store.open(join(directory, "index.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(COLLECTIONS)).ok).toBe(true);
  for (const [index, doc] of DOCS.entries()) {
    const mirrorHash = `mirror-${index}`;
    const text = `needle note ${doc.collection} ${doc.relPath}`;
    const inserted = await store.upsertDocument({
      collection: doc.collection,
      relPath: doc.relPath,
      sourceHash: `source-${index}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: doc.relPath,
      mirrorHash,
      typedMetadata: doc.metadata,
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
});

afterAll(async () => {
  await store.close();
  await safeRm(directory);
});

describe("collection access config", () => {
  test("accepts exactly one access kind and firmwide only on accessRef", () => {
    const parse = (access: unknown) =>
      CollectionSchema.safeParse({ name: "c", path: "/c", access }).success;
    expect(parse({ public: true })).toBe(true);
    expect(parse({ owner: "u:1" })).toBe(true);
    expect(parse({ accessRef: { sys: "sp", ref: "r" }, firmwide: true })).toBe(
      true
    );
    expect(parse({ public: true, owner: "u:1" })).toBe(false);
    expect(parse({ owner: "u:1", firmwide: true })).toBe(false);
    expect(parse({ accessRef: { sys: "SP", ref: "r" } })).toBe(false);
    expect(parse({ public: false })).toBe(false);
  });
});

describe("access rules", () => {
  const request = (
    id: string | undefined,
    context?: RequestSubject["context"],
    admin = false
  ) => ({
    principal: { admin },
    subject: id ? { id, context } : undefined,
  });

  test("unrestricted without a principal or for an admin", () => {
    expect(authorizedCollectionNames(COLLECTIONS, {})).toBeUndefined();
    expect(
      authorizedCollectionNames(COLLECTIONS, request("u:a", "1to1", true))
    ).toBeUndefined();
  });

  test("per context: public, owner; accessRef (even firm-wide) and no access denied", () => {
    expect(
      authorizedCollectionNames(COLLECTIONS, request("u:alice", "1to1"))
    ).toEqual(["pub", "mine"]);
    expect(
      authorizedCollectionNames(COLLECTIONS, request("u:alice", "shared"))
    ).toEqual(["pub"]);
    expect(
      authorizedCollectionNames(COLLECTIONS, request("u:alice", "public_only"))
    ).toEqual(["pub"]);
    expect(
      authorizedCollectionNames(COLLECTIONS, request("u:bob", "1to1"))
    ).toEqual(["pub"]);
    expect(authorizedCollectionNames(COLLECTIONS, request(undefined))).toEqual([
      "pub",
    ]);
    // Every accessRef, firm-wide or not, stays denied until an access hook
    // exists.
    for (const firmwide of [undefined, true]) {
      for (const context of ["1to1", "shared"] as const) {
        expect(
          accessRuleAdmits(
            { accessRef: { sys: "sp", ref: "drives/x/root" }, firmwide },
            request("u:alice", context)
          )
        ).toBe(false);
      }
    }
  });

  test("retrieval allowlist leaves out invalid derived_from before the limit", async () => {
    as({}, "u:bob", "1to1");
    const scope = mcpAccessScope(ctx());
    if (!scope) throw new Error("expected access mode");
    // pub holds a.md (valid, mirror-0), nosrc.md (mirror-1), bad.md (mirror-2).
    expect(await provenanceRetrievalScope(scope, store)).toEqual({
      retrievalScope: { allowedMirrorHashes: ["mirror-0"] },
    });
    as({}, "u:alice", "1to1");
    const clean = mcpAccessScope(ctx());
    if (!clean) throw new Error("expected access mode");
    expect(
      await provenanceRetrievalScope({ ...clean, collections: ["mine"] }, store)
    ).toEqual({});
  });

  test("derived_from must be a non-empty <sys>:<ref> string array", () => {
    expect(derivedFromIssue(SOURCES)).toBeNull();
    expect(derivedFromIssue({})).toBe("missing");
    expect(derivedFromIssue(null)).toBe("missing");
    expect(derivedFromIssue({ derived_from: [] })).toBe("invalid");
    expect(derivedFromIssue({ derived_from: "sp:x" })).toBe("invalid");
    expect(derivedFromIssue({ derived_from: ["sp:x", "nope"] })).toBe(
      "invalid"
    );
    expect(derivedFromIssue(SOURCES, "bad frontmatter")).toBe("invalid");
  });
});

describe("scoped MCP reads", () => {
  test("an unreadable document and a missing one give byte-identical NOT_FOUND", async () => {
    as({}, "u:bob", "1to1");
    const refs = [
      "gno://secret/s.md",
      "gno://secret/none.md",
      "gno://nowhere/x.md",
      "gno://mine/m.md",
      "gno://legacy/l.md",
      "gno://pub/nosrc.md",
      "gno://pub/bad.md",
      "#000000",
      "gno://pub/a.md?index=other",
    ];
    const results = await Promise.all(
      refs.map((ref) => handleGet({ ref }, ctx()))
    );
    for (const result of results) {
      expect(JSON.stringify(result)).toBe(JSON.stringify(results[0]));
    }
    expect(results[0]).toEqual({
      isError: true,
      content: [{ type: "text", text: "Error: NOT_FOUND: Not found" }],
      structuredContent: { error: "NOT_FOUND", message: "Not found" },
    });
    const served = await handleGet({ ref: "gno://pub/a.md" }, ctx());
    expect(served.isError).toBeUndefined();
  });

  test("the owner reads their own collection only in 1:1", async () => {
    as({}, "u:alice", "1to1");
    expect(
      (await handleGet({ ref: "gno://mine/m.md" }, ctx())).isError
    ).toBeUndefined();
    as({}, "u:alice", "shared");
    expect((await handleGet({ ref: "gno://mine/m.md" }, ctx())).isError).toBe(
      true
    );
  });

  test("multi_get skips unreadable refs exactly like missing ones", async () => {
    as({}, "u:bob", "shared");
    const result = await handleMultiGet(
      { refs: ["gno://secret/s.md", "gno://pub/none.md", "gno://firm/f.md"] },
      ctx()
    );
    const data = result.structuredContent as {
      documents: { uri: string }[];
      skipped: { ref: string; reason: string }[];
    };
    expect(data.documents).toEqual([]);
    expect(data.skipped.map((skip) => skip.reason)).toEqual([
      "Not found",
      "Not found",
      "Not found",
    ]);
    const pattern = await handleMultiGet({ pattern: "gno://*" }, ctx());
    expect(
      (
        pattern.structuredContent as { documents: { uri: string }[] }
      ).documents.map((doc) => doc.uri)
    ).toEqual(["gno://pub/a.md"]);
  });

  test("search serves only readable collections and valid derived_from", async () => {
    as({}, "u:bob", "1to1");
    const uris = async (args: Record<string, unknown>) => {
      const result = await handleSearch(
        { query: "needle", limit: 20, ...args },
        ctx()
      );
      return result;
    };
    const all = await uris({});
    const data = all.structuredContent as {
      results: { uri: string }[];
      meta: { totalResults: number; collections?: string[] };
    };
    expect(data.results.map((r) => r.uri).sort()).toEqual(["gno://pub/a.md"]);
    expect(data.meta.totalResults).toBe(1);

    // An invalid derived_from is excluded before the limit, so it cannot take
    // the only slot.
    const top = (await uris({ limit: 1 })).structuredContent as {
      results: { uri: string }[];
    };
    expect(top.results.map((r) => r.uri)).toEqual(["gno://pub/a.md"]);
    expect(data.meta.collections).toBeUndefined();

    const denied = await uris({ collection: "secret" });
    const missing = await uris({ collection: "nowhere" });
    expect(JSON.stringify(denied)).toBe(JSON.stringify(missing));
    expect(denied.structuredContent).toEqual({
      error: "NOT_FOUND",
      message: "Not found",
    });

    as({}, "u:carol", "public_only");
    const pubOnly = (await uris({})).structuredContent as {
      results: { uri: string }[];
    };
    expect(pubOnly.results.map((r) => r.uri)).toEqual(["gno://pub/a.md"]);
  });

  test("without a principal, outputs are unchanged", async () => {
    as(undefined);
    const missing = await handleGet({ ref: "gno://secret/none.md" }, ctx());
    expect(missing.content).toEqual([
      { type: "text", text: "Error: Document not found: gno://secret/none.md" },
    ]);
    const result = await handleSearch({ query: "needle", limit: 20 }, ctx());
    expect(
      (result.structuredContent as { results: unknown[] }).results
    ).toHaveLength(DOCS.length);
    as({ admin: true }, "u:bob", "public_only");
    const admin = await handleSearch({ query: "needle", limit: 20 }, ctx());
    expect(
      (admin.structuredContent as { results: unknown[] }).results
    ).toHaveLength(DOCS.length);
  });

  test("memory: read needs a readable collection, write needs ownership", () => {
    as({}, "u:alice", "1to1");
    expect(() => assertMemoryReadable(ctx(), "mine")).not.toThrow();
    expect(() => assertMemoryWritable(ctx(), "mine")).not.toThrow();
    expect(() => assertMemoryWritable(ctx(), "pub")).toThrow(
      "NOT_FOUND: Not found"
    );
    as({}, "u:bob", "1to1");
    expect(() => assertMemoryReadable(ctx(), "mine")).toThrow(
      "NOT_FOUND: Not found"
    );
    expect(() => assertMemoryWritable(ctx(), "mine")).toThrow(
      "NOT_FOUND: Not found"
    );
    as(undefined);
    expect(() => assertMemoryWritable(ctx(), "pub")).not.toThrow();
  });
});
