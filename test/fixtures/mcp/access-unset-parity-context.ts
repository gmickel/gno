/**
 * Corpus and tool calls for the access-unset parity golden
 * (test/mcp/access-unset-parity.test.ts, test/fixtures/mcp/access-unset-parity.json).
 *
 * The corpus exercises everything collection access changes when it is on:
 * supersession chains (including cycles, a chain through a collection with
 * an access rule, and a chain longer than the scoped hop limit), notes
 * without `derived_from` or with invalid metadata, content shared across
 * collections, and a graph link. The calls read it through every scoped
 * tool with no principal. Only APIs that upstream GNO also has are used, so
 * the same capture runs unchanged against an upstream checkout; the golden
 * is that upstream capture.
 */

// Bun has no directory-creation or path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../../src/config/types";
import type { ToolContext } from "../../../src/mcp/context";
import type { DocumentInput } from "../../../src/store/types";

import { createDefaultConfig } from "../../../src/config/defaults";
import { TYPED_METADATA_INGEST_VERSION } from "../../../src/core/typed-metadata";
import { handleGet } from "../../../src/mcp/tools/get";
import { handleMultiGet } from "../../../src/mcp/tools/multi-get";
import { handleQuery } from "../../../src/mcp/tools/query";
import { handleSearch } from "../../../src/mcp/tools/search";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

const SOURCES = { derived_from: ["sp:drives/d1/items/i1"] };
/** Hops in the long chain: more than a scoped walk resolves. */
const LONG_CHAIN = 34;

const collection = (name: string, access: unknown): Collection =>
  ({
    name,
    path: `/tmp/${name}`,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    access,
  }) as Collection;

/** Access rules are configured, but no request names a principal. */
const COLLECTIONS: Collection[] = [
  collection("pub", { public: true }),
  collection("secret", { accessRef: { sys: "sp", ref: "drives/x/root" } }),
];

const longChain = Array.from(
  { length: LONG_CHAIN + 1 },
  (_, index) => `pub/long-${index}.md`
);

interface Note {
  path: string;
  text?: string;
  fields?: Partial<DocumentInput>;
}

const NOTES: Note[] = [
  { path: "pub/old.md" },
  { path: "secret/new.md" },
  { path: "pub/chain-a.md" },
  { path: "pub/chain-b.md" },
  { path: "secret/chain-c.md" },
  { path: "pub/self.md" },
  { path: "pub/two-a.md" },
  { path: "pub/two-b.md" },
  { path: "pub/tail-a.md" },
  { path: "pub/tail-b.md" },
  { path: "pub/tail-c.md" },
  ...longChain.map((path) => ({ path, text: `long chain note ${path}` })),
  {
    path: "pub/pending.md",
    fields: { typedMetadata: undefined, ingestVersion: undefined },
  },
  {
    path: "pub/broken.md",
    fields: { typedMetadata: undefined, metadataError: "invalid gno.metadata" },
  },
  { path: "pub/shared.md", text: "shared needle note" },
  { path: "secret/shared.md", text: "shared needle note" },
  { path: "pub/target.md", text: "linked target note", fields: {} },
];

/** successor -> the notes it supersedes. */
const SUPERSEDES: Record<string, string[]> = {
  "secret/new.md": ["pub/old.md"],
  "pub/chain-b.md": ["pub/chain-a.md"],
  "secret/chain-c.md": ["pub/chain-b.md"],
  "pub/self.md": ["pub/self.md"],
  "pub/two-a.md": ["pub/two-b.md"],
  "pub/two-b.md": ["pub/two-a.md"],
  "pub/tail-b.md": ["pub/tail-a.md", "pub/tail-c.md"],
  "pub/tail-c.md": ["pub/tail-b.md"],
  ...Object.fromEntries(
    longChain.slice(1).map((path, index) => [path, [longChain[index]]])
  ),
};

