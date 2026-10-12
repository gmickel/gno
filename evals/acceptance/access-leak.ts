/**
 * Offline access-hook leak gate. Pinned fixture, exhaustive oracle,
 * fake hook on a unix socket, SQLite + sqlite-vec with fixed vectors.
 *
 * For every subject x collection x provenance kind at each corpus size it
 * requires: search results equal the oracle's allowed set; no denied
 * document's marker in any result, snippet, count, capsule, `supersededBy`
 * link or error; nothing denied reaches the reranker or graph expansion;
 * denied and missing refs give byte-identical NOT_FOUND. `--negative-control`
 * drops the per-document hook check, which must fail the gate (exit 1).
 */
import { Database } from "bun:sqlite";
// Bun has no temporary-directory creation/path/recursive-directory-removal APIs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { AccessHookRequest } from "../../src/core/access-hook";
import type { TypedMetadata } from "../../src/core/typed-metadata";
import type { EmbeddingPort, RerankPort } from "../../src/llm/types";
import type { ToolContext } from "../../src/mcp/context";
import type { StoreResult } from "../../src/store/types";

import { CollectionSchema } from "../../src/config/types";
import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import {
  resolveMcpAccess,
  supersessionScope,
} from "../../src/mcp/tools/access";
import { handleContext } from "../../src/mcp/tools/context";
import { handleGet } from "../../src/mcp/tools/get";
import { handleMultiGet } from "../../src/mcp/tools/multi-get";
import { handleSearch } from "../../src/mcp/tools/search";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";

function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const hash = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const fixtureText = await Bun.file(
  new URL("../fixtures/access-leak/cases.json", import.meta.url)
).text();
const manifest = await Bun.file(
  new URL("../fixtures/access-leak/manifest.json", import.meta.url)
).json();
if (hash(fixtureText) !== manifest.sha256)
  throw new Error("Fixture pin mismatch");
type Context = "1to1" | "shared" | "public_only";
const fixture = JSON.parse(fixtureText) as {
  sizes: number[];
  limit: number;
  query: string;
  getSample: number;
  collections: { name: string; access: Collection["access"] }[];
  kinds: { name: string; refs: string[] | null }[];
  grants: Record<string, string[]>;
  failingSubject: string;
  subjects: { id: string; context: Context }[];
};
const negativeControl = Bun.argv.includes("--negative-control");
const outputFlag = Bun.argv.indexOf("--output");
if (outputFlag < 0 || !Bun.argv[outputFlag + 1])
  throw new Error("Use --output <new-report.json> [--negative-control]");
const outputPath = Bun.argv[outputFlag + 1]!;
if (await Bun.file(outputPath).exists())
  throw new Error("Refusing to overwrite report");

const collections: Collection[] = fixture.collections.map((c) =>
  CollectionSchema.parse({
    name: c.name,
    path: `/tmp/${c.name}`,
    access: c.access,
  })
);
const failures: string[] = [];
const measurements: unknown[] = [];
const fail = (label: string) => {
  if (failures.length < 500) failures.push(label);
};
const MARKER = /tok\d{6}/g;
const marker = (index: number) => `tok${String(index).padStart(6, "0")}`;

// ── Fake hook: grants by subject prefix; the failing subject gets HTTP 500.
const directory = await mkdtemp(join(tmpdir(), "gno-leak-"));
const socket = join(directory, "hook.sock");
let hookCalls = 0;
const granted = (subject: string, member: string) =>
  (fixture.grants[subject] ?? []).some((prefix) => member.startsWith(prefix));
const hookServer = Bun.serve({
  unix: socket,
  async fetch(request) {
    hookCalls += 1;
    const body = (await request.json()) as AccessHookRequest;
    if (body.subject === fixture.failingSubject)
      return new Response("down", { status: 500 });
    return Response.json({
      allow: body.refs.flatMap((ref, index) =>
        granted(body.subject, `${ref.sys}:${ref.ref}`) ? [index] : []
      ),
    });
  },
});

interface Doc {
  index: number;
  collection: string;
  relPath: string;
  metadata?: TypedMetadata;
  refs: string[] | null;
  validKey: boolean;
}

