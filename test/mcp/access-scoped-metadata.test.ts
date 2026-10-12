/**
 * Scoped response metadata counts only readable documents: adding documents
 * the caller may not read leaves every scoped response byte-identical, while
 * an unrestricted caller sees them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import type { DocumentInput } from "../../src/store/types";

import { createDefaultConfig } from "../../src/config/defaults";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import { handleContext } from "../../src/mcp/tools/context";
import { handleQuery } from "../../src/mcp/tools/query";
import { handleSearch } from "../../src/mcp/tools/search";
import { expandGraphCandidates } from "../../src/pipeline/graph-retrieval";
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

let store: SqliteAdapter;
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
    serverInstanceId: "access-scoped-metadata-test",
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

/** Index one note (`collection/relPath`); by default its text matches "needle". */
const addNote = async (
  path: string,
  fields: Partial<DocumentInput> = {},
  text = `needle note ${path}`
): Promise<number> => {
  const [name, relPath] = path.split("/") as [string, string];
  const mirrorHash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const inserted = await store.upsertDocument({
    collection: name,
    relPath,
    sourceHash: mirrorHash,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: text.length,
    sourceMtime: "2026-10-01T00:00:00.000Z",
    title: relPath.replace(/\.md$/, ""),
    mirrorHash,
    typedMetadata: SOURCES,
    ingestVersion: TYPED_METADATA_INGEST_VERSION,
    ...fields,
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

/** Notes the reader may not read: coverage would count the first two. */
const addHiddenNotes = async (): Promise<void> => {
  // No typed metadata yet: pending re-ingestion, and no `derived_from`.
  await addNote("pub/pending.md", {
    typedMetadata: undefined,
    ingestVersion: undefined,
  });
  await addNote("pub/broken.md", {
    typedMetadata: undefined,
    metadataError: "invalid gno.metadata",
  });
  await addNote("secret/hidden.md");
};

const serialized = async (
  run: () => Promise<{ isError?: boolean }>
): Promise<string> => {
  const result = await run();
  expect(result.isError).toBeUndefined();
  return JSON.stringify(result);
};

const search = () =>
  serialized(() =>
    handleSearch(
      {
        query: "needle",
        limit: 20,
        filter: { op: "exists", key: "derived_from", value: true },
      },
      ctx()
    )
  );
/** Hybrid query with graph expansion on and no models. */
const graphQuery = () =>
  serialized(() =>
    handleQuery(
      { query: "needle", limit: 20, graph: true, expand: false, rerank: false },
      ctx()
    )
  );
/** Context Capsule over "pub" with graph expansion on and no models. */
const capsule = () =>
  serialized(() =>
    handleContext(
      {
        goal: "needle note",
        query: "needle",
        collections: ["pub"],
        limit: 8,
        budgetTokens: 100_000,
        budgetBytes: 100_000,
        depthPolicy: "balanced",
        graph: true,
        noRerank: true,
      },
      ctx()
    )
  );
const query = () =>
  serialized(() =>
    handleQuery({ query: "needle", limit: 20, fast: true }, ctx())
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "access-scoped-metadata-"));
  store = new SqliteAdapter();
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(COLLECTIONS)).ok).toBe(true);
  await addNote("pub/a.md");
  await addNote("pub/b.md");
});

afterEach(async () => {
  await store.close();
  await safeRm(directory);
});

describe("metadata coverage warnings", () => {
  test("hidden notes leave scoped search and query byte-identical", async () => {
    asReader();
    const before = [await search(), await query()];
    await addHiddenNotes();
    expect([await search(), await query()]).toEqual(before);
    expect(before.join("")).not.toContain("METADATA_COVERAGE");
  });

  test("an unrestricted caller still gets the coverage warning", async () => {
    await addHiddenNotes();
    asUnrestricted();
    expect(await search()).toContain("METADATA_COVERAGE_INCOMPLETE");
  });
});

