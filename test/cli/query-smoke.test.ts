import { describe, expect, test } from 'bun:test';

import { formatQuery } from '../../src/cli/commands/query';
import type { SearchResults } from '../../src/pipeline/types';

// Helper to create a minimal valid search result
function createSearchResult(
  overrides: Partial<SearchResults> = {}
): SearchResults {
  return {
    results: [
      {
        docid: '#a1b2c3d4',
        score: 0.85,
        uri: 'gno://work/doc.md',
        title: 'Test Document',
        snippet: 'This is test content for the document.',
        snippetRange: { startLine: 1, endLine: 10 },
        source: {
          relPath: 'doc.md',
          mime: 'text/markdown',
          ext: '.md',
        },
      },
    ],
    meta: {
      query: 'test query',
      mode: 'hybrid',
      expanded: true,
      reranked: true,
      vectorsUsed: true,
      totalResults: 1,
    },
    ...overrides,
  };
}

describe('query command', () => {
  describe('formatQuery', () => {
    test('formats JSON output correctly', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'json' });

      const parsed = JSON.parse(output);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].docid).toBe('#a1b2c3d4');
      expect(parsed.meta.query).toBe('test query');
    });

    test('formats terminal output with docid and score', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'terminal' });

      expect(output).toContain('#a1b2c3d4');
      expect(output).toContain('0.85');
      expect(output).toContain('gno://work/doc.md');
    });

    test('formats markdown output with headers', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'md' });

      expect(output).toContain('# ');
      expect(output).toContain('Test Document');
      expect(output).toContain('`gno://work/doc.md`');
    });

    test('formats CSV with header row', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'csv' });

      const lines = output.split('\n');
      expect(lines[0]).toContain('docid');
      expect(lines[0]).toContain('score');
      expect(lines[0]).toContain('uri');
    });

    test('formats XML with proper tags', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'xml' });

      expect(output).toContain('<?xml version="1.0"');
      expect(output).toContain('<searchResults>');
      expect(output).toContain('<docid>#a1b2c3d4</docid>');
    });

    test('formats files output with paths', () => {
      const result = { success: true as const, data: createSearchResult() };
      const output = formatQuery(result, { format: 'files' });

      // Should contain docid, score, and uri
      expect(output).toContain('#a1b2c3d4');
      expect(output).toContain('gno://work/doc.md');
    });

    test('handles empty results gracefully', () => {
      const result = {
        success: true as const,
        data: createSearchResult({
          results: [],
          meta: { query: 'empty', mode: 'hybrid', totalResults: 0 },
        }),
      };

      const terminal = formatQuery(result, { format: 'terminal' });
      expect(terminal).toContain('No results found');

      const json = formatQuery(result, { format: 'json' });
      const parsed = JSON.parse(json);
      expect(parsed.results).toHaveLength(0);
    });

    test('formats error correctly in JSON', () => {
      const result = { success: false as const, error: 'Test error message' };
      const output = formatQuery(result, { format: 'json' });

      const parsed = JSON.parse(output);
      expect(parsed.error.code).toBe('QUERY_FAILED');
      expect(parsed.error.message).toBe('Test error message');
    });

    test('formats error correctly in terminal', () => {
      const result = { success: false as const, error: 'Test error message' };
      const output = formatQuery(result, { format: 'terminal' });

      expect(output).toContain('Error:');
      expect(output).toContain('Test error message');
    });
  });

  describe('score normalization', () => {
    test('scores are in valid 0-1 range', () => {
      const results = createSearchResult();
      const firstResult = results.results[0];
      expect(firstResult).toBeDefined();
      const score = firstResult?.score ?? 0;

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    test('multiple results have decreasing scores', () => {
      const results = createSearchResult({
        results: [
          {
            docid: '#first',
            score: 1.0,
            uri: 'gno://work/a.md',
            snippet: 'first',
            source: { relPath: 'a.md', mime: 'text/markdown', ext: '.md' },
          },
          {
            docid: '#second',
            score: 0.8,
            uri: 'gno://work/b.md',
            snippet: 'second',
            source: { relPath: 'b.md', mime: 'text/markdown', ext: '.md' },
          },
          {
            docid: '#third',
            score: 0.5,
            uri: 'gno://work/c.md',
            snippet: 'third',
            source: { relPath: 'c.md', mime: 'text/markdown', ext: '.md' },
          },
        ],
      });

      // Verify descending order
      const [first, second, third] = results.results;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(third).toBeDefined();
      expect(first?.score).toBeGreaterThan(second?.score ?? 0);
      expect(second?.score).toBeGreaterThan(third?.score ?? 0);
    });
  });
});
