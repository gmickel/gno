/**
 * Chunker tests.
 * @module test/ingestion/chunker.test
 */

import { describe, expect, test } from 'bun:test';
import { MarkdownChunker } from '../../src/ingestion/chunker';

describe('MarkdownChunker', () => {
  const chunker = new MarkdownChunker();

  test('returns empty array for empty input', () => {
    const chunks = chunker.chunk('');
    expect(chunks).toEqual([]);
  });

  test('returns empty array for null-ish input', () => {
    const chunks = chunker.chunk(null as unknown as string);
    expect(chunks).toEqual([]);
  });

  test('creates single chunk for small content', () => {
    const text = 'Hello, world!';
    const chunks = chunker.chunk(text);

    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    expect(chunk).toBeDefined();
    expect(chunk?.seq).toBe(0);
    expect(chunk?.pos).toBe(0);
    expect(chunk?.text).toBe(text);
    expect(chunk?.startLine).toBe(1);
    expect(chunk?.endLine).toBe(1);
  });

  test('tracks line numbers correctly', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const chunks = chunker.chunk(text);

    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    expect(chunk).toBeDefined();
    expect(chunk?.startLine).toBe(1);
    expect(chunk?.endLine).toBe(3);
  });

  test('creates multiple chunks for large content', () => {
    // Create content larger than maxChars (800 tokens * 4 = 3200 chars)
    const paragraph = 'This is a test paragraph. '.repeat(50); // ~1300 chars
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);

    // Check sequential numbering
    for (let i = 0; i < chunks.length; i += 1) {
      expect(chunks[i]?.seq).toBe(i);
    }
  });

  test('breaks at paragraph boundaries when possible', () => {
    // Create text where paragraph break falls within search window
    // maxChars = 3200, window = 320, so para break should be near 3200
    const para1 = 'A'.repeat(3100); // Just under target
    const para2 = 'B'.repeat(2000);
    const text = `${para1}\n\n${para2}`;

    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk should contain only As (text is preserved exactly including trailing newlines)
    // Chunk breaks AFTER the paragraph break (\n\n), so first chunk ends with those newlines
    const chunk0Text = chunks[0]?.text ?? '';
    expect(chunk0Text.includes('B')).toBe(false); // No Bs in first chunk
    expect(chunk0Text.trimEnd().endsWith('A')).toBe(true); // Ends with As before whitespace
  });

  test('respects overlap percentage', () => {
    // Create content that will definitely need multiple chunks
    const text = 'Word '.repeat(2000); // ~10000 chars

    const chunks = chunker.chunk(text, {
      maxTokens: 800,
      overlapPercent: 0.15,
    });
    expect(chunks.length).toBeGreaterThan(2);

    // Check that chunks overlap (second chunk starts before first ends conceptually)
    // The pos of chunk 2 should be less than end of chunk 1 content
    const chunk0 = chunks[0];
    const chunk1 = chunks[1];
    expect(chunk0).toBeDefined();
    expect(chunk1).toBeDefined();
    if (chunk0 && chunk1) {
      const chunk0EndPos = chunk0.pos + chunk0.text.length;
      expect(chunk1.pos).toBeLessThan(chunk0EndPos);
    }
  });

  test('uses document language hint when provided', () => {
    const text = 'Hello, this is some test content.';
    const chunks = chunker.chunk(text, undefined, 'fr');

    expect(chunks[0]?.language).toBe('fr');
  });

  test('detects language when no hint provided', () => {
    // English text
    const text =
      'The quick brown fox jumps over the lazy dog. This is a test of the language detection system.';
    const chunks = chunker.chunk(text);

    // Should detect as English or null (short text)
    expect(chunks[0]?.language === 'en' || chunks[0]?.language === null).toBe(
      true
    );
  });

  test('tokenCount is null for char-based chunking', () => {
    const text = 'Hello, world!';
    const chunks = chunker.chunk(text);

    expect(chunks[0]?.tokenCount).toBe(null);
  });

  test('handles content with only whitespace', () => {
    const text = '   \n\n   \t   ';
    const chunks = chunker.chunk(text);

    // Trimmed to empty, should return empty
    expect(chunks).toEqual([]);
  });

  test('preserves chunk text exactly (no trimming)', () => {
    // Text is preserved exactly to maintain accurate pos/line mappings
    // and preserve Markdown semantics like indented code blocks
    const text = '  Hello, world!  \n';
    const chunks = chunker.chunk(text);

    expect(chunks[0]?.text).toBe(text);
    expect(chunks[0]?.pos).toBe(0);
  });
});