function makeDoc(index: number): Doc {
  const kind = fixture.kinds[index % fixture.kinds.length]!;
  const collection =
    collections[Math.floor(index / fixture.kinds.length) % collections.length]!;
  const key =
    collection.access && "provenanceKey" in collection.access
      ? (collection.access.provenanceKey ?? "derived_from")
      : "derived_from";
  const refs =
    kind.refs?.map((ref) => ref.replace("{i}", String(index))) ?? null;
  // In a keyed collection, odd documents use the wrong key (not servable).
  const useKey =
    key !== "derived_from" && index % 2 === 1 ? "derived_from" : key;
  return {
    index,
    collection: collection.name,
    // The marker in the path makes any URI (such as `supersededBy`) checkable.
    relPath: `${marker(index)}.md`,
    metadata: refs ? { [useKey]: refs } : undefined,
    refs,
    validKey: useKey === key,
  };
}

/** Collection-level oracle: static rule, or the hook for an accessRef. */
function collectionReadable(
  name: string,
  subject: { id: string; context: Context }
): boolean {
  const access = collections.find((c) => c.name === name)!.access!;
  if ("public" in access) return true;
  if ("owner" in access)
    return subject.context === "1to1" && subject.id === access.owner;
  const eligible =
    subject.context === "1to1" ||
    (subject.context === "shared" && access.firmwide === true);
  return (
    eligible &&
    granted(subject.id, `${access.accessRef.sys}:${access.accessRef.ref}`)
  );
}

/** Exhaustive oracle: may this subject read this document? */
function oracle(doc: Doc, subject: { id: string; context: Context }): boolean {
  if (!collectionReadable(doc.collection, subject)) return false;
  if (!doc.validKey || !doc.refs) return false;
  const shaped = doc.refs.every((ref) => /^[a-z][a-z0-9_-]*:\S/.test(ref));
  return shaped && doc.refs.every((ref) => granted(subject.id, ref));
}

const markersIn = (value: unknown): string[] =>
  JSON.stringify(value).match(MARKER) ?? [];

