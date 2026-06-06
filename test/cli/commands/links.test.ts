/**
 * Tests for gno links, backlinks, and similar command implementations.
 *
 * @module test/cli/commands/links
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../../src/cli/run";
import { safeRm } from "../../helpers/cleanup";

// ─────────────────────────────────────────────────────────────────────────────
// Test Environment Setup
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let notesDir: string;
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
  testDir = join(tmpdir(), `gno-links-test-${Date.now()}`);
  notesDir = join(testDir, "notes");

  await mkdir(notesDir, { recursive: true });

  // Create source document with links
  await writeFile(
    join(notesDir, "source.md"),
    `---
title: Source Document
---

# Source Document

This document contains various links.

Here is a [[wiki link]] to another document.

And a [[Target Note|display text]] with custom display text.

Also a [markdown link](./target.md) to target.

Plus a [relative link](other/deep.md) and [[Other Collection:external]] cross-collection link.
`
  );

  // Create target document (for wiki link resolution)
  await writeFile(
    join(notesDir, "wiki link.md"),
    `---
title: Wiki Link
---

# Wiki Link Target

This is the target of a wiki link.
`
  );

  // Create target note (for piped wiki link)
  await writeFile(
    join(notesDir, "target note.md"),
    `---
title: Target Note
---

# Target Note

This document is linked from source with display text.
`
  );

  // Create markdown target
  await writeFile(
    join(notesDir, "target.md"),
    `---
title: Target Document
---

# Target Document

This document is linked via markdown.
`
  );

  // Create deep nested doc
  await mkdir(join(notesDir, "other"), { recursive: true });
  await writeFile(
    join(notesDir, "other/deep.md"),
    `---
title: Deep Document
---

# Deep Nested Document

Linked from source with relative path.
`
  );

  // Create document with no links
  await writeFile(
    join(notesDir, "isolated.md"),
    `---
title: Isolated Document
---

# Isolated Document

This document has no links to or from it.
`
  );

  // Set isolated environment
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");

  // Initialize and index
  await cli("init", notesDir, "--name", "notes");
  await cli("update");
}, 30_000);

afterAll(async () => {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
});

// ─────────────────────────────────────────────────────────────────────────────
// Links List Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno links list", () => {
  test("lists outgoing links from document by URI", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("wiki");
    expect(stdout).toContain("markdown");
  });

  test("returns JSON output with link details", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.links).toBeDefined();
    expect(data.links.length).toBeGreaterThan(0);
    expect(data.meta.totalLinks).toBeGreaterThan(0);

    // Check link structure
    const link = data.links[0];
    expect(link.linkType).toBeDefined();
    expect(link.targetRef).toBeDefined();
    expect(link.startLine).toBeGreaterThan(0);
  });

  test("filters by link type (wiki)", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--type",
      "wiki",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    for (const link of data.links) {
      expect(link.linkType).toBe("wiki");
    }
  });

  test("filters by link type (markdown)", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--type",
      "markdown",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    for (const link of data.links) {
      expect(link.linkType).toBe("markdown");
    }
  });

  test("shows resolved status for links", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);

    // At least some links should be resolved
    const resolved = data.links.filter(
      (l: { resolved: boolean }) => l.resolved
    );
    expect(resolved.length).toBeGreaterThan(0);
    expect(data.meta.resolvedCount).toBeGreaterThan(0);
  });

  test("returns markdown format", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--md"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("# Links from");
    expect(stdout).toContain("| TargetRef | Text | Type | Line | Resolved |");
  });

  test("returns empty for document with no links", async () => {
    const { code, stdout } = await cli(
      "links",
      "list",
      "gno://notes/isolated.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.links).toEqual([]);
    expect(data.meta.totalLinks).toBe(0);
  });

  test("errors on nonexistent document", async () => {
    const { code, stderr } = await cli("links", "list", "notes/nonexistent.md");

    expect(code).toBe(1);
    expect(stderr).toContain("Document not found");
  });

  test("errors on invalid ref format", async () => {
    const { code, stderr } = await cli("links", "list", "nonexistent-doc");

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid ref format");
  });

  test("defaults to list subcommand", async () => {
    const { code, stdout } = await cli("links", "gno://notes/source.md");

    expect(code).toBe(0);
    expect(stdout).toContain("links");
  });

  test("rejects invalid link type", async () => {
    const { code, stderr } = await cli(
      "links",
      "list",
      "gno://notes/source.md",
      "--type",
      "invalid"
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid link type");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backlinks Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("gno backlinks", () => {
  test("lists documents linking to target", async () => {
    // Use target.md which has a markdown link from source.md
    const { code, stdout } = await cli("backlinks", "gno://notes/target.md");

    expect(code).toBe(0);
    // source.md (with title "Source Document") links to target.md
    expect(stdout).toContain("Source Document");
  });

  test("returns JSON output with backlink details", async () => {
    const { code, stdout } = await cli(
      "backlinks",
      "gno://notes/target.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.backlinks).toBeDefined();
    expect(data.meta.totalBacklinks).toBeDefined();

    if (data.backlinks.length > 0) {
      const backlink = data.backlinks[0];
      expect(backlink.sourceDocid).toBeDefined();
      expect(backlink.sourceUri).toBeDefined();
      expect(backlink.startLine).toBeGreaterThan(0);
    }
  });

  test("returns markdown format", async () => {
    const { code, stdout } = await cli(
      "backlinks",
      "gno://notes/target.md",
      "--md"
    );

    expect(code).toBe(0);
    expect(stdout).toContain("# Backlinks to");
    expect(stdout).toContain("| Source | Line | Link Text |");
  });

  test("returns empty for document with no backlinks", async () => {
    const { code, stdout } = await cli(
      "backlinks",
      "gno://notes/source.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout);
    // source.md has links OUT but nothing links TO it
    expect(data.meta.totalBacklinks).toBe(0);
  });

  test("errors on nonexistent document", async () => {
    const { code, stderr } = await cli("backlinks", "notes/nonexistent.md");

    expect(code).toBe(1);
    expect(stderr).toContain("Document not found");
  });

  test("errors on invalid ref format", async () => {
    const { code, stderr } = await cli("backlinks", "nonexistent-doc");

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid ref format");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Similar Tests (requires embeddings)
// ─────────────────────────────────────────────────────────────────────────────

describe("gno similar", () => {
  test("errors when no embeddings exist", async () => {
    // We haven't run gno embed, so this should fail gracefully
    const { code, stderr } = await cli("similar", "gno://notes/source.md");

    // Should error because no embeddings (validation error = exit code 1)
    expect(code).toBe(1);
    expect(stderr).toContain("embedding");
  });

  test("errors on nonexistent document", async () => {
    const { code, stderr } = await cli("similar", "notes/nonexistent.md");

    expect(code).toBe(1);
    expect(stderr).toContain("Document not found");
  });

  test("errors on invalid ref format", async () => {
    const { code, stderr } = await cli("similar", "nonexistent-doc");

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid ref format");
  });

  test("validates threshold range", async () => {
    const { code, stderr } = await cli(
      "similar",
      "gno://notes/source.md",
      "--threshold",
      "1.5"
    );

    expect(code).toBe(1);
    expect(stderr).toContain("threshold");
  });
});

describe("gno graph traversal", () => {
  test("runs bounded typed-edge graph query", async () => {
    const { code, stdout } = await cli(
      "graph",
      "query",
      "gno://notes/source.md",
      "--direction",
      "out",
      "--edge-type",
      "mentions",
      "--max-depth",
      "1",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout) as {
      schemaVersion: string;
      root: { uri: string };
      nodes: Array<{ uri: string; depth: number; graphHints: string[] }>;
      edges: Array<{ edgeType: string; depth: number }>;
      meta: { direction: string; edgeType: string; truncated: boolean };
    };
    expect(data.schemaVersion).toBe("1.0");
    expect(data.root.uri).toBe("gno://notes/source.md");
    expect(data.meta).toMatchObject({
      direction: "out",
      edgeType: "mentions",
      truncated: false,
    });
    expect(data.nodes.some((node) => node.depth === 1)).toBe(true);
    expect(data.edges.every((edge) => edge.edgeType === "mentions")).toBe(true);
  });

  test("returns neighbors for a graph ref", async () => {
    const { code, stdout } = await cli(
      "graph",
      "--neighbors",
      "gno://notes/source.md",
      "--direction",
      "out",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout) as {
      neighbors: Array<{ node: { uri: string }; direction: string }>;
      meta: { mode: string; direction: string; totalNeighbors: number };
    };
    expect(data.meta).toMatchObject({
      mode: "neighbors",
      direction: "out",
    });
    expect(data.meta.totalNeighbors).toBeGreaterThan(0);
    expect(
      data.neighbors.some((item) => item.node.uri.includes("target"))
    ).toBe(true);
  });

  test("returns a graph path payload", async () => {
    const { code, stdout } = await cli(
      "graph",
      "--from",
      "gno://notes/source.md",
      "--to",
      "gno://notes/source.md",
      "--json"
    );

    expect(code).toBe(0);
    const data = JSON.parse(stdout) as {
      path: { nodes: Array<{ uri: string }>; edges: unknown[] };
      meta: { mode: string; found: boolean; hops: number };
    };
    expect(data.meta).toMatchObject({
      mode: "path",
      found: true,
      hops: 0,
    });
    expect(data.path.nodes[0]?.uri).toBe("gno://notes/source.md");
  });
});
