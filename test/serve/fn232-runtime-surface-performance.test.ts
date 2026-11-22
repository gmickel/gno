import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { VERSION } from "../../src/app/constants";
import {
  clearCliConfigCache,
  isSessionBindingVerifiedInInvocation,
  loadConfigCached,
  markSessionBindingVerifiedInInvocation,
} from "../../src/cli/config-cache";
import { resetGlobals, setCliInvocationActive } from "../../src/cli/globals";
import { runCli } from "../../src/cli/run";
import { createDefaultConfig } from "../../src/config/defaults";
import { saveConfigToPath } from "../../src/config/saver";
import { createToolContext, Mutex } from "../../src/mcp/context";
import { rejectUnknownKeys } from "../../src/mcp/tool-profile";
import { detectQueryLanguage } from "../../src/pipeline/query-language";
import { buildBrowseTree, findBrowseNode } from "../../src/serve/browse-tree";
import { DocumentEventBus } from "../../src/serve/doc-events";
import {
  createPublicFetchFallback,
  maybeCompressApiJsonResponse,
} from "../../src/serve/server";
import { createSpaBundleSource } from "../../src/serve/spa-bundle-source";
import {
  mapWithBoundedConcurrency,
  widenVanishedExactPaths,
} from "../../src/serve/watch-reconciliation-shared";
import {
  cloneDirectoryMaps,
  freezeSnapshot,
  setDirectoryEntries,
} from "../../src/serve/watch-snapshot-scan";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import fixture from "./fixtures/spa-bundle-entry.html";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetGlobals();
  clearCliConfigCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("fn-232 R1: CLI cold-start, config cache, and SQL budget stops", () => {
  test("root --version / -V fast path matches VERSION without loading Commander", async () => {
    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      );
      return true;
    }) as typeof process.stdout.write;
    try {
      const code1 = await runCli(["bun", "gno", "--version"]);
      const code2 = await runCli(["bun", "gno", "-V"]);
      const code3 = await runCli(["bun", "gno", "--json", "--version"]);
      expect(code1).toBe(0);
      expect(code2).toBe(0);
      expect(code3).toBe(0);
      expect(out).toEqual([`${VERSION}\n`, `${VERSION}\n`, `${VERSION}\n`]);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("loadConfigCached reuses parsed config in CLI invocation and invalidates on write", async () => {
    const dir = await makeTempDir("gno-fn232-cfg-");
    const cfgPath = join(dir, "index.yml");
    const cfg = createDefaultConfig();
    await saveConfigToPath(cfg, cfgPath);

    // Outside CLI invocation, caching is inactive
    const outside1 = await loadConfigCached(cfgPath);
    const outside2 = await loadConfigCached(cfgPath);
    expect(outside1.ok && outside2.ok).toBe(true);
    expect(outside1).not.toBe(outside2);

    // Inside CLI invocation, caching returns same object until saveConfigToPath bumps generation
    setCliInvocationActive(true);
    try {
      const first = await loadConfigCached(cfgPath);
      const second = await loadConfigCached(cfgPath);
      expect(first.ok && second.ok).toBe(true);
      expect(first).toBe(second);

      markSessionBindingVerifiedInInvocation(cfgPath, "default");
      expect(isSessionBindingVerifiedInInvocation(cfgPath, "default")).toBe(
        true
      );

      const updated = { ...cfg, ftsTokenizer: "porter" as const };
      await saveConfigToPath(updated, cfgPath);
      expect(isSessionBindingVerifiedInInvocation(cfgPath, "default")).toBe(
        false
      );

      const afterWrite = await loadConfigCached(cfgPath);
      expect(afterWrite.ok).toBe(true);
      if (afterWrite.ok) {
        expect(afterWrite.value.ftsTokenizer).toBe("porter");
      }
      expect(afterWrite).not.toBe(first);
    } finally {
      setCliInvocationActive(false);
    }
  });

  test("detectQueryLanguage skips franc for short queries and returns valid codes for long text", () => {
    expect(detectQueryLanguage("hello").bcp47).toBe("und");
    expect(detectQueryLanguage("a".repeat(14)).bcp47).toBe("und");
    const detected = detectQueryLanguage(
      "This is a clearly written English sentence about software architecture and performance."
    );
    expect(detected.bcp47).toBe("en");
  });

  test("getRecentBudgetStops returns latest budget error per doc and drops docs superseded by non-budget errors", async () => {
    const dir = await makeTempDir("gno-fn232-budget-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    const open = await store.open(dbPath, "unicode61");
    expect(open.ok).toBe(true);

    try {
      const synced = await store.syncCollections([
        {
          name: "notes",
          path: dir,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ]);
      expect(synced.ok).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "big.xlsx",
            sourceHash: "h1",
            sourceMime: "application/octet-stream",
            sourceExt: ".xlsx",
            sourceSize: 100,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Big Sheet",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "recovered.xlsx",
            sourceHash: "h2",
            sourceMime: "application/octet-stream",
            sourceExt: ".xlsx",
            sourceSize: 100,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Recovered Sheet",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);

      const rawDb = store.getRawDb();
      rawDb
        .prepare(
          `UPDATE documents
           SET last_error_code = ?, last_error_message = ?, last_error_at = ?
           WHERE collection = ? AND rel_path = ?`
        )
        .run(
          "BUDGET_EXCEEDED",
          "Sheet exceeded budget",
          "2026-01-01T00:01:00.000Z",
          "notes",
          "big.xlsx"
        );
      rawDb
        .prepare(
          `UPDATE documents
           SET last_error_code = ?, last_error_message = ?, last_error_at = ?
           WHERE collection = ? AND rel_path = ?`
        )
        .run(
          "PARSE_ERROR",
          "Later non-budget failure",
          "2026-01-01T00:02:00.000Z",
          "notes",
          "recovered.xlsx"
        );
      rawDb
        .prepare(
          `INSERT INTO ingest_errors (collection, rel_path, occurred_at, code, message)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          "notes",
          "big.xlsx",
          "2026-01-01T00:01:00.000Z",
          "BUDGET_EXCEEDED",
          "Sheet exceeded budget"
        );
      rawDb
        .prepare(
          `INSERT INTO ingest_errors (collection, rel_path, occurred_at, code, message)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          "notes",
          "recovered.xlsx",
          "2026-01-01T00:01:00.000Z",
          "BUDGET_EXCEEDED",
          "Old budget stop"
        );
      rawDb
        .prepare(
          `INSERT INTO ingest_errors (collection, rel_path, occurred_at, code, message)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          "notes",
          "recovered.xlsx",
          "2026-01-01T00:02:00.000Z",
          "PARSE_ERROR",
          "Later non-budget failure"
        );

      const res = await store.getRecentBudgetStops(
        ["BUDGET_EXCEEDED"],
        100,
        10
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toHaveLength(1);
        expect(res.value[0]?.relPath).toBe("big.xlsx");
        expect(res.value[0]?.code).toBe("BUDGET_EXCEEDED");
        expect(res.value[0]?.collection).toBe("notes");
      }
    } finally {
      await store.close();
    }
  });
});

describe("fn-232 R2: In-process production SPA serving and cached gzip fallback", () => {
  test("in-process production source supports GET, HEAD, 404, ETag and fallback caches gzip hits", async () => {
    const source = await createSpaBundleSource(fixture, false);
    let fetchCalls = 0;
    const countedSource = {
      entryPath: source.entryPath,
      fetch: (req: Request) => {
        fetchCalls += 1;
        return source.fetch(req);
      },
      close: () => source.close(),
    };

    try {
      const entryRes = await source.fetch(
        new Request(`http://public.invalid${source.entryPath}`)
      );
      expect(entryRes.status).toBe(200);
      expect(entryRes.headers.get("ETag")).toBeTruthy();

      const headRes = await source.fetch(
        new Request(`http://public.invalid${source.entryPath}`, {
          method: "HEAD",
        })
      );
      expect(headRes.status).toBe(200);
      expect((await headRes.arrayBuffer()).byteLength).toBe(0);

      const missingRes = await source.fetch(
        new Request("http://public.invalid/does-not-exist.js")
      );
      expect(missingRes.status).toBe(404);

      const html = await entryRes.text();
      const jsPath = html.match(/src="(\/[^"]+\.js)"/)?.[1];
      expect(jsPath).toBeTruthy();

      const fallback = createPublicFetchFallback({
        isDev: false,
        spaBundleSource: countedSource,
      });
      const first = await fallback(
        new Request(`http://127.0.0.1:3000${jsPath}`, {
          headers: { "Accept-Encoding": "gzip" },
        })
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("Content-Encoding")).toBe("gzip");
      expect(first.headers.get("Vary")).toContain("Accept-Encoding");
      expect(fetchCalls).toBe(1);

      // Second gzipped request hits gzipBodies cache BEFORE calling spaBundleSource.fetch
      const second = await fallback(
        new Request(`http://127.0.0.1:3000${jsPath}`, {
          headers: { "Accept-Encoding": "gzip" },
        })
      );
      expect(second.status).toBe(200);
      expect(second.headers.get("Content-Encoding")).toBe("gzip");
      expect(fetchCalls).toBe(1);
    } finally {
      await source.close();
    }
  });
});

describe("fn-232 R3: REST SQL lookups, browse tree, date fields cache, and JSON gzip", () => {
  test("listDocumentsForSimilarity, searchDocumentsForAutocomplete, and cached getCollectionDateFields", async () => {
    const dir = await makeTempDir("gno-fn232-r3-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    const open = await store.open(dbPath, "unicode61");
    expect(open.ok).toBe(true);

    try {
      const synced = await store.syncCollections([
        {
          name: "notes",
          path: dir,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ]);
      expect(synced.ok).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "alpha.md",
            sourceHash: "h1",
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 50,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Alpha Architecture",
            mirrorHash: "m1",
            ingestVersion: 1,
            dateFields: { published: "2026-01-02" },
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "ueber.md",
            sourceHash: "h2",
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 50,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Überblick Notizen",
            mirrorHash: "m2",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);

      const sim = await store.listDocumentsForSimilarity({
        documentIds: [],
        mirrorHashes: ["m1"],
      });
      expect(sim.ok).toBe(true);
      if (sim.ok) {
        expect(sim.value).toHaveLength(1);
        expect(sim.value[0]?.relPath).toBe("alpha.md");
      }

      const asciiRes = await store.searchDocumentsForAutocomplete({
        query: "arch",
        limit: 5,
      });
      expect(asciiRes.ok).toBe(true);
      if (asciiRes.ok) {
        expect(asciiRes.value.map((d) => d.uri)).toEqual([
          "gno://notes/alpha.md",
        ]);
      }

      // Non-ASCII case folding must match Unicode title ("Überblick" vs "über")
      const unicodeRes = await store.searchDocumentsForAutocomplete({
        query: "über",
        limit: 5,
      });
      expect(unicodeRes.ok).toBe(true);
      if (unicodeRes.ok) {
        expect(unicodeRes.value.map((d) => d.uri)).toEqual([
          "gno://notes/ueber.md",
        ]);
      }

      // Unicode collation + Kelvin sign U+212A + fractional limit parity
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "kelvin.md",
            sourceHash: "hk",
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 50,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "\u212aelvin Scale",
            mirrorHash: "mk",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "aardvark.md",
            sourceHash: "ha",
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 50,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Äardvark",
            mirrorHash: "ma",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await store.upsertDocument({
            collection: "notes",
            relPath: "zoo.md",
            sourceHash: "hz",
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: 50,
            sourceMtime: "2026-01-01T00:00:00.000Z",
            title: "Zoo",
            mirrorHash: "mz",
            ingestVersion: 1,
          })
        ).ok
      ).toBe(true);

      const kelvinRes = await store.searchDocumentsForAutocomplete({
        query: "kelvin",
        limit: 5,
      });
      expect(kelvinRes.ok).toBe(true);
      if (kelvinRes.ok) {
        expect(kelvinRes.value.map((d) => d.uri)).toEqual([
          "gno://notes/kelvin.md",
        ]);
      }

      const collationRes = await store.searchDocumentsForAutocomplete({
        query: "",
        limit: 1.5,
      });
      expect(collationRes.ok).toBe(true);
      if (collationRes.ok) {
        expect(collationRes.value).toHaveLength(1);
        expect(collationRes.value[0]?.title).toBe("Äardvark");
      }

      // Negative limit matches Array.prototype.slice(0, -1) (5 docs -> 4 docs)
      const negativeLimitRes = await store.searchDocumentsForAutocomplete({
        query: "",
        limit: -1,
      });
      expect(negativeLimitRes.ok).toBe(true);
      if (negativeLimitRes.ok) {
        expect(negativeLimitRes.value).toHaveLength(4);
      }

      // Rolled-back transaction must NOT poison getCollectionDateFields cache
      const rawDb = store.getRawDb();
      rawDb.run("BEGIN");
      rawDb
        .prepare(
          `UPDATE documents SET date_fields = '{"ephemeral":"2026-05-01"}' WHERE rel_path = 'zoo.md'`
        )
        .run();
      const insideTx = await store.getCollectionDateFields("notes");
      expect(insideTx.ok).toBe(true);
      if (insideTx.ok) {
        expect(insideTx.value).toContain("ephemeral");
      }
      rawDb.run("ROLLBACK");
      const afterRollback = await store.getCollectionDateFields("notes");
      expect(afterRollback.ok).toBe(true);
      if (afterRollback.ok) {
        expect(afterRollback.value).not.toContain("ephemeral");
      }

      // Date fields cache invalidates after new document write
      const dates1 = await store.getCollectionDateFields("notes");
      const dates2 = await store.getCollectionDateFields("notes");
      expect(dates1.ok && dates2.ok).toBe(true);
      if (dates1.ok && dates2.ok) {
        expect(dates1.value).toEqual(dates2.value);
      }

      await store.upsertDocument({
        collection: "notes",
        relPath: "gamma.md",
        sourceHash: "h3",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 50,
        sourceMtime: "2026-01-03T00:00:00.000Z",
        title: "Gamma",
        mirrorHash: "m3",
        ingestVersion: 1,
        dateFields: { reviewed: "2026-01-04" },
      });
      const dates3 = await store.getCollectionDateFields("notes");
      expect(dates3.ok).toBe(true);
      if (dates3.ok) {
        expect(dates3.value).toEqual(["published", "reviewed"]);
      }
    } finally {
      await store.close();
    }
  });

  test("single-pass buildBrowseTree and O(D) findBrowseNode preserve nested structure and counts", () => {
    const collections = buildBrowseTree(
      [{ name: "notes" }],
      [
        { collection: "notes", relPath: "a/b/one.md", active: true },
        { collection: "notes", relPath: "a/b/two.md", active: true },
        { collection: "notes", relPath: "root.md", active: true },
      ],
      [{ collection: "notes", path: "a/empty" }]
    );

    expect(collections[0]?.documentCount).toBe(3);
    expect(collections[0]?.directDocumentCount).toBe(1);

    const foundB = findBrowseNode(collections, "notes", "a/b");
    expect(foundB?.path).toBe("a/b");
    expect(foundB?.documentCount).toBe(2);
    expect(foundB?.directDocumentCount).toBe(2);

    const foundEmpty = findBrowseNode(collections, "notes", "a/empty");
    expect(foundEmpty?.path).toBe("a/empty");
    expect(foundEmpty?.documentCount).toBe(0);

    expect(findBrowseNode(collections, "notes", "a/missing")).toBeNull();
    expect(findBrowseNode(collections, "notes", "a//b")).toBeNull();
  });

  test("maybeCompressApiJsonResponse compresses JSON > 2 KiB and preserves small/non-gzip responses", async () => {
    const largeBody = JSON.stringify({
      items: Array.from({ length: 120 }, (_, i) => ({
        id: i,
        text: `entry-${i}-payload`,
      })),
    });
    const gzipReq = new Request("http://127.0.0.1:3000/api/docs", {
      headers: { "Accept-Encoding": "gzip, deflate" },
    });
    const compressed = await maybeCompressApiJsonResponse(
      gzipReq,
      new Response(largeBody, {
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(compressed.headers.get("Content-Encoding")).toBe("gzip");
    expect(compressed.headers.get("Vary")).toContain("Accept-Encoding");
    const inflated = new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer()))
    );
    expect(inflated).toBe(largeBody);

    // Small payload stays uncompressed
    const small = await maybeCompressApiJsonResponse(
      gzipReq,
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(small.headers.get("Content-Encoding")).toBeNull();

    // Client without gzip stays uncompressed
    const noGzip = await maybeCompressApiJsonResponse(
      new Request("http://127.0.0.1:3000/api/docs"),
      new Response(largeBody, {
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(noGzip.headers.get("Content-Encoding")).toBeNull();
  });
});

describe("fn-232 R4: Watcher shallow maps, bounded concurrency, and SSE zero-subscriber short-circuit", () => {
  test("cloneDirectoryMaps shallow-copies outer map while isolating mutations", () => {
    const fpA = {
      kind: "file" as const,
      device: 1n,
      inode: 1n,
      size: 10,
      mtimeNs: 1n,
      ctimeNs: 1n,
    };
    const fpB = {
      kind: "file" as const,
      device: 1n,
      inode: 2n,
      size: 20,
      mtimeNs: 2n,
      ctimeNs: 2n,
    };
    const rootEntries = new Map([["a.md", fpA]]);
    const snapshot = {
      directories: new Map([["", rootEntries]]),
      entryCount: 1,
      unprovenSubtrees: new Set<string>(),
    };

    const cloned = cloneDirectoryMaps(snapshot);
    expect(cloned.directories).not.toBe(snapshot.directories);
    expect(cloned.directories.get("")).toBe(rootEntries);

    const updatedRoot = new Map([
      ["a.md", fpA],
      ["b.md", fpB],
    ]);
    setDirectoryEntries(cloned, "", updatedRoot);
    const frozen = freezeSnapshot(cloned);
    expect(frozen.entryCount).toBe(2);
    expect(snapshot.entryCount).toBe(1);
    expect(snapshot.directories.get("")?.size).toBe(1);
  });

  test("mapWithBoundedConcurrency caps in-flight work and preserves deterministic order", async () => {
    let active = 0;
    let peak = 0;
    const inputs = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapWithBoundedConcurrency(inputs, 4, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(2 + ((20 - n) % 5));
      active -= 1;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(inputs.map((n) => n * 10));
  });

  test("widenVanishedExactPaths keeps deterministic order with mixed existing/missing files", async () => {
    const dir = await makeTempDir("gno-fn232-widen-");
    await writeFile(join(dir, "present-a.md"), "a");
    await writeFile(join(dir, "present-b.md"), "b");

    const result = await widenVanishedExactPaths(dir, [
      "present-a.md",
      "missing-1.md",
      "present-b.md",
      "missing-2.md",
    ]);
    expect(result.keepExact).toEqual([
      "present-a.md",
      "missing-1.md",
      "present-b.md",
      "missing-2.md",
    ]);
    expect(result.extraDirty).toEqual(["missing-1.md", "", "missing-2.md", ""]);
  });

  test("DocumentEventBus.emit short-circuits cleanly with zero subscribers", () => {
    const bus = new DocumentEventBus();
    expect(bus.getState().connectedClients).toBe(0);
    expect(() =>
      bus.emit({
        type: "document-changed",
        uri: "gno://notes/a.md",
        collection: "notes",
        relPath: "a.md",
        origin: "watcher",
        changedAt: "2026-01-01T00:00:00.000Z",
      })
    ).not.toThrow();
  });
});

describe("fn-232 R6: MCP RW lock, WeakMap strict schema cache, and warm port caching", () => {
  test("Mutex allows concurrent readers and blocks writers/subsequent readers fairly", async () => {
    const lock = new Mutex();
    const events: string[] = [];

    const releaseR1 = await lock.acquireRead();
    events.push("r1-acquired");
    const releaseR2 = await lock.acquireRead();
    events.push("r2-acquired");

    // Writer waits for both active readers
    let writerAcquired = false;
    const writerPromise = lock.acquire().then((release) => {
      writerAcquired = true;
      events.push("w-acquired");
      return release;
    });

    // Reader queued behind a waiting writer must wait until writer finishes
    let r3Acquired = false;
    const r3Promise = lock.acquireRead().then((release) => {
      r3Acquired = true;
      events.push("r3-acquired");
      return release;
    });

    await Bun.sleep(5);
    expect(writerAcquired).toBe(false);
    expect(r3Acquired).toBe(false);

    releaseR1();
    await Bun.sleep(5);
    expect(writerAcquired).toBe(false);

    releaseR2();
    const releaseWriter = await writerPromise;
    expect(writerAcquired).toBe(true);
    expect(r3Acquired).toBe(false);

    releaseWriter();
    const releaseR3 = await r3Promise;
    expect(r3Acquired).toBe(true);
    releaseR3();

    expect(events).toEqual([
      "r1-acquired",
      "r2-acquired",
      "w-acquired",
      "r3-acquired",
    ]);
  });

  test("rejectUnknownKeys caches strictified ZodObject instances in WeakMap", () => {
    const schema = z.object({
      query: z.string(),
      limit: z.number().optional(),
    });
    const strict1 = rejectUnknownKeys(schema);
    const strict2 = rejectUnknownKeys(schema);
    expect(strict1).toBe(strict2);
    expect(strict1?.safeParse({ query: "hi", extra: 1 }).success).toBe(false);
    expect(strict1?.safeParse({ query: "hi" }).success).toBe(true);
  });

  test("ToolContext caches warm ports per config and invalidates on config change or disposeModels", async () => {
    const dir = await makeTempDir("gno-fn232-mcpctx-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    const open = await store.open(dbPath, "unicode61");
    expect(open.ok).toBe(true);

    let activeConfig = createDefaultConfig();
    try {
      const ctx = createToolContext({
        store,
        getConfig: () => activeConfig,
        setConfig: (next) => {
          activeConfig = next;
        },
        actualConfigPath: join(dir, "index.yml"),
        indexName: "default",
        toolMutex: new Mutex(),
        jobManager: {} as never,
        serverInstanceId: "test-inst",
        writeLockPath: join(dir, "write.lock"),
        enableWrite: false,
        isShuttingDown: () => false,
      });

      const v1 = await ctx.getCachedVectorIndex?.("test-model", 4);
      const v2 = await ctx.getCachedVectorIndex?.("test-model", 4);
      expect(v1?.ok && v2?.ok).toBe(true);
      if (v1?.ok && v2?.ok) {
        expect(v1.value).toBe(v2.value);
      }

      // Config change invalidates cache
      ctx.config = { ...activeConfig, ftsTokenizer: "porter" };
      const v3 = await ctx.getCachedVectorIndex?.("test-model", 4);
      expect(v3?.ok).toBe(true);
      if (v1?.ok && v3?.ok) {
        expect(v3.value).not.toBe(v1.value);
      }

      // disposeModels invalidates cache
      await ctx.disposeModels?.();
      const v4 = await ctx.getCachedVectorIndex?.("test-model", 4);
      expect(v4?.ok).toBe(true);
      if (v3?.ok && v4?.ok) {
        expect(v4.value).not.toBe(v3.value);
      }

      // getCachedLazyVectorIndex must NOT share request-scoped embedPort when no stored dimensions exist
      let initCallsA = 0;
      let initCallsB = 0;
      const makeFakeEmbedPort = (onInit: () => void) =>
        ({
          modelUri: "lazy-unbacked-model",
          init: async () => {
            onInit();
            return { ok: true as const, value: undefined };
          },
          embed: async () => ({ ok: true as const, value: [1, 0, 0, 0] }),
          embedBatch: async () => ({
            ok: true as const,
            value: [[1, 0, 0, 0]],
          }),
          dimensions: () => 4,
          dispose: async () => undefined,
        }) as never;
      const lazyA = await ctx.getCachedLazyVectorIndex?.(
        "lazy-unbacked-model",
        makeFakeEmbedPort(() => {
          initCallsA += 1;
        })
      );
      const lazyB = await ctx.getCachedLazyVectorIndex?.(
        "lazy-unbacked-model",
        makeFakeEmbedPort(() => {
          initCallsB += 1;
        })
      );
      expect(lazyA).not.toBe(lazyB);
      await lazyA?.searchNearest(new Float32Array([1, 0, 0, 0]), 1);
      await lazyB?.searchNearest(new Float32Array([1, 0, 0, 0]), 1);
      expect(initCallsA).toBe(1);
      expect(initCallsB).toBe(1);

      // Config reload mid-open must NOT return an already-disposed port
      let disposed = false;
      let releaseOpen: (() => void) | null = null;
      const openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const fakeAdapter = {
        createEmbeddingPort: async () => {
          await openGate;
          return {
            ok: true as const,
            value: {
              modelUri: "embed-reload-test",
              init: async () => ({ ok: true as const, value: undefined }),
              embed: async () => ({ ok: true as const, value: [1, 0] }),
              embedBatch: async () => ({ ok: true as const, value: [[1, 0]] }),
              dimensions: () => 2,
              dispose: async () => {
                disposed = true;
              },
            },
          };
        },
        dispose: async () => undefined,
      };
      const reloadCtx = createToolContext({
        store,
        getConfig: () => activeConfig,
        setConfig: (next) => {
          activeConfig = next;
        },
        actualConfigPath: join(dir, "index.yml"),
        indexName: "default",
        toolMutex: new Mutex(),
        jobManager: {} as never,
        serverInstanceId: "test-inst-reload",
        writeLockPath: join(dir, "write.lock"),
        enableWrite: false,
        isShuttingDown: () => false,
        getModelAdapter: () => fakeAdapter as never,
      });
      const pendingOpen = reloadCtx.getCachedEmbeddingPort?.(
        "embed-reload-test",
        {
          policy: { offline: true, allowDownload: false },
          egressCollections: "all",
        }
      );
      // Config changes while port is opening
      reloadCtx.config = { ...activeConfig, ftsTokenizer: "unicode61" };
      releaseOpen!();
      const opened = await pendingOpen;
      expect(opened?.ok).toBe(true);
      expect(disposed).toBe(false);
      // Shutdown disposes the retired port cleanly
      await reloadCtx.disposeModels?.();
      expect(disposed).toBe(true);
    } finally {
      await store.close();
    }
  });
});