const buildCorpus = async (store: SqliteAdapter): Promise<void> => {
  const check = (result: { ok: boolean }, what: string) => {
    if (!result.ok) throw new Error(`fixture: ${what} failed`);
  };
  check(await store.syncCollections(COLLECTIONS), "syncCollections");
  const ids = new Map<string, number>();
  for (const note of NOTES) {
    const [name, relPath] = note.path.split("/") as [string, string];
    const text = note.text ?? `needle note ${note.path}`;
    const mirrorHash = new Bun.CryptoHasher("sha256")
      .update(text)
      .digest("hex");
    const inserted = await store.upsertDocument({
      collection: name,
      relPath,
      sourceHash: new Bun.CryptoHasher("sha256")
        .update(note.path)
        .digest("hex"),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: relPath.replace(/\.md$/, ""),
      mirrorHash,
      typedMetadata: SOURCES,
      ingestVersion: TYPED_METADATA_INGEST_VERSION,
      ...note.fields,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    ids.set(note.path, inserted.value.id);
    check(await store.upsertContent(mirrorHash, text), "upsertContent");
    const chunk = { seq: 0, pos: 0, text, startLine: 1, endLine: 1 };
    check(
      await store.upsertChunks(mirrorHash, [{ ...chunk, language: "en" }]),
      "upsertChunks"
    );
    check(await store.rebuildFtsForHash(mirrorHash), "rebuildFtsForHash");
  }
  for (const [successor, predecessors] of Object.entries(SUPERSEDES)) {
    check(
      await store.setDocEdges(
        ids.get(successor) as number,
        predecessors.map((predecessor) => ({
          targetDocId: ids.get(predecessor) as number,
          edgeType: "supersedes" as const,
          confidence: "parsed" as const,
        })),
        "frontmatter-relation"
      ),
      "setDocEdges"
    );
  }
  check(
    await store.setDocLinks(
      ids.get("pub/old.md") as number,
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
    ),
    "setDocLinks"
  );
};

const NEEDLE_FILTER = {
  op: "exists" as const,
  key: "derived_from",
  value: true,
};

/**
 * Serialized tool results (`ToolResult` as JSON) for every call, keyed by a
 * stable call name, with no request principal.
 */
export const captureUnsetAccessResponses = async (): Promise<
  Record<string, string>
> => {
  const directory = await mkdtemp(join(tmpdir(), "access-unset-parity-"));
  const store = new SqliteAdapter();
  try {
    const opened = await store.open(
      join(directory, "index-default.sqlite"),
      "unicode61"
    );
    if (!opened.ok) throw new Error(opened.error.message);
    await buildCorpus(store);
    const ctx = {
      store,
      config: { ...createDefaultConfig(), collections: COLLECTIONS },
      collections: COLLECTIONS,
      actualConfigPath: join(directory, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: () => Promise.resolve(() => undefined) },
      jobManager: {},
      serverInstanceId: "access-unset-parity",
      writeLockPath: join(directory, ".write.lock"),
      enableWrite: false,
      isShuttingDown: () => false,
      getModelAdapter: () => {
        const unavailable = async () => ({
          ok: false,
          error: { code: "MODEL_NOT_FOUND", message: "no models" },
        });
        return {
          createEmbeddingPort: unavailable,
          createExpansionPort: unavailable,
          createRerankPort: unavailable,
          createGenerationPort: unavailable,
        };
      },
    } as unknown as ToolContext;
    const calls: Record<string, () => Promise<unknown>> = {
      ...Object.fromEntries(
        NOTES.filter((note) => !longChain.slice(1).includes(note.path)).map(
          (note) => [
            `get ${note.path}`,
            () => handleGet({ ref: `gno://${note.path}` }, ctx),
          ]
        )
      ),
      "multi_get pattern": () =>
        handleMultiGet({ pattern: "gno://pub/*", maxBytes: 64 }, ctx),
      "multi_get refs": () =>
        handleMultiGet(
          {
            refs: [
              "gno://pub/tail-a.md",
              "gno://pub/old.md",
              "gno://secret/new.md",
              "gno://pub/missing.md",
              "gno://pub/long-0.md",
            ],
          },
          ctx
        ),
      search: () => handleSearch({ query: "needle", limit: 20 }, ctx),
      "search filter": () =>
        handleSearch(
          { query: "needle", limit: 20, filter: NEEDLE_FILTER },
          ctx
        ),
      "search collection": () =>
        handleSearch({ query: "needle", collection: "pub", limit: 20 }, ctx),
      query: () =>
        handleQuery(
          {
            query: "needle",
            limit: 20,
            graph: true,
            expand: false,
            rerank: false,
          },
          ctx
        ),
      "query filter": () =>
        handleQuery(
          { query: "needle", limit: 20, fast: true, filter: NEEDLE_FILTER },
          ctx
        ),
    };
    const responses: Record<string, string> = {};
    for (const [name, call] of Object.entries(calls)) {
      responses[name] = JSON.stringify(await call());
    }
    return responses;
  } finally {
    await store.close();
    await safeRm(directory);
  }
};
