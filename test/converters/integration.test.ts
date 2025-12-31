/**
 * Integration tests for document conversion with real fixtures.
 * Tests PDF, DOCX, XLSX, PPTX conversion end-to-end.
 */

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultMimeDetector } from '../../src/converters/mime';
import { createDefaultRegistry } from '../../src/converters/registry';
import type { ConvertInput } from '../../src/converters/types';
import { DEFAULT_LIMITS } from '../../src/converters/types';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures/conversion');

async function loadFixture(
  subdir: string,
  filename: string
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const filePath = join(FIXTURES_DIR, subdir, filename);
  const bytes = await readFile(filePath);
  const detector = getDefaultMimeDetector();
  const detection = detector.detect(filePath, new Uint8Array(bytes));
  return {
    bytes: new Uint8Array(bytes),
    ext: detection.ext,
    mime: detection.mime,
  };
}

function makeInput(
  fixture: { bytes: Uint8Array; ext: string; mime: string },
  relativePath: string
): ConvertInput {
  return {
    sourcePath: join(FIXTURES_DIR, relativePath),
    relativePath,
    collection: 'test',
    bytes: fixture.bytes,
    mime: fixture.mime,
    ext: fixture.ext,
    limits: DEFAULT_LIMITS,
  };
}

describe('Document Conversion Integration', () => {
  describe('PDF conversion', () => {
    test('converts sample.pdf to markdown', async () => {
      const fixture = await loadFixture('pdf', 'sample.pdf');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pdf/sample.pdf');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.markdown).toContain('GNO Test Document');
        expect(result.value.markdown).toContain('PDF Conversion Test');
        expect(result.value.markdown).toContain('quick brown fox');
        expect(result.value.meta.converterId).toBe('adapter/markitdown-ts');
      }
    });

    test('extracts text content from PDF', async () => {
      const fixture = await loadFixture('pdf', 'sample.pdf');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pdf/sample.pdf');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should contain key features text
        expect(result.value.markdown).toContain('Text extraction');
      }
    });
  });

  describe('DOCX conversion', () => {
    test('converts sample.docx to markdown', async () => {
      const fixture = await loadFixture('docx', 'sample.docx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'docx/sample.docx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.markdown).toContain('GNO Test Document');
        expect(result.value.markdown).toContain('Features');
        expect(result.value.meta.converterId).toBe('adapter/markitdown-ts');
      }
    });

    test('preserves text formatting indicators', async () => {
      const fixture = await loadFixture('docx', 'sample.docx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'docx/sample.docx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should contain the formatted text (bold/italic may or may not be preserved)
        expect(result.value.markdown).toContain('Bold text');
        expect(result.value.markdown).toContain('italic text');
      }
    });

    test('extracts table content', async () => {
      const fixture = await loadFixture('docx', 'sample.docx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'docx/sample.docx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Table data should be present
        expect(result.value.markdown).toContain('Alpha');
        expect(result.value.markdown).toContain('Beta');
      }
    });
  });

  describe('XLSX conversion', () => {
    test('converts sample.xlsx to markdown', async () => {
      const fixture = await loadFixture('xlsx', 'sample.xlsx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'xlsx/sample.xlsx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.meta.converterId).toBe('adapter/markitdown-ts');
        // Should contain spreadsheet data
        expect(result.value.markdown.length).toBeGreaterThan(50);
      }
    });

    test('extracts spreadsheet data', async () => {
      const fixture = await loadFixture('xlsx', 'sample.xlsx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'xlsx/sample.xlsx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should contain sales data
        expect(result.value.markdown).toContain('Widget');
        expect(result.value.markdown).toContain('Gadget');
      }
    });

    test('handles multiple sheets', async () => {
      const fixture = await loadFixture('xlsx', 'sample.xlsx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'xlsx/sample.xlsx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should contain metadata sheet content
        expect(result.value.markdown).toContain('Version');
      }
    });
  });

  describe('PPTX conversion', () => {
    test('converts sample.pptx to markdown', async () => {
      const fixture = await loadFixture('pptx', 'sample.pptx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pptx/sample.pptx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.meta.converterId).toBe('adapter/officeparser');
        expect(result.value.markdown).toContain('GNO Test Presentation');
      }
    });

    test('extracts slide content', async () => {
      const fixture = await loadFixture('pptx', 'sample.pptx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pptx/sample.pptx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.markdown).toContain('Key Features');
        expect(result.value.markdown).toContain('Text extraction');
      }
    });

    test('extracts speaker notes', async () => {
      const fixture = await loadFixture('pptx', 'sample.pptx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pptx/sample.pptx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Speaker notes should be included
        expect(result.value.markdown).toContain('speaker notes');
      }
    });

    test('extracts table data', async () => {
      const fixture = await loadFixture('pptx', 'sample.pptx');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pptx/sample.pptx');

      const result = await registry.convert(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.markdown).toContain('Feature A');
        expect(result.value.markdown).toContain('Complete');
      }
    });
  });

  describe('Error handling', () => {
    test('rejects files exceeding size limit', async () => {
      const fixture = await loadFixture('pdf', 'sample.pdf');
      const registry = await createDefaultRegistry();
      const input = makeInput(fixture, 'pdf/sample.pdf');

      // Set tiny limit
      input.limits = { ...DEFAULT_LIMITS, maxBytes: 100 };

      const result = await registry.convert(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('TOO_LARGE');
      }
    });
  });
});
