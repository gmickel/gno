/**
 * `supersededBy` under collection access: a successor the caller may not
 * read is never named, and a hidden hop never bridges a supersession chain,
 * on every scoped read (get, multi-get, search, query, Context Capsule).
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
import { handleMultiGet } from "../../src/mcp/tools/multi-get";
import { handleQuery } from "../../src/mcp/tools/query";
import { handleSearch } from "../../src/mcp/tools/search";
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
});

const COLLECTIONS: Collection[] = [
  collection("pub", { public: true }),
  collection("secret", { accessRef: { sys: "sp", ref: "drives/x/root" } }),
];

const DOCS = [
  "pub/old.md",
  "secret/new.md",
  "pub/chain-a.md",
  "pub/chain-b.md",
  "secret/chain-c.md",
  "pub/bridge-a.md",
  "secret/bridge-b.md",
  "pub/bridge-c.md",
] as const;

/** successor supersedes predecessor (frontmatter `relations: supersedes`). */
const SUPERSEDES: [successor: string, predecessor: string][] = [
  ["secret/new.md", "pub/old.md"],
  ["pub/chain-b.md", "pub/chain-a.md"],
  ["secret/chain-c.md", "pub/chain-b.md"],
  ["secret/bridge-b.md", "pub/bridge-a.md"],
  ["pub/bridge-c.md", "secret/bridge-b.md"],
];

const uri = (path: string) => `gno://${path}`;

const store = new SqliteAdapter();
let directory: string;
let principal: RequestPrincipal | undefined;
let subject: RequestSubject | undefined;

const asReader = (): void => {
  principal = { name: "assistant", admin: false, mayAssertSubject: true };
  subject = { id: "u:bob", context: "1to1", hash: "hash-u:bob" };
};
const asUnrestricted = (): void => {
  principal = undefined;
  subject = undefined;
};

const ctx = (): ToolContext =>
  ({
    store,
    config: { ...createDefaultConfig(), collections: COLLECTIONS },
    collections: COLLECTIONS,
    actualConfigPath: join(directory, "config.yml"),
    indexName: "default",
    toolMutex: { acquire: () => Promise.resolve(() => undefined) },
    jobManager: {},
    serverInstanceId: "access-supersession-test",
    writeLockPath: join(directory, ".write.lock"),
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

/** `supersededBy` per result URI, for results that carry one. */
const successors = (
  results: { uri: string; supersededBy?: string }[]
): Record<string, string> =>
  Object.fromEntries(
    results
      .filter((result) => result.supersededBy)
      .map((result) => [result.uri, result.supersededBy as string])
  );

const SCOPED = {
  [uri("pub/chain-a.md")]: uri("pub/chain-b.md"),
};
const UNRESTRICTED = {
  [uri("pub/old.md")]: uri("secret/new.md"),
  [uri("pub/chain-a.md")]: uri("secret/chain-c.md"),
  [uri("pub/chain-b.md")]: uri("secret/chain-c.md"),
  [uri("pub/bridge-a.md")]: uri("pub/bridge-c.md"),
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "access-supersession-"));
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(COLLECTIONS)).ok).toBe(true);
  const ids = new Map<string, number>();
  for (const path of DOCS) {
    const [name, relPath] = path.split("/") as [string, string];
    const text = `needle note ${path}`;
    // Capsule evidence needs canonical source and mirror hashes.
    const mirrorHash = new Bun.CryptoHasher("sha256")
      .update(text)
      .digest("hex");
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
    ids.set(path, inserted.value.id);
    expect((await store.upsertContent(mirrorHash, text)).ok).toBe(true);
    const chunk = { seq: 0, pos: 0, text, startLine: 1, endLine: 1 };
    expect(
      (await store.upsertChunks(mirrorHash, [{ ...chunk, language: "en" }])).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  }
  for (const [successor, predecessor] of SUPERSEDES) {
    const edge = await store.setDocEdges(
      ids.get(successor) as number,
      [
        {
          targetDocId: ids.get(predecessor) as number,
          edgeType: "supersedes",
          confidence: "parsed",
        },
      ],
      "frontmatter-relation"
    );
    expect(edge.ok).toBe(true);
  }
});

