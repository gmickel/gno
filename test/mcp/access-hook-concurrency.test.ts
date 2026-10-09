import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { AccessHookRequest } from "../../src/core/access-hook";
import type { ToolContext } from "../../src/mcp/context";

import { TYPED_METADATA_INGEST_VERSION } from "../../src/core/typed-metadata";
import { Mutex } from "../../src/mcp/context";
import { handleSearch } from "../../src/mcp/tools/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const HOOK_DELAY_MS = 150;
const USERS = 8;

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
  collection("x", { accessRef: { sys: "sp", ref: "site-x" } }),
];

const DOCS = [
  { collection: "pub", relPath: "open.md", sources: ["web:ok-1"] },
  { collection: "pub", relPath: "closed.md", sources: ["sp:secret-1"] },
  { collection: "x", relPath: "x.md", sources: ["web:ok-2"] },
];

const store = new SqliteAdapter();
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let inFlight = 0;
let maxInFlight = 0;

/** `web:ok-*` for everyone, `sp:site-x` only for even users; u:down gets 500. */
const allowed = (subject: string, member: string): boolean =>
  member.startsWith("web:ok-") ||
  (member === "sp:site-x" && Number(subject.slice(3)) % 2 === 0);

/** One request context per caller, sharing the process-wide tool mutex. */
const contextFor = (
  mutex: Mutex,
  subject: string,
  hook: Record<string, unknown> = {}
): ToolContext =>
  ({
    store,
    config: {
      version: "1.0",
      collections: COLLECTIONS,
      gateway: {
        accessHook: {
          url: "http://hook/check",
          unix: join(directory, "hook.sock"),
          timeoutMs: 1000,
          ...hook,
        },
      },
    } as unknown as Config,
    collections: COLLECTIONS,
    actualConfigPath: join(directory, "config.yml"),
    indexName: "default",
    toolMutex: mutex,
    jobManager: {},
    serverInstanceId: "access-hook-concurrency-test",
    writeLockPath: join(directory, ".write.lock"),
    enableWrite: false,
    isShuttingDown: () => false,
    getRequestPrincipal: () => ({
      name: "assistant",
      admin: false,
      mayAssertSubject: true,
    }),
    getRequestSubject: () => ({ id: subject, context: "1to1", hash: "h" }),
  }) as unknown as ToolContext;

const searchAs = async (ctx: ToolContext): Promise<string[]> => {
  const result = await handleSearch({ query: "needle", limit: 20 }, ctx);
  expect(result.isError).toBeUndefined();
  const data = result.structuredContent as { results: { uri: string }[] };
  return data.results.map((r) => r.uri).sort();
};

const expected = (subject: string): string[] =>
  Number(subject.slice(3)) % 2 === 0
    ? ["gno://pub/open.md", "gno://x/x.md"]
    : ["gno://pub/open.md"];

/** USERS concurrent searches, one subject each. */
const burst = async (mutex: Mutex, hook?: Record<string, unknown>) => {
  inFlight = 0;
  maxInFlight = 0;
  const subjects = Array.from({ length: USERS }, (_, k) => `u:s${k}`);
  const started = performance.now();
  const results = await Promise.all(
    subjects.map((subject) => searchAs(contextFor(mutex, subject, hook)))
  );
  return { subjects, results, elapsed: performance.now() - started };
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gno-ahc-"));
  server = Bun.serve({
    unix: join(directory, "hook.sock"),
    async fetch(request) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const body = (await request.json()) as AccessHookRequest;
        await Bun.sleep(HOOK_DELAY_MS);
        if (body.subject === "u:down") {
          return new Response("x", { status: 500 });
        }
        return Response.json({
          allow: body.refs.flatMap((ref, index) =>
            allowed(body.subject, `${ref.sys}:${ref.ref}`) ? [index] : []
          ),
        });
      } finally {
        inFlight -= 1;
      }
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
      typedMetadata: { derived_from: doc.sources },
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

describe("access hook concurrency", () => {
  test("hook waits do not hold the tool mutex", async () => {
    const { subjects, results, elapsed } = await burst(new Mutex());
    // Each search makes two hook calls (collections, then documents). Behind
    // one mutex held across them, the burst would take USERS x 2 x delay.
    expect(elapsed).toBeLessThan((USERS * 2 * HOOK_DELAY_MS) / 2);
    expect(maxInFlight).toBeGreaterThan(1);
    // Overlapping requests keep their own subject's verdicts.
    subjects.forEach((subject, k) =>
      expect(results[k]).toEqual(expected(subject))
    );
  });

  test("maxConcurrent bounds hook calls in flight; queueing is not a timeout", async () => {
    // Queue time (USERS x 2 calls / 2 slots x delay = 1200 ms) far exceeds
    // the 400 ms deadline: the deadline starts when a call is sent.
    const { subjects, results } = await burst(new Mutex(), {
      maxConcurrent: 2,
      timeoutMs: 400,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    subjects.forEach((subject, k) =>
      expect(results[k]).toEqual(expected(subject))
    );
  });

  test("a failing hook still denies its own request while others are served", async () => {
    const mutex = new Mutex();
    const [down, even, odd] = await Promise.all([
      searchAs(contextFor(mutex, "u:down")),
      searchAs(contextFor(mutex, "u:s0")),
      searchAs(contextFor(mutex, "u:s1")),
    ]);
    expect(down).toEqual([]);
    expect(even).toEqual(expected("u:s0"));
    expect(odd).toEqual(expected("u:s1"));
  });

  test("a late answer still denies under concurrency", async () => {
    const mutex = new Mutex();
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, k) =>
        searchAs(contextFor(mutex, `u:s${k}`, { timeoutMs: HOOK_DELAY_MS / 3 }))
      )
    );
    for (const uris of results) expect(uris).toEqual([]);
  });
});
