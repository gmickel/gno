/**
 * Policy lineage under collection access: a hidden collection that holds the
 * same bytes as a readable document is never named in a scoped result's
 * `egressLineage` (search, query, Context Capsule, recall). Unrestricted
 * callers still see every owner.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { EgressLineage } from "../../src/core/egress-provenance";
import type { RecallResult } from "../../src/core/memory";
import type {
  RequestPrincipal,
  RequestSubject,
  ToolContext,
} from "../../src/mcp/context";

import { createDefaultConfig } from "../../src/config/defaults";
import { createEgressLineage } from "../../src/core/egress-provenance";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import { mcpAccessScope, scopeRecallResult } from "../../src/mcp/tools/access";
import { handleContext } from "../../src/mcp/tools/context";
import { handleQuery } from "../../src/mcp/tools/query";
import { handleSearch } from "../../src/mcp/tools/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const SOURCES = { derived_from: ["sp:drives/d1/items/i1"] };

const collection = (
  name: string,
  access: Collection["access"],
  egressPolicy: Collection["egressPolicy"]
): Collection => ({
  name,
  path: `/tmp/${name}`,
  pattern: "**/*.md",
  include: [],
  exclude: [],
  access,
  egressPolicy,
});

const COLLECTIONS: Collection[] = [
  collection("pub", { public: true }, "remote"),
  collection(
    "secret",
    { accessRef: { sys: "sp", ref: "drives/x/root" } },
    "local_only"
  ),
];

/** `pub/shared.md` and `secret/shared.md` share one content hash. */
const DOCS: [path: string, text: string][] = [
  ["pub/shared.md", "needle shared bytes"],
  ["secret/shared.md", "needle shared bytes"],
  ["pub/own.md", "needle own bytes"],
];

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
    serverInstanceId: "access-egress-lineage-test",
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

type Lineaged = { uri: string; egressLineage?: EgressLineage };

/** Lineage source collections per result URI. */
const owners = (results: Lineaged[]): Record<string, string[]> =>
  Object.fromEntries(
    results.map((result) => [
      result.uri,
      (result.egressLineage?.sources ?? []).map((source) => source.collection),
    ])
  );

const SCOPED = {
  "gno://pub/own.md": ["pub"],
  "gno://pub/shared.md": ["pub"],
};
const UNRESTRICTED = {
  "gno://pub/own.md": ["pub"],
  "gno://pub/shared.md": ["pub", "secret"],
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "access-egress-lineage-"));
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect((await store.syncCollections(COLLECTIONS)).ok).toBe(true);
  for (const [path, text] of DOCS) {
    const [name, relPath] = path.split("/") as [string, string];
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

describe("scoped results never name a hidden co-owner", () => {
  test("gno_search", async () => {
    const read = async () => {
      const result = await handleSearch(
        { query: "needle", collection: "pub", limit: 20 },
        ctx()
      );
      expect(result.isError).toBeUndefined();
      return result;
    };
    asReader();
    const scoped = await read();
    expect(
      owners((scoped.structuredContent as { results: Lineaged[] }).results)
    ).toEqual(SCOPED);
    expect(JSON.stringify(scoped)).not.toContain("secret");
    asUnrestricted();
    expect(
      owners(
        ((await read()).structuredContent as { results: Lineaged[] }).results
      )
    ).toEqual(UNRESTRICTED);
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
      return result;
    };
    asReader();
    const scoped = await read();
    expect(
      owners((scoped.structuredContent as { results: Lineaged[] }).results)
    ).toEqual(SCOPED);
    expect(JSON.stringify(scoped)).not.toContain("secret");
    asUnrestricted();
    expect(
      owners(
        ((await read()).structuredContent as { results: Lineaged[] }).results
      )
    ).toEqual(UNRESTRICTED);
  });

  test("gno_context", async () => {
    const build = async () => {
      const result = await handleContext(
        {
          goal: "needle shared bytes",
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
      return result.structuredContent as {
        egressLineage: EgressLineage;
        evidence: { egressLineage: EgressLineage }[];
      };
    };
    const collectionsOf = (lineage: EgressLineage) =>
      lineage.sources.map((source) => source.collection);
    asReader();
    const scoped = await build();
    expect(collectionsOf(scoped.egressLineage)).toEqual(["pub"]);
    for (const item of scoped.evidence) {
      expect(collectionsOf(item.egressLineage)).toEqual(["pub"]);
    }
    expect(JSON.stringify(scoped)).not.toContain("secret");
    asUnrestricted();
    expect(collectionsOf((await build()).egressLineage)).toEqual([
      "pub",
      "secret",
    ]);
  });

  test("gno_recall projection", () => {
    const shared = createEgressLineage([
      { collection: "pub", policy: "remote", source: "explicit" },
      { collection: "secret", policy: "local_only", source: "explicit" },
    ]);
    const fact = { egressLineage: shared } as RecallResult["facts"][number];
    const recall = {
      facts: [fact],
      egressLineage: shared,
    } as RecallResult;
    asReader();
    const scope = mcpAccessScope(ctx());
    if (!scope) throw new Error("expected an access scope");
    const scoped = scopeRecallResult(scope, recall);
    expect(JSON.stringify(scoped)).not.toContain("secret");
    expect(scoped.egressLineage).toEqual(
      createEgressLineage([
        { collection: "pub", policy: "remote", source: "explicit" },
      ])
    );
    // The caller-visible copy never rewrites the complete lineage.
    expect(recall.egressLineage).toBe(shared);
  });
});
