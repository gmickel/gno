/**
 * gno ls command smoke tests.
 * Tests CLI behavior via runCli().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

// ─────────────────────────────────────────────────────────────────────────────
// Top-level regex patterns
// ─────────────────────────────────────────────────────────────────────────────

const DOCID_TAB_PATTERN = /#[a-f0-9]+\t/;
const FILE_PROTOCOL_PATTERN = /#[a-f0-9]+,gno:\/\//;

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

let stdoutData: string;
let stderrData: string;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

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

const TEST_ROOT = join(tmpdir(), "gno-ls-smoke");
let testCounter = 0;

function getTestDir(): string {
  const dir = join(TEST_ROOT, `test-${Date.now()}-${testCounter}`);
  testCounter += 1;
  return dir;
}

async function setupTestEnv(testDir: string) {
  await mkdir(testDir, { recursive: true });
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
}

async function cleanupTestEnv(testDir: string) {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

async function setupTestWithContent(): Promise<string> {
  const testDir = getTestDir();
  await setupTestEnv(testDir);

  const docsDir = join(testDir, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "alpha.md"), "# Alpha");
  await writeFile(join(docsDir, "beta.md"), "# Beta");
  await writeFile(join(docsDir, "gamma.md"), "# Gamma");

  await cli("init", docsDir, "--name", "docs");
  await cli("update");

  return testDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// gno ls Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno ls smoke tests", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test("lists all documents", async () => {
    const { code, stdout } = await cli("ls");
    expect(code).toBe(0);
    expect(stdout).toMatch(DOCID_TAB_PATTERN);
    expect(stdout).toContain("gno://docs/");
  });

  test("filters by collection name", async () => {
    const { code, stdout } = await cli("ls", "docs", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents.length).toBe(3);
  });

  test("filters by URI prefix", async () => {
    const { code, stdout } = await cli("ls", "gno://docs/a", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents.length).toBe(1);
    expect(parsed.documents[0].uri).toContain("alpha");
  });

  test("--json returns structured output", async () => {
    const { code, stdout } = await cli("ls", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents).toBeDefined();
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.total).toBe(3);
    expect(parsed.meta.returned).toBe(3);
  });

  test("--files outputs file protocol", async () => {
    const { code, stdout } = await cli("ls", "--files");
    expect(code).toBe(0);
    expect(stdout).toMatch(FILE_PROTOCOL_PATTERN);
  });

  test("--md produces markdown table", async () => {
    const { code, stdout } = await cli("ls", "--md");
    expect(code).toBe(0);
    expect(stdout).toContain("# Documents");
    expect(stdout).toContain("| DocID |");
    expect(stdout).toContain("|-------|");
  });

  test("-n limits results", async () => {
    const { code, stdout } = await cli("ls", "-n", "2", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents.length).toBe(2);
    expect(parsed.meta.total).toBe(3);
    expect(parsed.meta.returned).toBe(2);
  });

  test("--offset skips results", async () => {
    const { code, stdout } = await cli("ls", "--offset", "2", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents.length).toBe(1);
    expect(parsed.meta.offset).toBe(2);
  });

  test("sorts by URI alphabetically", async () => {
    const { code, stdout } = await cli("ls", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const uris = parsed.documents.map((d: { uri: string }) => d.uri);
    const sorted = [...uris].sort((a, b) => a.localeCompare(b));
    expect(uris).toEqual(sorted);
  });
});

describe("gno ls empty index", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir, { recursive: true });
    await cli("init", docsDir, "--name", "docs");
    await cli("update");
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test("returns no documents message", async () => {
    const { code, stdout } = await cli("ls");
    expect(code).toBe(0);
    expect(stdout).toContain("No documents found");
  });
});

describe("gno ls scope validation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTestWithContent();
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  test("invalid gno:// scope exits 1", async () => {
    const { code, stderr } = await cli("ls", "gno://");
    expect(code).toBe(1);
    expect(stderr).toContain("Invalid scope");
  });

  test("gno://collection without trailing path exits 1", async () => {
    const { code, stderr } = await cli("ls", "gno://docs");
    expect(code).toBe(1);
    expect(stderr).toContain("trailing path");
  });
});

describe("gno ls --filter (typed metadata)", () => {
  let testDir: string;
  const source = "sp:drives/d1/items/i1";

  beforeEach(async () => {
    testDir = getTestDir();
    await setupTestEnv(testDir);
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir, { recursive: true });
    const page = (refs: string) =>
      `---\ngno:\n  metadata:\n    derived_from: ${refs}\n---\n\n# Page\n`;
    await writeFile(
      join(docsDir, "a.md"),
      page(`["${source}", "jira:PROJ-1"]`)
    );
    await writeFile(join(docsDir, "b.md"), page(`["sp:drives/d1/items/i2"]`));
    await writeFile(
      join(docsDir, "c.md"),
      page(`["jira:PROJ-1", "${source}"]`)
    );
    // Object members are invalid typed metadata: never matches a filter.
    await writeFile(
      join(docsDir, "d.md"),
      page(`[{ sys: sp, ref: "drives/d1/items/i1" }]`)
    );
    await writeFile(join(docsDir, "e.md"), "# No metadata\n");
    await cli("init", docsDir, "--name", "docs");
    await cli("update");
  });

  afterEach(async () => {
    await cleanupTestEnv(testDir);
  });

  const inFilter = (values: string[]) =>
    JSON.stringify({ op: "in", key: "derived_from", values });

  test("returns exactly the pages whose derived_from names the source", async () => {
    const { code, stdout } = await cli(
      "ls",
      "--json",
      "--filter",
      inFilter([source])
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.documents.map((d: { uri: string }) => d.uri)).toEqual([
      "gno://docs/a.md",
      "gno://docs/c.md",
    ]);
    expect(parsed.meta).toEqual({ total: 2, returned: 2, offset: 0 });
  });

  test("intersects with scope and paginates over matches", async () => {
    const { stdout } = await cli(
      "ls",
      "gno://docs/c",
      "--json",
      "--filter",
      inFilter([source])
    );
    expect(
      JSON.parse(stdout).documents.map((d: { uri: string }) => d.uri)
    ).toEqual(["gno://docs/c.md"]);

    const page = JSON.parse(
      (
        await cli(
          "ls",
          "--json",
          "--offset",
          "1",
          "--filter",
          inFilter([source])
        )
      ).stdout
    );
    expect(page.documents.map((d: { uri: string }) => d.uri)).toEqual([
      "gno://docs/c.md",
    ]);
    expect(page.meta.total).toBe(2);
  });

  test("invalid metadata never matches, even negated filters", async () => {
    const { stdout } = await cli(
      "ls",
      "--json",
      "--filter",
      JSON.stringify({ op: "exists", key: "derived_from", value: false })
    );
    expect(
      JSON.parse(stdout).documents.map((d: { uri: string }) => d.uri)
    ).toEqual(["gno://docs/e.md"]);
  });

  test("without --filter the listing is unchanged", async () => {
    const { stdout } = await cli("ls", "--json");
    expect(JSON.parse(stdout).meta.total).toBe(5);
  });

  test("malformed predicate is a validation error", async () => {
    const { code, stderr } = await cli("ls", "--filter", "{");
    expect(code).toBe(1);
    expect(stderr).toContain("filter:");
  });
});
