/**
 * Walker tests.
 * @module test/ingestion/walker.test
 */

import { describe, expect, test } from "bun:test";
// node:path - Bun has no path manipulation module
import { resolve } from "node:path";

import { SUPPORTED_EXTENSIONS } from "../../src/converters/mime";
import { FileWalker } from "../../src/ingestion/walker";

const FIXTURES_ROOT = resolve(import.meta.dir, "../fixtures/walker");

/** ISO date string prefix regex */
const ISO_DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}T/;

describe("FileWalker", () => {
  const walker = new FileWalker();

  test("walks supported files with ** pattern", async () => {
    const { entries, skipped } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [], // Empty = fallback to SUPPORTED_EXTENSIONS
      exclude: [],
      maxBytes: 10_000_000,
    });

    // Should find supported files (.md, .txt, etc.)
    expect(entries.length).toBeGreaterThan(0);
    // Unsupported files (.ts, .js, etc.) are skipped
    expect(skipped.length).toBeGreaterThan(0);
    // All entries should have supported extensions
    for (const entry of entries) {
      const ext = entry.relPath.slice(entry.relPath.lastIndexOf("."));
      expect(SUPPORTED_EXTENSIONS).toContain(ext);
    }
  });

  test("filters by include extensions", async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [".md"],
      exclude: [".git", "node_modules"],
      maxBytes: 10_000_000,
    });

    // Should only find .md files
    for (const entry of entries) {
      expect(entry.relPath.endsWith(".md")).toBe(true);
    }
    expect(entries.length).toBeGreaterThanOrEqual(2); // readme.md, guide.md, large.md
  });

  test("excludes directories", async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [],
      exclude: [".git", "node_modules"],
      maxBytes: 10_000_000,
    });

    // Should not include files from excluded dirs
    for (const entry of entries) {
      expect(entry.relPath).not.toContain(".git");
      expect(entry.relPath).not.toContain("node_modules");
    }
  });

  test("skips files exceeding maxBytes", async () => {
    const { entries, skipped } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [".md"],
      exclude: [".git", "node_modules"],
      maxBytes: 100, // Very small limit
    });

    // large.md should be skipped
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((s) => s.reason === "TOO_LARGE")).toBe(true);

    // Entries should only contain files <= 100 bytes
    for (const entry of entries) {
      expect(entry.size).toBeLessThanOrEqual(100);
    }
  });

  test("returns sorted entries by relPath", async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [],
      exclude: [".git", "node_modules"],
      maxBytes: 10_000_000,
    });

    const paths = entries.map((e) => e.relPath);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  test("normalizes paths to POSIX format", async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [],
      exclude: [".git", "node_modules"],
      maxBytes: 10_000_000,
    });

    for (const entry of entries) {
      expect(entry.relPath).not.toContain("\\");
    }
  });

  test("includes mtime as ISO string", async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: "**/*",
      include: [".md"],
      exclude: [".git", "node_modules"],
      maxBytes: 10_000_000,
    });

    for (const entry of entries) {
      expect(entry.mtime).toMatch(ISO_DATE_PREFIX_REGEX);
    }
  });

  describe("empty include fallback to SUPPORTED_EXTENSIONS", () => {
    test("uses SUPPORTED_EXTENSIONS when include is empty", async () => {
      const { entries, skipped } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: [], // Empty = fallback to SUPPORTED_EXTENSIONS
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      // Should only find supported extensions (.md, .txt, .pdf, etc.)
      for (const entry of entries) {
        const ext = entry.relPath.slice(entry.relPath.lastIndexOf("."));
        expect(SUPPORTED_EXTENSIONS).toContain(ext);
      }

      // .ts files should be skipped (not supported)
      const tsSkipped = skipped.filter((s) => s.relPath.endsWith(".ts"));
      expect(tsSkipped.length).toBeGreaterThan(0);
      expect(tsSkipped.every((s) => s.reason === "EXCLUDED")).toBe(true);
    });

    test("finds .md and .txt files with empty include", async () => {
      const { entries } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: [], // Empty = fallback
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      const mdFiles = entries.filter((e) => e.relPath.endsWith(".md"));
      const txtFiles = entries.filter((e) => e.relPath.endsWith(".txt"));

      expect(mdFiles.length).toBeGreaterThan(0);
      expect(txtFiles.length).toBeGreaterThan(0);
    });

    test("skips unsupported extensions with empty include", async () => {
      const { entries, skipped } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: [], // Empty = fallback
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      // No .ts or .js files in entries
      const codeFiles = entries.filter(
        (e) => e.relPath.endsWith(".ts") || e.relPath.endsWith(".js")
      );
      expect(codeFiles).toEqual([]);

      // They should be in skipped
      const skippedCode = skipped.filter(
        (s) => s.relPath.endsWith(".ts") || s.relPath.endsWith(".js")
      );
      expect(skippedCode.length).toBeGreaterThan(0);
    });

    test("explicit include overrides fallback", async () => {
      // When include is explicitly set, use those extensions (not fallback)
      const { entries, skipped } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: [".ts"], // Explicit: only .ts files
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      // Should find .ts files
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.relPath.endsWith(".ts")).toBe(true);
      }

      // .md files should be skipped when explicit include is set
      const mdSkipped = skipped.filter((s) => s.relPath.endsWith(".md"));
      expect(mdSkipped.length).toBeGreaterThan(0);
    });

    test("include without leading dot is normalized", async () => {
      // "md" should work the same as ".md"
      const { entries } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: ["md", "txt"], // Without dots
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      // Should find .md and .txt files
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const ext = entry.relPath.slice(entry.relPath.lastIndexOf("."));
        expect([".md", ".txt"]).toContain(ext);
      }
    });

    test("extensionless files are always excluded", async () => {
      const { entries, skipped } = await walker.walk({
        root: FIXTURES_ROOT,
        pattern: "**/*",
        include: [], // Empty = fallback
        exclude: [".git", "node_modules"],
        maxBytes: 10_000_000,
      });

      // Extensionless files like Makefile, LICENSE should be skipped
      const extensionlessSkipped = skipped.filter((s) => {
        const lastDot = s.relPath.lastIndexOf(".");
        const lastSlash = s.relPath.lastIndexOf("/");
        // No dot, or dot is before last slash (directory dot, not extension)
        return lastDot === -1 || lastDot < lastSlash;
      });
      expect(extensionlessSkipped.length).toBeGreaterThan(0);

      // No extensionless files in entries
      const extensionlessEntries = entries.filter((e) => {
        const lastDot = e.relPath.lastIndexOf(".");
        const lastSlash = e.relPath.lastIndexOf("/");
        return lastDot === -1 || lastDot < lastSlash;
      });
      expect(extensionlessEntries).toEqual([]);
    });
  });
});
