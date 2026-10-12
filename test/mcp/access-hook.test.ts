import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { AccessHookRequest } from "../../src/core/access-hook";
import type { TypedMetadata } from "../../src/core/typed-metadata";
import type { RerankPort } from "../../src/llm/types";
import type { RequestSubject, ToolContext } from "../../src/mcp/context";

import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import {
  accessRetrievalOptions,
  resolveMcpAccess,
} from "../../src/mcp/tools/access";
import { handleGet } from "../../src/mcp/tools/get";
import { handleMultiGet } from "../../src/mcp/tools/multi-get";
import { handleSearch } from "../../src/mcp/tools/search";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

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
  collection("firm", {
    accessRef: { sys: "sp", ref: "site-firm" },
    firmwide: true,
  }),
  collection("x", { accessRef: { sys: "sp", ref: "site-x" } }),
  collection("keyed", { public: true, provenanceKey: "sources" }),
];

const DOCS: { collection: string; relPath: string; metadata: TypedMetadata }[] =
  [
    {
      collection: "pub",
      relPath: "open.md",
      metadata: { derived_from: ["web:ok-1"] },
    },
    {
      collection: "pub",
      relPath: "closed.md",
      metadata: { derived_from: ["sp:secret-1"] },
    },
    {
      collection: "pub",
      relPath: "mixed.md",
      metadata: { derived_from: ["web:ok-2", "sp:secret-2"] },
    },
    {
      collection: "firm",
      relPath: "f.md",
      metadata: { derived_from: ["web:ok-3"] },
    },
    {
      collection: "x",
      relPath: "x.md",
      metadata: { derived_from: ["web:ok-4"] },
    },
    {
      collection: "keyed",
      relPath: "k.md",
      metadata: { sources: ["web:ok-5"] },
    },
    {
      collection: "keyed",
      relPath: "wrong.md",
      metadata: { derived_from: ["web:ok-6"] },
    },
  ];

const store = new SqliteAdapter();
let directory: string;
let server: ReturnType<typeof Bun.serve>;
const calls: AccessHookRequest[] = [];
let subject: RequestSubject = { id: "u:a", context: "1to1", hash: "h" };

/** Fake hook: `web:ok-*` and `sp:site-firm` for everyone, `sp:site-x` for u:a, 500 for u:down. */
const allow = (who: string, member: string) =>
  member.startsWith("web:ok-") ||
  member === "sp:site-firm" ||
  (who === "u:a" && member === "sp:site-x");

