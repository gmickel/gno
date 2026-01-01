/**
 * Tests for contextual embedding formatting functions.
 *
 * @module test/pipeline/contextual
 */

import { describe, expect, test } from 'bun:test';
import {
  extractTitle,
  formatDocForEmbedding,
  formatQueryForEmbedding,
} from '../../src/pipeline/contextual';

describe('formatQueryForEmbedding', () => {
  test('adds search task prefix', () => {
    const formatted = formatQueryForEmbedding('how to deploy');
    expect(formatted).toBe('task: search result | query: how to deploy');
  });

  test('handles empty query', () => {
    const formatted = formatQueryForEmbedding('');
    expect(formatted).toBe('task: search result | query: ');
  });

  test('preserves query with special characters', () => {
    const formatted = formatQueryForEmbedding('what is async/await?');
    expect(formatted).toBe('task: search result | query: what is async/await?');
  });
});

describe('formatDocForEmbedding', () => {
  test('adds title and text prefix', () => {
    const formatted = formatDocForEmbedding('Some content', 'My Title');
    expect(formatted).toBe('title: My Title | text: Some content');
  });

  test('handles missing title', () => {
    const formatted = formatDocForEmbedding('Some content');
    expect(formatted).toBe('title: none | text: Some content');
  });

  test('handles undefined title', () => {
    const formatted = formatDocForEmbedding('Some content', undefined);
    expect(formatted).toBe('title: none | text: Some content');
  });

  test('handles empty title', () => {
    const formatted = formatDocForEmbedding('Some content', '');
    expect(formatted).toBe('title: none | text: Some content');
  });

  test('trims whitespace from title', () => {
    const formatted = formatDocForEmbedding('Content', '  My Title  ');
    expect(formatted).toBe('title: My Title | text: Content');
  });

  test('handles whitespace-only title', () => {
    const formatted = formatDocForEmbedding('Content', '   ');
    expect(formatted).toBe('title: none | text: Content');
  });
});

describe('extractTitle', () => {
  test('extracts h1 heading', () => {
    const content = '# My Document\n\nSome content here.';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('My Document');
  });

  test('extracts h2 heading when no h1', () => {
    const content = '## Section Title\n\nSome content here.';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('Section Title');
  });

  test('falls back to filename without extension', () => {
    const content = 'Just plain text without headings.';
    const title = extractTitle(content, 'my-document.md');
    expect(title).toBe('my-document');
  });

  test('handles path in filename', () => {
    const content = 'No headings here.';
    const title = extractTitle(content, '/path/to/document.md');
    expect(title).toBe('document');
  });

  test('skips generic "Notes" title and uses next heading', () => {
    const content = '# Notes\n\n## Actual Topic\n\nContent here.';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('Actual Topic');
  });

  test('uses "Notes" if no alternative heading', () => {
    const content = '# Notes\n\nJust some notes without other headings.';
    const title = extractTitle(content, 'fallback.md');
    // Falls back to Notes since no ## heading exists
    expect(title).toBe('Notes');
  });

  test('handles heading with special characters', () => {
    const content = '# API Reference (v2.0)\n\nDocumentation.';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('API Reference (v2.0)');
  });

  test('handles heading mid-document', () => {
    const content = 'Some preamble text.\n\n# Document Title\n\nContent.';
    const title = extractTitle(content, 'fallback.md');
    expect(title).toBe('Document Title');
  });
});