describe("graph expansion metadata", () => {
  /** pub/a.md links to [[target]]; whether that resolves is the variable. */
  const linkToTarget = async (): Promise<void> => {
    const source = await store.getDocumentByUri("gno://pub/a.md");
    if (!source.ok || !source.value) throw new Error("seed note missing");
    const linked = await store.setDocLinks(
      source.value.id,
      [
        {
          targetRef: "target",
          targetRefNorm: "target",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 11,
        },
      ],
      "parsed"
    );
    expect(linked.ok).toBe(true);
  };
  /** The link target: no `derived_from`, and no "needle" so it is no seed. */
  const addTarget = () =>
    addNote("pub/target.md", { typedMetadata: {} }, "linked target note");
  const graphMeta = (serializedResult: string) =>
    (
      JSON.parse(serializedResult) as {
        structuredContent: { meta: { graphExpansion: unknown } };
      }
    ).structuredContent.meta.graphExpansion;

  test("an edge to an unreadable note reads exactly like no edge", async () => {
    await linkToTarget();
    asReader();
    const noEdge = await graphQuery();
    // The link now resolves to a note the reader may not read.
    await addTarget();
    expect(await graphQuery()).toBe(noEdge);
    expect(graphMeta(noEdge)).toMatchObject({
      enabled: false,
      edgeConfidence: { explicit: 0, inferred: 0, ambiguous: 0 },
      fallbackReasons: ["graph_no_new_candidates"],
    });
  });

  test("an unrestricted caller still follows the edge", async () => {
    await linkToTarget();
    await addTarget();
    asUnrestricted();
    expect(graphMeta(await graphQuery())).toMatchObject({
      enabled: true,
      candidateCount: 1,
    });
  });

  test("a hidden note named like a link target leaves the edge unchanged", async () => {
    await linkToTarget();
    await addNote("pub/target.md", {}, "linked target note");
    asReader();
    const before = await graphQuery();
    expect(graphMeta(before)).toMatchObject({
      enabled: true,
      candidateCount: 1,
      edgeConfidence: { explicit: 1, ambiguous: 0 },
    });
    // Same title, no `derived_from`: unreadable, and no longer a tie.
    await addNote(
      "pub/twin.md",
      { title: "target", typedMetadata: {} },
      "twin note"
    );
    expect(await graphQuery()).toBe(before);
    asUnrestricted();
    expect(graphMeta(await graphQuery())).toMatchObject({
      edgeConfidence: { explicit: 0, ambiguous: 1 },
    });
  });

  test("a hidden note that outranks a link target does not take the link", async () => {
    await linkToTarget();
    // Matches [[target]] by path only.
    await addNote("pub/target.md", { title: "Target note" }, "linked note");
    asReader();
    const before = await graphQuery();
    expect(graphMeta(before)).toMatchObject({
      enabled: true,
      candidateCount: 1,
    });
    expect(await capsule()).toContain("gno://pub/target.md");
    // An exact title match wins resolution over a path match.
    await addNote(
      "pub/other.md",
      { title: "target", typedMetadata: {} },
      "other note"
    );
    expect(await graphQuery()).toBe(before);
    expect(await capsule()).toContain("gno://pub/target.md");
  });

  test("a hidden note sharing a seed's content does not take its place", async () => {
    const text = "shared needle note";
    // The hidden copy comes first, so it would win the seed slot.
    await addNote("secret/shared.md", {}, text);
    const shared = await addNote("pub/shared.md", {}, text);
    await addNote("pub/neighbour.md", {}, "neighbour note");
    expect(
      (
        await store.setDocLinks(
          shared,
          [
            {
              targetRef: "neighbour",
              targetRefNorm: "neighbour",
              linkType: "wiki",
              startLine: 1,
              startCol: 1,
              endLine: 1,
              endCol: 14,
            },
          ],
          "parsed"
        )
      ).ok
    ).toBe(true);
    const mirrorHash = new Bun.CryptoHasher("sha256")
      .update(text)
      .digest("hex");
    // A vector hit names content, not a document.
    const seed = {
      mirrorHash,
      seq: 0,
      bm25Rank: null,
      vecRank: 1,
      fusionScore: 1,
      sources: ["vector" as const],
    };
    const expand = (accessScoped?: boolean) =>
      expandGraphCandidates(store, [seed], {
        collections: ["pub"],
        accessScoped,
      });
    expect((await expand(true)).meta).toMatchObject({
      seedCount: 1,
      candidateCount: 1,
    });
    // Unscoped expansion is unchanged: the first copy seeds.
    expect((await expand()).meta.candidateCount).toBe(0);
  });
});
