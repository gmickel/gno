/**
 * Tests for model URI parsing.
 */

import { describe, expect, test } from 'bun:test';
import { parseModelUri, toNodeLlamaCppUri } from '../../src/llm/cache';

describe('parseModelUri', () => {
  describe('hf: scheme', () => {
    test('parses hf: with org/repo/file', () => {
      const result = parseModelUri('hf:BAAI/bge-m3-gguf/bge-m3-q4_k_m.gguf');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          scheme: 'hf',
          org: 'BAAI',
          repo: 'bge-m3-gguf',
          file: 'bge-m3-q4_k_m.gguf',
        });
      }
    });

    test('parses hf: with quantization shorthand', () => {
      const result = parseModelUri('hf:BAAI/bge-m3-gguf:Q4_K_M');
      expect(result.ok).toBe(true);
      if (result.ok && result.value.scheme === 'hf') {
        expect(result.value.org).toBe('BAAI');
        expect(result.value.repo).toBe('bge-m3-gguf');
        expect(result.value.quantization).toBe('Q4_K_M');
      }
    });

    test('parses hf: with nested org name', () => {
      const result = parseModelUri(
        'hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf'
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.value.scheme === 'hf') {
        expect(result.value.org).toBe('Qwen');
        expect(result.value.repo).toBe('Qwen2.5-0.5B-Instruct-GGUF');
        expect(result.value.file).toBe('qwen2.5-0.5b-instruct-q4_k_m.gguf');
      }
    });

    test('rejects invalid hf: format', () => {
      const result = parseModelUri('hf:invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Invalid hf: URI');
      }
    });

    test('rejects hf: without file extension', () => {
      const result = parseModelUri('hf:org/repo/noextension');
      expect(result.ok).toBe(false);
    });
  });

  describe('file: scheme', () => {
    test('parses file: with path', () => {
      const result = parseModelUri('file:/path/to/model.gguf');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          scheme: 'file',
          file: '/path/to/model.gguf',
        });
      }
    });

    test('parses absolute path without file: prefix', () => {
      const result = parseModelUri('/path/to/model.gguf');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          scheme: 'file',
          file: '/path/to/model.gguf',
        });
      }
    });

    test('rejects empty file path', () => {
      const result = parseModelUri('file:');
      expect(result.ok).toBe(false);
    });
  });

  describe('unknown scheme', () => {
    test('rejects unknown scheme', () => {
      const result = parseModelUri('http://example.com/model.gguf');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Unknown URI scheme');
      }
    });

    test('rejects relative path', () => {
      const result = parseModelUri('relative/path/model.gguf');
      expect(result.ok).toBe(false);
    });
  });
});

describe('toNodeLlamaCppUri', () => {
  test('converts hf: with file to HF format', () => {
    const uri = toNodeLlamaCppUri({
      scheme: 'hf',
      org: 'BAAI',
      repo: 'bge-m3-gguf',
      file: 'bge-m3-q4_k_m.gguf',
    });
    expect(uri).toBe('hf:BAAI/bge-m3-gguf/bge-m3-q4_k_m.gguf');
  });

  test('converts hf: with quantization shorthand', () => {
    const uri = toNodeLlamaCppUri({
      scheme: 'hf',
      org: 'BAAI',
      repo: 'bge-m3-gguf',
      file: '',
      quantization: 'Q4_K_M',
    });
    expect(uri).toBe('hf:BAAI/bge-m3-gguf:Q4_K_M');
  });

  test('converts file: to path', () => {
    const uri = toNodeLlamaCppUri({
      scheme: 'file',
      file: '/path/to/model.gguf',
    });
    expect(uri).toBe('/path/to/model.gguf');
  });
});