try {
  for (const count of fixture.sizes) {
    const dir = await mkdtemp(join(directory, `n${count}-`));
    const store = new SqliteAdapter();
    let db: Database | undefined;
    try {
      const path = join(dir, "index.sqlite");
      unwrap(await store.open(path, "unicode61"));
      unwrap(await store.syncCollections(collections));
      db = new Database(path);
      const vectorIndex = unwrap(
        await createVectorIndexPort(db, {
          model: "leak-fixed-v1",
          dimensions: 2,
        })
      );
      if (!vectorIndex.searchAvailable)
        throw new Error("Real sqlite-vec is required for this gate");
      const docs: Doc[] = [];
      const ids: number[] = [];
      const setupStarted = performance.now();
      for (let index = 0; index < count; index++) {
        const doc = makeDoc(index);
        const text = `needle evidence ${marker(index)}`;
        const mirrorHash = hash(text);
        const inserted = unwrap(
          await store.upsertDocument({
            collection: doc.collection,
            relPath: doc.relPath,
            sourceHash: mirrorHash,
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: text.length,
            sourceMtime: "2026-10-01T00:00:00Z",
            title: marker(index),
            mirrorHash,
            typedMetadata: doc.metadata,
            ingestVersion: TYPED_METADATA_INGEST_VERSION,
          })
        );
        unwrap(await store.upsertContent(mirrorHash, text));
        unwrap(
          await store.upsertChunks(mirrorHash, [
            { seq: 0, pos: 0, text, startLine: 1, endLine: 1, language: "en" },
          ])
        );
        unwrap(await store.rebuildFtsForHash(mirrorHash));
        unwrap(
          await vectorIndex.upsertVectors([
            {
              mirrorHash,
              seq: 0,
              model: vectorIndex.model,
              embedFingerprint: "fixed-v1",
              embedding: new Float32Array([1 - index / count, index / count]),
            },
          ])
        );
        docs.push(doc);
        ids.push(inserted.id);
      }
      // Each document links to the next, so graph expansion would pull
      // denied neighbours of allowed seeds.
      for (let index = 0; index < count; index++) {
        const next = docs[(index + 1) % count]!;
        unwrap(
          await store.setDocLinks(
            ids[index]!,
            [
              {
                targetRef: next.relPath,
                targetRefNorm: next.relPath,
                targetCollection: next.collection,
                linkType: "markdown",
                startLine: 1,
                startCol: 1,
                endLine: 1,
                endCol: 2,
              },
            ],
            "parsed"
          )
        );
      }
      // In each run of three, the second supersedes the first and the third
      // the second, so a `supersededBy` link can name a denied document or
      // bridge a chain through one.
      for (let index = 0; index + 1 < count; index++) {
        if (index % 3 === 2) continue;
        unwrap(
          await store.setDocEdges(
            ids[index + 1]!,
            [
              {
                targetDocId: ids[index]!,
                edgeType: "supersedes",
                confidence: "parsed",
              },
            ],
            "frontmatter-relation"
          )
        );
      }
      const setupMs = performance.now() - setupStarted;
      const embedPort: EmbeddingPort = {
        modelUri: "fixed",
        dimensions: () => 2,
        init: async () => ({ ok: true, value: undefined }),
        dispose: async () => {},
        embed: async () => ({ ok: true, value: [1, 0] }),
        embedBatch: async (texts) => ({
          ok: true,
          value: texts.map(() => [1, 0]),
        }),
      };
      const perSubject: unknown[] = [];
      for (const subject of fixture.subjects) {
        const label = `${count}:${subject.id}:${subject.context}`;
        const allowed = new Set(
          docs
            .filter((doc) => oracle(doc, subject))
            .map((doc) => marker(doc.index))
        );
        const ctx = {
          store,
          config: {
            version: "1.0",
            collections,
            gateway: {
              accessHook: {
                url: "http://hook/check",
                unix: socket,
                timeoutMs: 2000,
              },
            },
          } as unknown as Config,
          collections,
          actualConfigPath: join(dir, "config.yml"),
          indexName: "default",
          toolMutex: { acquire: () => Promise.resolve(() => undefined) },
          jobManager: {},
          serverInstanceId: "access-leak-eval",
          writeLockPath: join(dir, ".write.lock"),
          enableWrite: false,
          isShuttingDown: () => false,
          getRequestPrincipal: () => ({
            name: "assistant",
            admin: false,
            mayAssertSubject: true,
          }),
          getRequestSubject: () => ({
            id: subject.id,
            context: subject.context,
            hash: "h",
          }),
        } as unknown as ToolContext;
        const leaks = (value: unknown, where: string) => {
          for (const found of markersIn(value))
            if (!allowed.has(found)) {
              fail(`leak:${where}:${label}:${found}`);
              return;
            }
        };
        const callsBefore = hookCalls;
        const started = performance.now();

        // 1. Search (BM25), exhaustive: exactly the allowed set.
        const search = await handleSearch(
          { query: fixture.query, limit: count },
          ctx
        );
        const searchData = search.structuredContent as {
          results?: { title?: string }[];
          meta?: { totalResults: number };
        };
        const got = new Set(
          (searchData.results ?? []).map((r) => r.title ?? "")
        );
        if (got.size !== allowed.size || [...got].some((m) => !allowed.has(m)))
          fail(`search-set:${label}:${got.size}/${allowed.size}`);
        if ((searchData.meta?.totalResults ?? 0) !== allowed.size)
          fail(`search-count:${label}`);
        leaks(search, "search");

        // 2. Hybrid with graph and a spy reranker: nothing denied reaches
        //    the model, the graph, the results or the counts.
        const scope = await resolveMcpAccess(ctx);
        if (!scope) throw new Error("expected access mode");
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
                score: 1 - index / 1000,
                rank: index + 1,
              })),
            };
          },
        };
        const hybrid = await searchHybrid(
          {
            store,
            config: { collections } as Config,
            vectorIndex,
            embedPort,
            expandPort: null,
            rerankPort,
          },
          fixture.query,
          {
            limit: fixture.limit,
            noExpand: true,
            collections: scope.collections,
            ...(negativeControl
              ? {}
              : {
                  ...(scope.check ? { access: scope.check } : {}),
                  supersession: supersessionScope(scope, store),
                }),
          }
        );
        if (!hybrid.ok) fail(`hybrid-error:${label}`);
        else {
          leaks(hybrid.value.results, "hybrid-results");
          leaks(hybrid.value.meta, "hybrid-meta");
          if (hybrid.value.meta.totalResults > allowed.size)
            fail(`hybrid-count:${label}`);
          if (allowed.size > 0 && hybrid.value.results.length === 0)
            fail(`hybrid-empty:${label}`);
        }
        leaks(reranked, "rerank");

        // 3. get: denied and missing are byte-identical NOT_FOUND.
        const missing = JSON.stringify(
          await handleGet({ ref: "gno://pub/none.md" }, ctx)
        );
        const deniedDocs = docs
          .filter((doc) => !allowed.has(marker(doc.index)))
          .slice(0, fixture.getSample);
        for (const doc of deniedDocs) {
          const result = JSON.stringify(
            await handleGet(
              { ref: `gno://${doc.collection}/${doc.relPath}` },
              ctx
            )
          );
          if (result !== missing)
            fail(`get-not-found:${label}:${marker(doc.index)}`);
        }
        for (const doc of docs
          .filter((d) => allowed.has(marker(d.index)))
          .slice(0, 5)) {
          const result = await handleGet(
            { ref: `gno://${doc.collection}/${doc.relPath}` },
            ctx
          );
          if (result.isError) fail(`get-allowed:${label}:${marker(doc.index)}`);
        }

        // 4. multi_get pattern: only allowed documents, no skipped names.
        const multi = await handleMultiGet({ pattern: "gno://*" }, ctx);
        leaks(multi, "multi_get");

        // 5. Errors: an unreadable collection fails exactly like a missing one.
        const deniedCollection = collections.find(
          (c) => !collectionReadable(c.name, subject)
        );
        if (deniedCollection) {
          const a = JSON.stringify(
            await handleSearch(
              { query: fixture.query, collection: deniedCollection.name },
              ctx
            )
          );
          const b = JSON.stringify(
            await handleSearch(
              { query: fixture.query, collection: "nowhere" },
              ctx
            )
          );
          if (a !== b)
            fail(`error-identical:${label}:${deniedCollection.name}`);
        }

        // 6. Capsule (fast, no models): built only from allowed evidence.
        const capsule = await handleContext(
          {
            goal: fixture.query,
            query: fixture.query,
            limit: fixture.limit,
            candidateLimit: fixture.limit * 2,
            budgetTokens: 100_000,
            budgetBytes: 100_000,
            safetyMarginTokens: 100,
            safetyMarginBytes: 100,
            depthPolicy: "fast",
          },
          ctx
        );
        leaks(capsule, "capsule");

        perSubject.push({
          subject: subject.id,
          context: subject.context,
          allowed: allowed.size,
          searchResults: got.size,
          hybridResults: hybrid.ok ? hybrid.value.results.length : null,
          rerankInputs: reranked.length,
          graphCandidates: hybrid.ok
            ? hybrid.value.meta.graphExpansion?.candidateCount
            : null,
          hookCalls: hookCalls - callsBefore,
          elapsedMs: performance.now() - started,
        });
      }
      measurements.push({ count, setupMs, subjects: perSubject });
    } finally {
      db?.close();
      await store.close();
    }
  }
} finally {
  await hookServer.stop(true);
  await rm(directory, { recursive: true, force: true });
}

await Bun.write(
  outputPath,
  JSON.stringify(
    {
      kind: "deterministic-access-leak",
      passed: failures.length === 0,
      negativeControl,
      fixtureSha256: manifest.sha256,
      harnessSha256: hash(await Bun.file(import.meta.path).text()),
      runtime: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      failures,
      measurements,
      notes: [
        "The hook is a local fake on a unix socket; no real identity system is involved.",
        "get NOT_FOUND parity is checked on up to getSample denied documents per subject.",
      ],
    },
    null,
    2
  )
);
console.log(
  `${failures.length === 0 ? "PASS" : "FAIL"} access-leak (${failures.length} failures${negativeControl ? ", negative control" : ""}) -> ${outputPath}`
);
process.exitCode = failures.length ? 1 : 0;
