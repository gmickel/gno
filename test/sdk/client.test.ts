import {
  createDefaultConfig,
  createGnoClient,
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