afterAll(async () => {
  await store.close();
  await safeRm(directory);
});

describe("store chain walk", () => {
  test("canFollow stops before the first hidden successor", async () => {
    const all = DOCS.filter((path) => path.startsWith("pub/")).map(uri);
    const open = await store.getSupersedingUris(all);
    expect(open.ok && Object.fromEntries(open.value)).toEqual(UNRESTRICTED);
    const scoped = await store.getSupersedingUris(all, {
      canFollow: async (target) => target.startsWith("gno://pub/"),
    });
    expect(scoped.ok && Object.fromEntries(scoped.value)).toEqual(SCOPED);
  });
});

describe("scoped reads never name a hidden successor", () => {
  test("gno_get", async () => {
    const read = async (path: string) =>
      (
        (await handleGet({ ref: uri(path) }, ctx())).structuredContent as {
          supersededBy?: string;
        }
      ).supersededBy;
    asReader();
    expect(await read("pub/old.md")).toBeUndefined();
    expect(await read("pub/chain-a.md")).toBe(uri("pub/chain-b.md"));
    expect(await read("pub/chain-b.md")).toBeUndefined();
    expect(await read("pub/bridge-a.md")).toBeUndefined();
    asUnrestricted();
    expect(await read("pub/old.md")).toBe(uri("secret/new.md"));
    expect(await read("pub/bridge-a.md")).toBe(uri("pub/bridge-c.md"));
  });

  test("gno_multi_get", async () => {
    const read = async () =>
      successors(
        (
          (await handleMultiGet({ pattern: "gno://pub/*" }, ctx()))
            .structuredContent as {
            documents: { uri: string; supersededBy?: string }[];
          }
        ).documents
      );
    asReader();
    expect(await read()).toEqual(SCOPED);
    asUnrestricted();
    expect(await read()).toEqual(UNRESTRICTED);
  });

  test("gno_search", async () => {
    const read = async () => {
      const result = await handleSearch(
        { query: "needle", collection: "pub", limit: 20 },
        ctx()
      );
      expect(result.isError).toBeUndefined();
      return successors(
        (
          result.structuredContent as {
            results: { uri: string; supersededBy?: string }[];
          }
        ).results
      );
    };
    asReader();
    expect(await read()).toEqual(SCOPED);
    asUnrestricted();
    expect(await read()).toEqual(UNRESTRICTED);
  });

  test("gno_query", async () => {
    const read = async () => {
      const result = await handleQuery(
        {
          query: "needle",
          collection: "pub",
          limit: 20,
          fast: true,
          noGraph: true,
        },
        ctx()
      );
      expect(result.isError).toBeUndefined();
      return successors(
        (
          result.structuredContent as {
            results: { uri: string; supersededBy?: string }[];
          }
        ).results
      );
    };
    asReader();
    expect(await read()).toEqual(SCOPED);
    asUnrestricted();
    expect(await read()).toEqual(UNRESTRICTED);
  });

  test("gno_context", async () => {
    const build = async () => {
      const result = await handleContext(
        {
          goal: "needle note",
          query: "needle",
          collections: ["pub"],
          limit: 8,
          budgetTokens: 100_000,
          budgetBytes: 100_000,
          depthPolicy: "fast",
          graph: false,
          noRerank: true,
        },
        ctx()
      );
      expect(result.isError).toBeUndefined();
      return JSON.stringify(result);
    };
    asReader();
    const scoped = await build();
    expect(scoped).toContain("gno://pub/old.md");
    expect(scoped).not.toContain("gno://secret/");
    expect(scoped).toContain("gno://pub/chain-b.md");
    asUnrestricted();
    expect(await build()).toContain("gno://secret/new.md");
  });
});
