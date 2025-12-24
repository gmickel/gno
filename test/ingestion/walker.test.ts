/**
 * Walker tests.
 * @module test/ingestion/walker.test
 */

import { describe, expect, test } from 'bun:test';
// node:path - Bun has no path manipulation module
import { resolve } from 'node:path';
import { FileWalker } from '../../src/ingestion/walker';

const FIXTURES_ROOT = resolve(import.meta.dir, '../fixtures/walker');

/** ISO date string prefix regex */
const ISO_DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}T/;

describe('FileWalker', () => {
  const walker = new FileWalker();

  test('walks all files with ** pattern', async () => {
    const { entries, skipped } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: [],
      exclude: [],
      maxBytes: 10_000_000,
    });

    // Should find files but not in .git or node_modules by default pattern
    expect(entries.length).toBeGreaterThan(0);
    expect(skipped.length).toBe(0);
  });

  test('filters by include extensions', async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: ['.md'],
      exclude: ['.git', 'node_modules'],
      maxBytes: 10_000_000,
    });

    // Should only find .md files
    for (const entry of entries) {
      expect(entry.relPath.endsWith('.md')).toBe(true);
    }
    expect(entries.length).toBeGreaterThanOrEqual(2); // readme.md, guide.md, large.md
  });

  test('excludes directories', async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: [],
      exclude: ['.git', 'node_modules'],
      maxBytes: 10_000_000,
    });

    // Should not include files from excluded dirs
    for (const entry of entries) {
      expect(entry.relPath).not.toContain('.git');
      expect(entry.relPath).not.toContain('node_modules');
    }
  });

  test('skips files exceeding maxBytes', async () => {
    const { entries, skipped } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: ['.md'],
      exclude: ['.git', 'node_modules'],
      maxBytes: 100, // Very small limit
    });

    // large.md should be skipped
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((s) => s.reason === 'TOO_LARGE')).toBe(true);

    // Entries should only contain files <= 100 bytes
    for (const entry of entries) {
      expect(entry.size).toBeLessThanOrEqual(100);
    }
  });

  test('returns sorted entries by relPath', async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: [],
      exclude: ['.git', 'node_modules'],
      maxBytes: 10_000_000,
    });

    const paths = entries.map((e) => e.relPath);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  test('normalizes paths to POSIX format', async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: [],
      exclude: ['.git', 'node_modules'],
      maxBytes: 10_000_000,
    });

    for (const entry of entries) {
      expect(entry.relPath).not.toContain('\\');
    }
  });

  test('includes mtime as ISO string', async () => {
    const { entries } = await walker.walk({
      root: FIXTURES_ROOT,
      pattern: '**/*',
      include: ['.md'],
      exclude: ['.git', 'node_modules'],
      maxBytes: 10_000_000,
    });

    for (const entry of entries) {
      expect(entry.mtime).toMatch(ISO_DATE_PREFIX_REGEX);
    }
  });
});
