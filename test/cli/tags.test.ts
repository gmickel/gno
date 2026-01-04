/**
 * Tests for gno tags command implementation.
 *
 * @module test/cli/tags
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

// ─────────────────────────────────────────────────────────────────────────────
// Test Environment Setup
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let collectionDir: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Global Setup/Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create isolated test environment
  testDir = join(tmpdir(), `gno-tags-test-${Date.now()}`);
  collectionDir = join(testDir, "docs");

  await mkdir(collectionDir, { recursive: true });

  // Create test documents with tags in frontmatter
  await writeFile(
    join(collectionDir, "doc1.md"),
    `---
title: Document 1
tags:
  - javascript
  - testing
---

# Document 1

Test content for JavaScript testing.
`
  );

  await writeFile(
    join(collectionDir, "doc2.md"),
    `---
title: Document 2
tags: [python, data-science]
---

# Document 2

Python data science content.
`
  );

  await writeFile(
    join(collectionDir, "doc3.md"),
    `---
title: Document 3
tags: javascript, web
---

# Document 3

JavaScript web development.
`
  );

  // Set isolated environment
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");

  // Initialize and index
  await cli("init", collectionDir, "--name", "docs");
  await cli("update");
}, 30_000);

afterAll(async () => {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
});

// ─────────────────────────────────────────────────────────────────────────────
// Tags List Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno tags list", () => {
  test("lists all tags in terminal format", async () => {
    const { code, stdout } = await cli("tags", "list");

    expect(code).toBe(0);
    expect(stdout).toContain("javascript");
    expect(stdout).toContain("testing");
    expect(stdout).toContain("python");
    expect(stdout).toContain("data-science");
    expect(stdout).toContain("web");
  });

  test("lists tags in JSON format", async () => {
    const { code, stdout } = await cli("tags", "list", "--json");

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.tags).toBeDefined();
    expect(data.tags.length).toBeGreaterThanOrEqual(5);

    const tagNames = data.tags.map((t: { tag: string }) => t.tag);
    expect(tagNames).toContain("javascript");
    expect(tagNames).toContain("python");
  });

  test("lists tags in Markdown format", async () => {
    const { code, stdout } = await cli("tags", "list", "--md");

    expect(code).toBe(0);
    expect(stdout).toContain("# Tags");
    expect(stdout).toContain("| Tag | Documents |");
    expect(stdout).toContain("`javascript`");
  });

  test("filters tags by prefix", async () => {
    const { code, stdout } = await cli(
      "tags",
      "list",
      "--prefix",
      "java",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);

    for (const t of data.tags) {
      expect(t.tag.startsWith("java")).toBe(true);
    }
  });

  test("shows tag counts", async () => {
    const { code, stdout } = await cli("tags", "list", "--json");

    expect(code).toBe(0);
    const data = JSON.parse(stdout);

    // javascript appears in 2 docs
    const jsTag = data.tags.find(
      (t: { tag: string }) => t.tag === "javascript"
    );
    expect(jsTag).toBeDefined();
    expect(jsTag.count).toBe(2);
  });

  test("defaults to list subcommand", async () => {
    const { code, stdout } = await cli("tags");

    expect(code).toBe(0);
    expect(stdout).toContain("javascript");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tags Add Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno tags add", () => {
  test("adds new tag to document by docid", async () => {
    // First get a docid
    const { stdout: lsOutput } = await cli("ls", "--json");
    const docs = JSON.parse(lsOutput);
    const docid = docs.documents[0].docid;

    const { code, stdout } = await cli("tags", "add", docid, "new-tag");

    expect(code).toBe(0);
    expect(stdout).toContain("Added tag");
    expect(stdout).toContain("new-tag");
  });

  test("adds tag to document by URI", async () => {
    const { code, stdout } = await cli(
      "tags",
      "add",
      "gno://docs/doc1.md",
      "uri-added-tag"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Added tag");
    expect(stdout).toContain("uri-added-tag");
  });

  test("normalizes tag to lowercase", async () => {
    const { code, stdout } = await cli(
      "tags",
      "add",
      "gno://docs/doc1.md",
      "UPPERCASE-TAG"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("uppercase-tag");
  });

  test("rejects invalid tag characters", async () => {
    const { code, stderr } = await cli(
      "tags",
      "add",
      "gno://docs/doc1.md",
      "invalid tag!"
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid tag");
  });

  test("succeeds if tag already exists", async () => {
    // javascript already exists on doc1
    const { code, stdout } = await cli(
      "tags",
      "add",
      "gno://docs/doc1.md",
      "javascript"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Added tag");
  });

  test("errors on nonexistent document", async () => {
    const { code, stderr } = await cli("tags", "add", "nonexistent-doc", "tag");

    expect(code).toBe(1);
    expect(stderr).toContain("Document not found");
  });

  test("returns JSON output", async () => {
    const { code, stdout } = await cli(
      "tags",
      "add",
      "gno://docs/doc2.md",
      "json-test-tag",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.tag).toBe("json-test-tag");
    expect(data.docid).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tags Remove Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno tags rm", () => {
  test("removes user-added tag", async () => {
    // First add a tag
    await cli("tags", "add", "gno://docs/doc3.md", "removable-tag");

    // Then remove it
    const { code, stdout } = await cli(
      "tags",
      "rm",
      "gno://docs/doc3.md",
      "removable-tag"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Removed tag");
    expect(stdout).toContain("removable-tag");
  });

  test("errors if tag not found on document", async () => {
    const { code, stderr } = await cli(
      "tags",
      "rm",
      "gno://docs/doc1.md",
      "nonexistent-tag"
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Tag not found");
  });

  test("errors on nonexistent document", async () => {
    const { code, stderr } = await cli("tags", "rm", "nonexistent-doc", "tag");

    expect(code).toBe(1);
    expect(stderr).toContain("Document not found");
  });

  test("returns JSON output", async () => {
    // First add a tag
    await cli("tags", "add", "gno://docs/doc2.md", "rm-json-tag");

    const { code, stdout } = await cli(
      "tags",
      "rm",
      "gno://docs/doc2.md",
      "rm-json-tag",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.tag).toBe("rm-json-tag");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tag Filtering in Search Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("search with tag filters", () => {
  test("--tags-all filters to docs with all specified tags", async () => {
    const { code, stdout } = await cli(
      "search",
      "content",
      "--tags-all",
      "javascript,testing"
    );

    expect(code).toBe(0);
    // Only doc1 has both javascript and testing
    expect(stdout).toContain("doc1.md");
    expect(stdout).not.toContain("doc3.md");
  });

  test("--tags-any filters to docs with any specified tag", async () => {
    const { code, stdout } = await cli(
      "search",
      "content",
      "--tags-any",
      "python,testing"
    );

    expect(code).toBe(0);
    // doc1 has testing, doc2 has python
    expect(stdout).toContain("doc1.md");
    expect(stdout).toContain("doc2.md");
  });

  test("tag filter with no matches returns empty", async () => {
    const { code, stdout } = await cli(
      "search",
      "content",
      "--tags-all",
      "nonexistent-tag"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("No results found");
  });
});
