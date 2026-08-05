import {
  createDefaultConfig,
  createGnoClient,
  getRetrievalTraceMetadata,
  type GnoClient,
  type GnoCreatedNoteDocument,
  type GnoCreateNoteResult,
  type GnoProjectHintOptions,
  type GnoSearchOptions,
  type SearchResults,
} from "@gmickel/gno";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

let testDir: string;
let fixturesDir: string;
let dbPath: string;
let client: GnoClient;
let stdoutData = "";
let stderrData = "";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

const originalEnv = {
  configDir: process.env.GNO_CONFIG_DIR,
  dataDir: process.env.GNO_DATA_DIR,
  cacheDir: process.env.GNO_CACHE_DIR,
};

function captureOutput() {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput() {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(...args: string[]) {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

async function expectWriteRefused(
  operation: Promise<unknown>,
  reason: string
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({
      code: "VALIDATION",
      details: { code: reason },
    });
    return;
  }
  throw new Error(`expected the write to be refused with ${reason}`);
}

/**
 * Narrow a `createNote` result to the plain-document shape.
 *
 * `GnoCreateNoteResult` is a union and only the `document` arm carries a
 * fetchable `uri`, so a test that wants one has to say which arm it expects.
 */
function expectDocumentNote(
  result: GnoCreateNoteResult
): GnoCreatedNoteDocument {
  if (result.kind !== "document") {
    throw new Error(`expected a document note, got kind=${result.kind}`);
  }
  return result;
}

beforeAll(async () => {
  testDir = join(tmpdir(), `gno-sdk-test-${Date.now()}`);
  fixturesDir = join(testDir, "fixtures");
  dbPath = join(testDir, "data", "index-sdk.sqlite");

  await mkdir(testDir, { recursive: true });
  await cp(join(import.meta.dir, "../fixtures/docs"), fixturesDir, {
    recursive: true,
  });

  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");

  const config = createDefaultConfig();
  config.collections = [
    {
      name: "fixtures",
      path: fixturesDir,
      pattern: "**/*",
      include: [],
      exclude: [],
      // Makes `.jsonl` a RECORD CONTAINER for this collection: one written
      // file, N logical record documents, and no document at the written path.
      recordAdapters: {
        jsonl: {
          fieldMapping: { id: "/id", title: "/title", body: "/text" },
        },
      },
    },
  ];
  config.contexts = [
    { scopeType: "global", scopeKey: "/", text: "Global guidance" },
    {
      scopeType: "collection",
      scopeKey: "fixtures:",
      text: "Fixture guidance",
    },
    {
      scopeType: "prefix",
      scopeKey: "gno://fixtures/authentication.md",
      text: "Authentication guidance",
    },
  ];
  config.contentTypes = [
    {
      id: "reference",
      preset: "source-summary",
      prefixes: ["authentication.md"],
      searchBoost: 1.2,
    },
  ];

  client = await createGnoClient({
    config,
    dbPath,
    downloadPolicy: { offline: false, allowDownload: false },
  });
  await client.update();
}, 30_000);

afterAll(async () => {
  await client.close();
  await safeRm(testDir);
  process.env.GNO_CONFIG_DIR = originalEnv.configDir;
  process.env.GNO_DATA_DIR = originalEnv.dataDir;
  process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
});

describe("SDK client", () => {
  test("exports public project-hint option types", () => {
    const hints: GnoProjectHintOptions = { projectHints: ["opaque/project"] };
    const search: GnoSearchOptions = { ...hints, limit: 5 };
    expect(search).toEqual({
      projectHints: ["opaque/project"],
      limit: 5,
    });
  });

  test("rejects an unsafe index name even with an explicit database path", async () => {
    let caught: unknown;
    try {
      await createGnoClient({
        config: createDefaultConfig(),
        dbPath,
        indexName: "../escape",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("Invalid index name:"),
    });
  });

  test("opens with inline config and reports status", async () => {
    expect(client.isOpen()).toBe(true);
    const status = await client.status();
    expect(status.dbPath).toBe(dbPath);
    expect(status.activeDocuments).toBeGreaterThan(0);
    expect(status.collections[0]?.name).toBe("fixtures");
    expect(status.contentTypeBoost.rules).toEqual([
      { id: "reference", searchBoost: 1.2 },
    ]);
    expect(status.contentTypeBoost.rulesFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(status.contentTypeBoost).not.toHaveProperty("prefixes");
  });

  test("rejects hostile direct policy checks through the SDK", async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(client.checkEgress(revoked.proxy as never)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Unreadable input object",
    });
    const base = {
      action: "export",
      destinationZone: "remote",
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "retrieval_trace",
    } as const;
    for (const collections of [[], ["fixtures", "fixtures"], ["missing"]]) {
      expect(
        client.checkEgress({ ...base, collections } as never)
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    expect(
      client.checkEgress({ ...base, collections: ["missing"] })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Invalid collection egress scope",
    });
  });

  test("lists indexed documents", async () => {
    const result = await client.list({ limit: 5 });
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.meta.total).toBeGreaterThan(0);
    expect(result.documents[0]?.uri.startsWith("gno://fixtures/")).toBe(true);
  });

  test("rejects provided-empty Knowledge Delta selectors", async () => {
    expect(client.changes({ collection: "   " })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("collection"),
    });
    expect(
      client.diff("gno://fixtures/authentication.md", "")
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("changeId"),
    });
  });

  test("runs BM25 search through package root import", async () => {
    const result = await client.search("JWT token", { limit: 5 });
    expect(result.meta.mode).toBe("bm25");
    expect(result.results.length).toBeGreaterThan(0);
    expect(
      result.results.some((r) => r.source.relPath === "authentication.md")
    ).toBe(true);
    const auth = result.results.find(
      (item) => item.source.relPath === "authentication.md"
    );
    expect(auth).toMatchObject({
      uri: "gno://fixtures/authentication.md",
      context: "Global guidance\n\nFixture guidance\n\nAuthentication guidance",
    });
  });

  test("keeps opaque SDK hints zero-effect and non-reflective", async () => {
    const baseline = await client.search("JWT token", { limit: 5 });
    const hinted = await client.search("JWT token", {
      limit: 5,
      projectHints: [" private/sdk-project "],
    });
    expect(hinted).toEqual(baseline);
    expect(JSON.stringify(hinted)).not.toContain("private/sdk-project");

    const queryOptions = {
      limit: 5,
      noExpand: true,
      noRerank: true,
    };
    const queryBaseline = await client.query("JWT token", queryOptions);
    const queryHinted = await client.query("JWT token", {
      ...queryOptions,
      projectHints: [" private/sdk-project "],
    });
    expect(queryHinted).toEqual(queryBaseline);
    expect(JSON.stringify(queryHinted)).toBe(JSON.stringify(queryBaseline));
  });

  test("maps malformed hints to public SDK validation errors on every retrieval seam", async () => {
    const expected = {
      name: "GnoSdkError",
      code: "VALIDATION",
      message: "project hints must not contain empty values",
    };
    const calls = [
      () => client.search("JWT token", { projectHints: [" "] }),
      () => client.vsearch("JWT token", { projectHints: [" "] }),
      () =>
        client.query("JWT token", {
          projectHints: [" "],
          noExpand: true,
          noRerank: true,
        }),
      () =>
        client.ask("JWT token", {
          projectHints: [" "],
          noAnswer: true,
          noExpand: true,
          noRerank: true,
        }),
      () =>
        client.context({
          goal: "JWT token",
          budgetTokens: 100,
          depthPolicy: "fast",
          projectHints: [" "],
        }),
    ];
    for (const call of calls) {
      let caught: unknown;
      try {
        await call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject(expected);
    }
  });

  test("runs hybrid query in BM25-only fallback mode", async () => {
    const result = await client.query("JWT token", {
      limit: 5,
      noExpand: true,
      noRerank: true,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.meta.query).toBe("JWT token");
  });

  test("normalizes structured query documents in SDK query", async () => {
    const result = await client.query(
      "auth flow\nterm: JWT token\nintent: refresh token rotation",
      {
        limit: 5,
        noExpand: true,
        noRerank: true,
      }
    );
    expect(result.meta.query).toBe("auth flow");
    expect(result.meta.queryModes).toEqual({
      term: 1,
      intent: 1,
      hyde: false,
    });
  });

  test("runs ask retrieval without answer generation", async () => {
    const result = await client.ask("JWT token", {
      limit: 5,
      noAnswer: true,
      noExpand: true,
      noRerank: true,
    });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.meta.answerGenerated).toBe(false);
  });

  test("normalizes structured query documents in SDK ask", async () => {
    const result = await client.ask(
      "term: JWT token\nintent: refresh token rotation",
      {
        limit: 5,
        noAnswer: true,
        noExpand: true,
        noRerank: true,
      }
    );
    expect(result.query).toBe("JWT token");
    expect(result.meta.queryModes).toEqual({
      term: 1,
      intent: 1,
      hyde: false,
    });
  });

  test("gets one document by collection/path ref", async () => {
    const result = await client.get("fixtures/authentication.md");
    expect(result.uri).toBe("gno://fixtures/authentication.md");
    expect(result.content).toContain("JWT");
  });

  test("preserves non-enumerable trace metadata across query-to-get", async () => {
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "fixtures",
        path: fixturesDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    config.contexts = [
      { scopeType: "global", scopeKey: "/", text: "Global guidance" },
      {
        scopeType: "collection",
        scopeKey: "fixtures:",
        text: "Fixture guidance",
      },
      {
        scopeType: "prefix",
        scopeKey: "gno://fixtures/authentication.md",
        text: "Authentication guidance",
      },
    ];
    config.retrievalTraces = {
      enabled: true,
      redactionMode: "replay",
      retention: {
        maxAgeDays: 30,
        maxTraces: 100,
        maxRecordsPerTrace: 100,
        maxBytes: 1024 * 1024,
      },
    };
    const tracedClient = await createGnoClient({
      config,
      dbPath,
      downloadPolicy: { offline: false, allowDownload: false },
    });
    try {
      const results = await tracedClient.search("authentication");
      const traceId = getRetrievalTraceMetadata(results)?.traceId;
      expect(traceId).toBeString();
      expect(JSON.stringify(results)).not.toContain(traceId);
      const document = await tracedClient.get(results.results[0]?.uri ?? "", {
        traceId,
      });
      expect(getRetrievalTraceMetadata(document)?.traceId).toBe(traceId);
      expect(JSON.stringify(document)).not.toContain(traceId);
    } finally {
      await tracedClient.close();
    }
  });

  test("manages private retrieval traces through the public SDK", async () => {
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "fixtures",
        path: fixturesDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    config.contexts = [
      { scopeType: "global", scopeKey: "/", text: "Global guidance" },
      {
        scopeType: "collection",
        scopeKey: "fixtures:",
        text: "Fixture guidance",
      },
      {
        scopeType: "prefix",
        scopeKey: "gno://fixtures/authentication.md",
        text: "Authentication guidance",
      },
    ];
    config.retrievalTraces = {
      enabled: true,
      redactionMode: "replay",
      retention: {
        maxAgeDays: 30,
        maxTraces: 100,
        maxRecordsPerTrace: 100,
        maxBytes: 1024 * 1024,
      },
    };
    const tracedClient = await createGnoClient({
      config,
      dbPath,
      downloadPolicy: { offline: false, allowDownload: false },
    });
    try {
      const answer = await tracedClient.ask("JWT token", {
        limit: 5,
        noAnswer: true,
        noExpand: true,
        noRerank: true,
      });
      const traceId = getRetrievalTraceMetadata(answer)?.traceId;
      expect(traceId).toBeString();

      const history = await tracedClient.listRetrievalTraces({ limit: 20 });
      expect(history.traces.some((trace) => trace.traceId === traceId)).toBe(
        true
      );
      expect(JSON.stringify(history.traces)).not.toContain("queryText");

      const detail = await tracedClient.getRetrievalTrace(traceId!);
      expect(detail.trace.status).toBe("open");
      const targetRef = answer.results[0]?.uri;
      expect(targetRef).toBeString();

      const labeled = await tracedClient.labelRetrievalTrace({
        traceId: traceId!,
        label: "relevant",
        targetRef: targetRef!,
      });
      expect(labeled.result).toBe("inserted");

      expect(
        tracedClient.exportRetrievalTraces({ traceIds: [traceId!] })
      ).rejects.toThrow("Open retrieval traces cannot be exported");

      const deleted = await tracedClient.deleteRetrievalTrace(traceId!);
      expect(deleted.deleted).toBe(true);
      expect(tracedClient.getRetrievalTrace(traceId!)).rejects.toThrow(
        "Retrieval trace not found"
      );
      try {
        await tracedClient.deleteRetrievalTrace(traceId!);
        throw new Error("Expected missing trace deletion to fail");
      } catch (error) {
        expect(error).toMatchObject({
          code: "NOT_FOUND",
          details: { traceCode: "NOT_FOUND" },
        });
      }

      const purged = await tracedClient.purgeRetrievalTraces();
      expect(
        ["completed", "wal_busy", "failed"].includes(purged.physicalCleanup)
      ).toBe(true);
    } finally {
      await tracedClient.close();
    }
  });

  test("creates notes with folder context and preset scaffolds", async () => {
    const result = await client.createNote({
      collection: "fixtures",
      title: "SDK Project",
      folderPath: "generated",
      presetId: "project-note",
    });

    expect(result.relPath).toBe("generated/sdk-project.md");
    // An ordinary note IS its document, so it keeps the fetchable-URI shape -
    // and carries no `reason` at all, container or import.
    expect(result.kind).toBe("document");
    expect(result).not.toHaveProperty("reason");

    const created = await client.get("fixtures/generated/sdk-project.md");
    expect(created.content).toContain("## Goal");
    expect(created.content).toContain('category: "project"');
  });

  test("createNote into a record container returns fetchable record URIs and no document URI", async () => {
    // DISCRIMINATING against 0a3b57f5: there this call returned
    // `uri: "gno://fixtures/generated/session.jsonl"`, and `client.get()` on it
    // threw - a supported creation that succeeded and handed back a handle
    // resolving to nothing. The result now has no `uri` for this shape at all,
    // and what it does hand back resolves.
    const relPath = "generated/session.jsonl";
    const created = await client.createNote({
      collection: "fixtures",
      relPath,
      content: `${[
        { id: "one", title: "First record", text: "Zephyr ships on Friday" },
        { id: "two", title: "Second record", text: "Budget capped at forty" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    });

    expect(created.kind).toBe("record-container");
    if (created.kind !== "record-container") {
      throw new Error("expected a record-container result");
    }
    // The physical file is still identified, exactly as before.
    expect(created.relPath).toBe(relPath);
    expect(created.path).toBe(join(fixturesDir, "generated", "session.jsonl"));
    expect(created.created).toBe(true);
    // No document URI is offered, because none would resolve.
    expect(created).not.toHaveProperty("uri");
    expect(created.reason).toContain("2 logical record documents");

    expect(created.recordUris).toHaveLength(2);
    // DISCRIMINATING against fbbfdcaa: `recordUris` was the container's whole
    // record set with no count beside it, so a caller could not tell a
    // complete list from a page - and a large export handed back every URI.
    expect(created.recordCount).toBe(2);
    expect(created.recordUrisTruncated).toBe(0);
    for (const uri of created.recordUris) {
      expect(uri).not.toBe(`gno://fixtures/${relPath}`);
      const fetched = await client.get(uri);
      expect(fetched.content.length).toBeGreaterThan(0);
    }

    // A CLEAN container says only the container fact - the partial-import
    // sentence must not appear where nothing was rejected.
    expect(created.reason).toContain("Written as a record container");
    expect(created.reason).not.toContain("Record import was partial");

    // The reason the shape exists: the written path resolves to nothing.
    expect(client.get(`gno://fixtures/${relPath}`)).rejects.toThrow();
  });

  /**
   * An adapter that accepts SOME of what was written is not an error: the
   * container's file result is `added`/`updated` and the rejected records are
   * disclosed only in `recordImport.failures`. A `reason` built from the
   * container proof alone therefore reports a half-imported export as a clean
   * one - the same defect the capture surfaces already closed.
   */
  test("createNote discloses a container whose adapter rejected a record", async () => {
    // DISCRIMINATING against fc2213fa: there `createNote` composed its own
    // container sentence from the proof and ignored `syncResult.recordImport`
    // entirely, so this result read exactly like the clean container above -
    // one sentence about record documents, no hint that a line was dropped.
    const relPath = "generated/partial.jsonl";
    const created = await client.createNote({
      collection: "fixtures",
      relPath,
      content: `${JSON.stringify({
        id: "one",
        title: "First record",
        text: "Zephyr ships on Friday",
      })}\n{ this line is not JSON\n`,
    });

    expect(created.kind).toBe("record-container");
    if (created.kind !== "record-container") {
      throw new Error("expected a record-container result");
    }
    // Both facts, neither replacing the other.
    expect(created.reason).toContain("Written as a record container");
    expect(created.reason).toContain("Record import was partial");
    expect(created.reason).toContain(
      "rejected by the adapter/jsonl adapter and NOT indexed"
    );
    expect(created.reason).toContain("(1 accepted)");
    // Only the accepted record is indexed, which is exactly what the sentence
    // above claims.
    expect(created.recordCount).toBe(1);

    // DISCRIMINATING against 386aa65d: sharing the composer there also shared
    // the capture RECEIPT's consequences, and neither is true of this shape.
    // `GnoCreateNoteResult` has no `docid` field, so "this receipt carries no
    // docid" named a contract it does not have - while saying nothing about
    // what the caller actually lost, the single fetchable `uri`. And it holds
    // no sync result, so "See the sync result's recordImport.failures" pointed
    // at an object it never receives.
    expect(created.reason).toContain("no single fetchable URI");
    expect(created.reason).toContain("recordUris");
    expect(created.reason).not.toContain("docid");
    expect(created.reason).toContain(
      "This response does not carry the per-record failures"
    );
    expect(created.reason).toContain("gno update --verbose");
    expect(created.reason).not.toContain("recordImport.failures");
  });

  test("captures notes with provenance receipt through the SDK", async () => {
    const result = await client.capture({
      collection: "fixtures",
      content: "Captured from SDK",
      source: {
        kind: "api",
        externalId: "sdk-test",
      },
      tags: ["SDK", "Inbox"],
    });

    expect(result.uri).toStartWith("gno://fixtures/inbox/");
    expect(result.created).toBe(true);
    expect(result.sync.status).toBe("completed");
    expect(result.embed.status).toBe("not_requested");
    expect(result.source.kind).toBe("api");
    expect(result.source.externalId).toBe("sdk-test");
    expect(result.tags).toEqual(["sdk", "inbox"]);

    const created = await client.get(result.uri);
    expect(created.content).toContain("Captured from SDK");
    expect(created.content).toContain("source:");
  });

  test("creates and captures into a real nested folder, and the URI resolves", async () => {
    // Non-discriminating regression guard: passes at fc38f2de too. It keeps
    // the refusals below from being satisfied by refusing nested writes.
    const created = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        title: "Real Nested",
        folderPath: "generated/real-nested",
        content: "# Real Nested\n\nBody\n",
      })
    );
    expect(created.relPath).toBe("generated/real-nested/real-nested.md");
    const fetched = await client.get(created.uri);
    expect(fetched.content).toContain("Body");

    const captured = await client.capture({
      collection: "fixtures",
      content: "Captured nested",
      folderPath: "generated/real-nested",
      title: "Captured Nested",
    });
    expect(captured.sync.status).toBe("completed");
    expect((await client.get(captured.uri)).content).toContain(
      "Captured nested"
    );
  });

  test("SDK refuses writes beneath a symlinked folder inside the collection", async () => {
    // DISCRIMINATING: at fc38f2de `mkdir -p` followed the alias, both calls
    // "succeeded", and `createNote` handed back a gno:// URI that resolved to
    // nothing because the no-follow indexer never saw the file.
    await mkdir(join(fixturesDir, "aliased-real"), { recursive: true });
    await symlink(
      join(fixturesDir, "aliased-real"),
      join(fixturesDir, "aliased")
    );

    await expectWriteRefused(
      client.createNote({
        collection: "fixtures",
        title: "Aliased Note",
        folderPath: "aliased",
        content: "# Aliased\n",
      }),
      "PATH_NOT_WALKABLE"
    );

    await expectWriteRefused(
      client.capture({
        collection: "fixtures",
        content: "Aliased capture",
        folderPath: "aliased",
      }),
      "PATH_NOT_WALKABLE"
    );

    const leaked = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: join(fixturesDir, "aliased-real") })
    );
    expect(leaked).toEqual([]);
  });

  test("SDK reports containment when a symlinked folder escapes the collection", async () => {
    // DISCRIMINATING: at fc38f2de both calls wrote OUTSIDE the collection and
    // reported success; the containment error was lost.
    const outsideDir = await mkdtemp(join(tmpdir(), "gno-sdk-outside-"));
    await symlink(outsideDir, join(fixturesDir, "escaped"));

    await expectWriteRefused(
      client.createNote({
        collection: "fixtures",
        title: "Escaped Note",
        folderPath: "escaped",
        content: "# Escaped\n",
      }),
      "PATH_OUTSIDE_COLLECTION"
    );

    await expectWriteRefused(
      client.capture({
        collection: "fixtures",
        content: "Escaped capture",
        folderPath: "escaped",
      }),
      "PATH_OUTSIDE_COLLECTION"
    );

    const leaked = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: outsideDir })
    );
    expect(leaked).toEqual([]);
    await safeRm(outsideDir);
  });

  test("rejects invalid capture collision policies at runtime", async () => {
    try {
      await client.capture({
        collection: "fixtures",
        content: "Bad policy",
        collisionPolicy: "replace" as never,
      });
      throw new Error("expected capture to reject invalid collision policy");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "collisionPolicy must be one of"
      );
    }
  });

  test("rejects legacy overwrite through SDK capture", async () => {
    try {
      await client.capture({
        collection: "fixtures",
        content: "Bad overwrite",
        overwrite: true,
      } as never);
      throw new Error("expected capture to reject overwrite");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("overwrite is not supported");
    }
  });

  test("creates folders directly through the SDK", async () => {
    const result = await client.createFolder({
      collection: "fixtures",
      parentPath: "generated",
      name: "nested",
    });

    expect(result.folderPath).toBe("generated/nested");
  });

  test("extracts sections through the SDK", async () => {
    const sections = await client.getSections("fixtures/authentication.md");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]?.anchor).toBeTruthy();
  });

  test("renames notes through the SDK", async () => {
    const created = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        title: "Rename Me",
        folderPath: "generated",
        content: "# Rename Me\n",
      })
    );
    const preview = await client.previewRenameNote({
      ref: created.uri,
      name: "renamed.md",
    });
    expect(preview.canApply).toBe(true);
    const renamed = await client.renameNote({
      ref: created.uri,
      name: "renamed.md",
      schemaVersion: preview.schemaVersion,
      planDigest: preview.planDigest,
      confirmation: "apply",
    });

    expect(renamed.target.relPath).toBe("generated/renamed.md");
    expect(renamed.status).toBe("applied");
  });

  test("moves notes through the SDK", async () => {
    const created = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        title: "Move Me",
        folderPath: "generated",
        content: "# Move Me\n",
      })
    );
    const preview = await client.previewMoveNote({
      ref: created.uri,
      folderPath: "generated/archive",
    });
    expect(preview.canApply).toBe(true);
    const moved = await client.moveNote({
      ref: created.uri,
      folderPath: "generated/archive",
      schemaVersion: preview.schemaVersion,
      planDigest: preview.planDigest,
      confirmation: "apply",
    });

    expect(moved.target.relPath).toBe("generated/archive/move-me.md");
    expect(moved.status).toBe("applied");
  });

  test("rejects SDK apply without an exact plan digest", async () => {
    const created = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        title: "Stale Rename",
        folderPath: "generated",
        content: "# Stale Rename\n",
      })
    );
    const result = await client.renameNote({
      ref: created.uri,
      name: "stale-renamed.md",
      schemaVersion: "1.0",
      planDigest: "0".repeat(64),
      confirmation: "apply",
    });
    expect(result.status).toBe("stale_plan");
  });

  test("SDK runtime cannot bypass explicit apply confirmation", async () => {
    expect(
      client.renameNote({
        ref: "fixtures/authentication.md",
        name: "renamed.md",
      } as never)
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("duplicates notes through the SDK", async () => {
    const created = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        title: "Duplicate Me",
        folderPath: "generated",
        content: "# Duplicate Me\n",
      })
    );
    const duplicated = await client.duplicateNote({
      ref: created.uri,
      folderPath: "generated/archive",
    });

    expect(duplicated.relPath).toBe("generated/archive/duplicate-me.md");
    // An ordinary duplicate has nothing unusual to report about its URI.
    expect(
      duplicated.warnings.some((warning) => warning.includes("not indexed"))
    ).toBe(false);
    expect(
      duplicated.warnings.some((warning) =>
        warning.includes("resolves to no document")
      )
    ).toBe(false);
  });

  test("duplicating into a container extension warns that the returned uri resolves to nothing", async () => {
    // DISCRIMINATING against 5d3c7939: `duplicateNote` warned only when the
    // proof FAILED. A copy to a configured container extension makes the proof
    // SUCCEED as `record-container`, so the SDK returned an unresolvable `uri`
    // and said nothing - while REST and MCP already warned for this exact case.
    const source = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        relPath: "generated/duplicate-records.txt",
        content: `${[
          { id: "one", title: "First record", text: "Zephyr ships on Friday" },
          { id: "two", title: "Second record", text: "Budget capped at forty" },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
      })
    );

    const duplicated = await client.duplicateNote({
      ref: source.uri,
      name: "duplicate-records.jsonl",
    });

    expect(duplicated.relPath).toBe("generated/duplicate-records.jsonl");
    const containerWarning = duplicated.warnings.find((warning) =>
      warning.includes("resolves to no document")
    );
    expect(containerWarning).toContain("2 logical record documents");
    expect(containerWarning).toContain(duplicated.uri);
    // The warning is the whole point: this URI does not resolve.
    expect(client.get(duplicated.uri)).rejects.toThrow();
    // A CLEAN copy says only the container fact.
    expect(
      duplicated.warnings.some((warning) =>
        warning.includes("Record import was partial")
      )
    ).toBe(false);
  });

  test("duplicating into a container extension discloses a partial import", async () => {
    // DISCRIMINATING against fc2213fa: the duplicate paths warned about the
    // container SHAPE only. The copy is imported by the adapter exactly like
    // any other write, so it can reject records - and that was disclosed
    // nowhere on this surface.
    const source = expectDocumentNote(
      await client.createNote({
        collection: "fixtures",
        relPath: "generated/duplicate-partial.txt",
        content: `${JSON.stringify({
          id: "one",
          title: "First record",
          text: "Zephyr ships on Friday",
        })}\n{ this line is not JSON\n`,
      })
    );

    const duplicated = await client.duplicateNote({
      ref: source.uri,
      name: "duplicate-partial.jsonl",
    });

    // Both facts, on the same channel, neither replacing the other.
    expect(
      duplicated.warnings.some((warning) =>
        warning.includes("resolves to no document")
      )
    ).toBe(true);
    const partial = duplicated.warnings.find((warning) =>
      warning.includes("Record import was partial")
    );
    expect(partial).toContain(
      "rejected by the adapter/jsonl adapter and NOT indexed"
    );
    expect(partial).toContain("(1 accepted)");
    // DISCRIMINATING against 386aa65d: the warning ended "See the sync
    // result's recordImport.failures", and a `GnoDuplicateNoteResult` is a
    // uri/relPath/warnings triple - there is no sync result on it, so the
    // caller was told records were dropped and sent to a field it cannot
    // reach. It now says the failures are not on this response, and names the
    // re-sync that does print them.
    expect(partial).not.toContain("recordImport.failures");
    expect(partial).toContain(
      "This response does not carry the per-record failures"
    );
    expect(partial).toContain("gno update --verbose");
  });

  test("multi-gets several documents", async () => {
    const result = await client.multiGet([
      "fixtures/authentication.md",
      "fixtures/database-queries.md",
    ]);
    expect(result.documents.length).toBe(2);
    expect(result.skipped.length).toBe(0);
  });

  test("matches CLI search totals for a representative flow", async () => {
    const sdkResult = await client.search("JWT token", { limit: 5 });
    await cli("init", fixturesDir, "--name", "fixtures");
    await cli("context", "add", "/", "Global guidance");
    await cli("context", "add", "fixtures:", "Fixture guidance");
    await cli(
      "context",
      "add",
      "gno://fixtures/authentication.md",
      "Authentication guidance"
    );
    await cli("update");
    const { code, stdout } = await cli(
      "search",
      "JWT token",
      "-n",
      "5",
      "--json"
    );
    expect(code).toBe(0);
    const cliResult = JSON.parse(stdout) as SearchResults;
    expect(cliResult.results.length).toBe(sdkResult.results.length);
    expect(cliResult.results[0]?.uri).toBe(sdkResult.results[0]?.uri);
    expect(cliResult.results[0]?.context).toBe(sdkResult.results[0]?.context);
    expect(cliResult.results[0]).toMatchObject({
      uri: "gno://fixtures/authentication.md",
      context: "Global guidance\n\nFixture guidance\n\nAuthentication guidance",
    });
  });

  test("closes cleanly and rejects further calls", async () => {
    const local = await createGnoClient({
      config: client.config,
      dbPath: join(testDir, "data", "index-sdk-close.sqlite"),
      downloadPolicy: { offline: false, allowDownload: false },
    });
    await local.update();
    await local.close();
    expect(local.isOpen()).toBe(false);
    let error: unknown;
    try {
      await local.search("JWT token");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("closed");
  });
});