const ctx = (): ToolContext =>
  ({
    store,
    config: {
      version: "1.0",
      collections: COLLECTIONS,
      gateway: {
        accessHook: {
          url: "http://hook/check",
          unix: join(directory, "hook.sock"),
          timeoutMs: 500,
        },
      },
    } as unknown as Config,
    collections: COLLECTIONS,
    actualConfigPath: join(directory, "config.yml"),
    indexName: "default",
    toolMutex: { acquire: () => Promise.resolve(() => undefined) },
    jobManager: {},
    serverInstanceId: "access-hook-test",
    writeLockPath: join(directory, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
    getRequestPrincipal: () => ({
      name: "assistant",
      admin: false,
      mayAssertSubject: true,
    }),
    getRequestSubject: () => subject,
  }) as unknown as ToolContext;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gno-ahk-"));
  server = Bun.serve({
    unix: join(directory, "hook.sock"),
    async fetch(request) {
      const body = (await request.json()) as AccessHookRequest;
      calls.push(body);
      if (body.subject === "u:down") return new Response("x", { status: 500 });
      return Response.json({
        allow: body.refs.flatMap((ref, index) =>
          allow(body.subject, `${ref.sys}:${ref.ref}`) ? [index] : []
        ),
      });
    },
  });
  expect(
    (await store.open(join(directory, "index.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(COLLECTIONS)).ok).toBe(true);
  for (const [index, doc] of DOCS.entries()) {
    const mirrorHash = `mirror-${index}`;
    const text = `needle note ${doc.relPath}`;
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
    expect(
      (
        await store.upsertChunks(mirrorHash, [
          { seq: 0, pos: 0, text, startLine: 1, endLine: 1, language: "en" },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  }
});

afterAll(async () => {
  await server.stop(true);
  await store.close();
  await safeRm(directory);
});

const searchUris = async (args: Record<string, unknown> = {}) => {
  const result = await handleSearch(
    { query: "needle", limit: 20, ...args },
    ctx()
  );
  const data = result.structuredContent as {
    results: { uri: string }[];
    meta: { totalResults: number; warnings?: unknown };
  };
  return { uris: data.results.map((r) => r.uri).sort(), meta: data.meta };
};

describe("access hook in MCP reads", () => {
  test("accessRef collections open per hook and context", async () => {
    subject = { id: "u:a", context: "1to1", hash: "h" };
    expect((await resolveMcpAccess(ctx()))?.collections).toEqual([
      "pub",
      "firm",
      "x",
      "keyed",
    ]);
    subject = { id: "u:b", context: "1to1", hash: "h" };
    expect((await resolveMcpAccess(ctx()))?.collections).toEqual([
      "pub",
      "firm",
      "keyed",
    ]);
    // Shared: only firm-wide accessRefs are even asked about.
    subject = { id: "u:a", context: "shared", hash: "h" };
    calls.length = 0;
    expect((await resolveMcpAccess(ctx()))?.collections).toEqual([
      "pub",
      "firm",
      "keyed",
    ]);
    expect(calls.map((call) => call.refs)).toEqual([
      [{ sys: "sp", ref: "site-firm" }],
    ]);
    expect(calls[0]).toMatchObject({ subject: "u:a", ctx: "shared" });
    subject = { id: "u:a", context: "public_only", hash: "h" };
    expect((await resolveMcpAccess(ctx()))?.collections).toEqual([
      "pub",
      "keyed",
    ]);
  });

  test("every hook call of a request carries the caller's GNO-Request-Id", async () => {
    // Contract with a stateful hook: it matches request_id to the
    // turn it registered, so collection and document checks must reuse it.
    subject = {
      id: "u:a",
      context: "1to1",
      requestId: "3f2a9c0e8b7d4e6f9a1b2c3d4e5f6a7b",
      hash: "h",
    };
    calls.length = 0;
    await searchUris();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map((call) => call.request_id))).toEqual(
      new Set(["3f2a9c0e8b7d4e6f9a1b2c3d4e5f6a7b"])
    );
    // Without the header: one fresh id per tool call, still shared by its calls.
    subject = { id: "u:a", context: "1to1", hash: "h" };
    calls.length = 0;
    await searchUris();
    const ids = new Set(calls.map((call) => call.request_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe("3f2a9c0e8b7d4e6f9a1b2c3d4e5f6a7b");
  });

  test("search serves only pages whose every ref is allowed, counts included", async () => {
    subject = { id: "u:a", context: "1to1", hash: "h" };
    const { uris, meta } = await searchUris();
    expect(uris).toEqual([
      "gno://firm/f.md",
      "gno://keyed/k.md",
      "gno://pub/open.md",
      "gno://x/x.md",
    ]);
    expect(meta.totalResults).toBe(4);
    expect(meta.warnings).toBeUndefined();
    subject = { id: "u:b", context: "1to1", hash: "h" };
    expect((await searchUris()).uris).toEqual([
      "gno://firm/f.md",
      "gno://keyed/k.md",
      "gno://pub/open.md",
    ]);
  });

  test("a failing hook denies everything, public pages included", async () => {
    subject = { id: "u:down", context: "1to1", hash: "h" };
    const { uris, meta } = await searchUris();
    expect(uris).toEqual([]);
    expect(meta.totalResults).toBe(0);
    expect((await handleGet({ ref: "gno://pub/open.md" }, ctx())).isError).toBe(
      true
    );
  });

  test("a denied page and a missing one give byte-identical NOT_FOUND", async () => {
    subject = { id: "u:b", context: "1to1", hash: "h" };
    const missing = JSON.stringify(
      await handleGet({ ref: "gno://pub/none.md" }, ctx())
    );
    for (const ref of [
      "gno://pub/closed.md",
      "gno://pub/mixed.md",
      "gno://x/x.md",
      "gno://keyed/wrong.md",
    ]) {
      expect(JSON.stringify(await handleGet({ ref }, ctx()))).toBe(missing);
    }
    expect(
      (await handleGet({ ref: "gno://pub/open.md" }, ctx())).isError
    ).toBeUndefined();
  });

  test("multi_get patterns never name a denied page", async () => {
    subject = { id: "u:b", context: "1to1", hash: "h" };
    const result = await handleMultiGet({ pattern: "gno://pub/*" }, ctx());
    const data = result.structuredContent as {
      documents: { uri: string }[];
      skipped: { ref: string }[];
    };
    expect(data.documents.map((d) => d.uri)).toEqual(["gno://pub/open.md"]);
    expect(data.skipped).toEqual([]);
  });
});

describe("access hook in hybrid retrieval", () => {
  test("denied candidates never reach the reranker or the results", async () => {
    subject = { id: "u:b", context: "1to1", hash: "h" };
    const scope = await resolveMcpAccess(ctx());
    if (!scope?.check) throw new Error("expected a hook check");
    const reranked: string[] = [];
    const rerankPort: RerankPort = {
      modelUri: "spy",
      dispose: async () => {},
      rerank: async (_query, documents) => {
        reranked.push(...documents);
        return {
          ok: true,
          value: documents.map((_, index) => ({
            index,
            score: 1 - index / 100,
            rank: index + 1,
          })),
        };
      },
    };
    const result = await searchHybrid(
      {
        store,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort,
      },
      "needle",
      {
        limit: 10,
        noExpand: true,
        explain: true,
        collections: scope.collections,
        access: scope.check,
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((r) => r.uri).sort()).toEqual([
      "gno://firm/f.md",
      "gno://keyed/k.md",
      "gno://pub/open.md",
    ]);
    expect(reranked.length).toBeGreaterThan(0);
    for (const text of reranked) {
      expect(text).not.toMatch(/closed|mixed|x\.md|wrong/);
    }
    expect(
      result.value.meta.explain?.lines.find((line) => line.stage === "access")
        ?.message
    ).toMatch(/^checked=\d+, denied=\d+, overfetch=x3$/);
  });
});

describe("access hook and graph links", () => {
  const addNote = async (
    relPath: string,
    title: string,
    source: string,
    text: string
  ): Promise<number> => {
    // Distinct hex hashes: a docid is the first eight characters.
    const mirrorHash = new Bun.CryptoHasher("sha256")
      .update(relPath)
      .digest("hex");
    const inserted = await store.upsertDocument({
      collection: "pub",
      relPath,
      sourceHash: mirrorHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title,
      mirrorHash,
      typedMetadata: { derived_from: [source] },
      ingestVersion: TYPED_METADATA_INGEST_VERSION,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await store.upsertContent(mirrorHash, text)).ok).toBe(true);
    expect(
      (
        await store.upsertChunks(mirrorHash, [
          { seq: 0, pos: 0, text, startLine: 1, endLine: 1, language: "en" },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
    return inserted.value.id;
  };
  const wiki = (ref: string, line: number) => ({
    targetRef: ref,
    targetRefNorm: ref,
    linkType: "wiki" as const,
    startLine: line,
    startCol: 1,
    endLine: line,
    endCol: ref.length + 4,
  });
  /** Hybrid "graphseed" query with the caller's full scope, graph on. */
  const graphQuery = async () => {
    const scope = await resolveMcpAccess(ctx());
    if (!scope?.check) throw new Error("expected a hook check");
    const result = await searchHybrid(
      {
        store,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "graphseed",
      {
        limit: 10,
        noExpand: true,
        noRerank: true,
        graph: true,
        collections: scope.collections,
        ...(await accessRetrievalOptions(scope, store)),
      }
    );
    if (!result.ok) throw new Error(result.error.message);
    return {
      uris: result.value.results.map((r) => r.uri),
      graph: result.value.meta.graphExpansion,
    };
  };

  test("a hook-denied note takes no link and changes no confidence", async () => {
    subject = { id: "u:b", context: "1to1", hash: "h" };
    const seed = await addNote(
      "gseed.md",
      "gseed",
      "web:ok-7",
      "graphseed note"
    );
    // [[gtarget]] matches gtarget.md by title; [[gpath]] gpath.md by path.
    await addNote("gtarget.md", "gtarget", "web:ok-8", "linked target");
    await addNote("gpath.md", "Path target", "web:ok-9", "linked by path");
    expect(
      (
        await store.setDocLinks(
          seed,
          [wiki("gtarget", 1), wiki("gpath", 2)],
          "parsed"
        )
      ).ok
    ).toBe(true);
    const before = await graphQuery();
    expect(before.graph).toMatchObject({
      enabled: true,
      candidateCount: 2,
      edgeConfidence: { explicit: 2, ambiguous: 0 },
    });
    expect(before.uris).toContain("gno://pub/gpath.md");

    // Valid provenance the hook denies: one ties gtarget, one outranks gpath.
    await addNote("gtwin.md", "gtarget", "sp:secret-3", "twin");
    await addNote("gother.md", "gpath", "sp:secret-4", "other");
    calls.length = 0;
    expect(await graphQuery()).toEqual(before);
    expect(
      calls.some((call) => call.refs.some((ref) => ref.ref === "secret-3"))
    ).toBe(true);
  });
});

describe("access hook and supersededBy", () => {
  const link = async (successor: string, predecessor: string) => {
    const from = await store.getDocumentByUri(successor);
    const to = await store.getDocumentByUri(predecessor);
    if (!(from.ok && from.value && to.ok && to.value)) {
      throw new Error("missing fixture document");
    }
    const edge = await store.setDocEdges(
      from.value.id,
      [
        {
          targetDocId: to.value.id,
          edgeType: "supersedes",
          confidence: "parsed",
        },
      ],
      "frontmatter-relation"
    );
    expect(edge.ok).toBe(true);
  };

  beforeAll(async () => {
    // closed.md (readable collection, hook-denied source) supersedes open.md;
    // x.md (hook-admitted collection, u:a only) supersedes f.md.
    await link("gno://pub/closed.md", "gno://pub/open.md");
    await link("gno://x/x.md", "gno://firm/f.md");
  });

  const getLink = async (ref: string) =>
    (
      (await handleGet({ ref }, ctx())).structuredContent as {
        supersededBy?: string;
      }
    ).supersededBy;

  test("gno_get names a successor only when the hook allows it", async () => {
    subject = { id: "u:a", context: "1to1", hash: "h" };
    expect(await getLink("gno://pub/open.md")).toBeUndefined();
    expect(await getLink("gno://firm/f.md")).toBe("gno://x/x.md");
    subject = { id: "u:b", context: "1to1", hash: "h" };
    expect(await getLink("gno://pub/open.md")).toBeUndefined();
    expect(await getLink("gno://firm/f.md")).toBeUndefined();
  });

  test("gno_multi_get and gno_search never name a hook-denied successor", async () => {
    subject = { id: "u:b", context: "1to1", hash: "h" };
    const multi = (
      await handleMultiGet(
        { refs: ["gno://pub/open.md", "gno://firm/f.md"] },
        ctx()
      )
    ).structuredContent as {
      documents: { uri: string; supersededBy?: string }[];
    };
    expect(multi.documents.map((d) => d.uri)).toEqual([
      "gno://pub/open.md",
      "gno://firm/f.md",
    ]);
    expect(multi.documents.some((d) => d.supersededBy)).toBe(false);
    const search = (await handleSearch({ query: "needle", limit: 20 }, ctx()))
      .structuredContent as {
      results: { uri: string; supersededBy?: string }[];
    };
    expect(search.results.some((r) => r.supersededBy)).toBe(false);
    expect(JSON.stringify(search)).not.toMatch(/closed\.md|x\/x\.md/);
    subject = { id: "u:a", context: "1to1", hash: "h" };
    const allowed = (await handleSearch({ query: "needle", limit: 20 }, ctx()))
      .structuredContent as {
      results: { uri: string; supersededBy?: string }[];
    };
    expect(
      Object.fromEntries(
        allowed.results
          .filter((r) => r.supersededBy)
          .map((r) => [r.uri, r.supersededBy])
      )
    ).toEqual({ "gno://firm/f.md": "gno://x/x.md" });
  });
});

describe("access hook calls for supersededBy", () => {
  /** A pub note (not matching "needle") whose one source is `source`. */
  const addNote = async (name: string, source: string): Promise<number> => {
    const text = `chain note ${name}`;
    const inserted = await store.upsertDocument({
      collection: "pub",
      relPath: `${name}.md`,
      sourceHash: `source-${name}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: name,
      mirrorHash: `mirror-${name}`,
      typedMetadata: { derived_from: [source] },
      ingestVersion: TYPED_METADATA_INGEST_VERSION,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await store.upsertContent(`mirror-${name}`, text)).ok).toBe(true);
    return inserted.value.id;
  };
  const supersede = async (successor: number, predecessor: number) => {
    const edge = await store.setDocEdges(
      successor,
      [
        {
          targetDocId: predecessor,
          edgeType: "supersedes",
          confidence: "parsed",
        },
      ],
      "frontmatter-relation"
    );
    expect(edge.ok).toBe(true);
  };

  beforeAll(async () => {
    // Three chains of one hop: c1 supersedes c0, each with its own source.
    for (const chain of ["a", "b", "c"]) {
      await supersede(
        await addNote(`${chain}1`, `web:ok-${chain}1`),
        await addNote(`${chain}0`, `web:ok-${chain}0`)
      );
    }
    // d0 <- d1 (hook-denied) <- d2.
    const d0 = await addNote("d0", "web:ok-d0");
    const d1 = await addNote("d1", "sp:deny-d1");
    await supersede(d1, d0);
    await supersede(await addNote("d2", "web:ok-d2"), d1);
  });

  /** Document sources the hook was asked about (not collection refs). */
  const refsAsked = () =>
    calls
      .flatMap((call) => call.refs.map((ref) => `${ref.sys}:${ref.ref}`))
      .filter((ref) => !ref.startsWith("sp:site-"));

  test("one hop asks the hook once for every chain's successor", async () => {
    subject = { id: "u:a", context: "1to1", hash: "h" };
    calls.length = 0;
    const multi = (
      await handleMultiGet(
        { refs: ["gno://pub/a0.md", "gno://pub/b0.md", "gno://pub/c0.md"] },
        ctx()
      )
    ).structuredContent as {
      documents: { uri: string; supersededBy?: string }[];
    };
    expect(multi.documents.map((d) => d.supersededBy)).toEqual([
      "gno://pub/a1.md",
      "gno://pub/b1.md",
      "gno://pub/c1.md",
    ]);
    // The scope's collection call, one per requested note, then one for all
    // three successors.
    expect(calls).toHaveLength(5);
    expect(calls.at(-1)?.refs.map((ref) => ref.ref)).toEqual([
      "ok-a1",
      "ok-b1",
      "ok-c1",
    ]);
  });

  test("nothing past a denied successor is asked about", async () => {
    subject = { id: "u:a", context: "1to1", hash: "h" };
    calls.length = 0;
    const result = await handleGet({ ref: "gno://pub/d0.md" }, ctx());
    expect(
      (result.structuredContent as { supersededBy?: string }).supersededBy
    ).toBeUndefined();
    expect(refsAsked()).toEqual(["web:ok-d0", "sp:deny-d1"]);
  });
});
