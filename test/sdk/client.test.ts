import {
  createDefaultConfig,
  createGnoClient,
  getRetrievalTraceMetadata,
  type GnoClient,
  type SearchResults,
} from "@gmickel/gno";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir } from "node:fs/promises";
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
  });

  test("lists indexed documents", async () => {
    const result = await client.list({ limit: 5 });
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.meta.total).toBeGreaterThan(0);
    expect(result.documents[0]?.uri.startsWith("gno://fixtures/")).toBe(true);
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

  test("creates notes with folder context and preset scaffolds", async () => {
    const result = await client.createNote({
      collection: "fixtures",
      title: "SDK Project",
      folderPath: "generated",
      presetId: "project-note",
    });

    expect(result.relPath).toBe("generated/sdk-project.md");

    const created = await client.get("fixtures/generated/sdk-project.md");
    expect(created.content).toContain("## Goal");
    expect(created.content).toContain('category: "project"');
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
    const created = await client.createNote({
      collection: "fixtures",
      title: "Rename Me",
      folderPath: "generated",
      content: "# Rename Me\n",
    });
    const renamed = await client.renameNote({
      ref: created.uri,
      name: "renamed.md",
    });

    expect(renamed.relPath).toBe("generated/renamed.md");
  });

  test("moves notes through the SDK", async () => {
    const created = await client.createNote({
      collection: "fixtures",
      title: "Move Me",
      folderPath: "generated",
      content: "# Move Me\n",
    });
    const moved = await client.moveNote({
      ref: created.uri,
      folderPath: "generated/archive",
    });

    expect(moved.relPath).toBe("generated/archive/move-me.md");
  });

  test("duplicates notes through the SDK", async () => {
    const created = await client.createNote({
      collection: "fixtures",
      title: "Duplicate Me",
      folderPath: "generated",
      content: "# Duplicate Me\n",
    });
    const duplicated = await client.duplicateNote({
      ref: created.uri,
      folderPath: "generated/archive",
    });

    expect(duplicated.relPath).toBe("generated/archive/duplicate-me.md");
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
