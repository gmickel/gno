/**
 * Tests for MIME type detection.
 * PRD §8.5 - MIME detection strategy
 */

import { describe, expect, test } from "bun:test";

import {
  DefaultMimeDetector,
  getDefaultMimeDetector,
  isSupportedExtension,
  SUPPORTED_EXTENSIONS,
} from "../../src/converters/mime";

describe("DefaultMimeDetector", () => {
  const detector = new DefaultMimeDetector();

  describe("extension-based detection", () => {
    test(".md -> text/markdown", () => {
      const result = detector.detect("/path/to/file.md", new Uint8Array(0));
      expect(result.mime).toBe("text/markdown");
      expect(result.ext).toBe(".md");
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("ext");
    });

    test(".txt -> text/plain", () => {
      const result = detector.detect("/path/to/file.txt", new Uint8Array(0));
      expect(result.mime).toBe("text/plain");
      expect(result.ext).toBe(".txt");
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("ext");
    });

    test(".pdf -> application/pdf (without magic bytes)", () => {
      const result = detector.detect("/path/to/file.pdf", new Uint8Array(0));
      expect(result.mime).toBe("application/pdf");
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("ext");
    });

    test(".docx -> OOXML wordprocessing", () => {
      const result = detector.detect("/path/to/file.docx", new Uint8Array(0));
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
    });

    test(".xlsx -> OOXML spreadsheet", () => {
      const result = detector.detect("/path/to/file.xlsx", new Uint8Array(0));
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    });

    test(".pptx -> OOXML presentation", () => {
      const result = detector.detect("/path/to/file.pptx", new Uint8Array(0));
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      );
    });

    test(".swift -> text/plain", () => {
      const result = detector.detect("/path/to/file.swift", new Uint8Array(0));
      expect(result.mime).toBe("text/plain");
    });

    test(".c -> text/plain", () => {
      const result = detector.detect("/path/to/file.c", new Uint8Array(0));
      expect(result.mime).toBe("text/plain");
    });
  });

  describe("magic byte sniffing", () => {
    test("PDF magic bytes (%PDF-) -> high confidence", () => {
      // %PDF- = 0x25 0x50 0x44 0x46 0x2d
      const pdfBytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34,
      ]);
      const result = detector.detect("/path/to/file.pdf", pdfBytes);
      expect(result.mime).toBe("application/pdf");
      expect(result.confidence).toBe("high");
      expect(result.via).toBe("sniff");
    });

    test("ZIP magic bytes with .docx ext -> OOXML wordprocessing (ext-assisted)", () => {
      // PK\x03\x04 = 0x50 0x4b 0x03 0x04
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const result = detector.detect("/path/to/file.docx", zipBytes);
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      // OOXML is medium confidence because it requires ext to distinguish from generic ZIP
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("sniff+ext");
    });

    test("ZIP magic bytes with .xlsx ext -> OOXML spreadsheet (ext-assisted)", () => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const result = detector.detect("/path/to/file.xlsx", zipBytes);
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("sniff+ext");
    });

    test("ZIP magic bytes with .pptx ext -> OOXML presentation (ext-assisted)", () => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const result = detector.detect("/path/to/file.pptx", zipBytes);
      expect(result.mime).toBe(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      );
      expect(result.confidence).toBe("medium");
      expect(result.via).toBe("sniff+ext");
    });

    test("ZIP magic bytes with unknown ext -> application/zip", () => {
      const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const result = detector.detect("/path/to/file.zip", zipBytes);
      expect(result.mime).toBe("application/zip");
      expect(result.confidence).toBe("high");
    });
  });

  describe("fallback", () => {
    test("unknown extension returns octet-stream with low confidence", () => {
      const result = detector.detect("/path/to/file.xyz", new Uint8Array(0));
      expect(result.mime).toBe("application/octet-stream");
      expect(result.ext).toBe(".xyz");
      expect(result.confidence).toBe("low");
      expect(result.via).toBe("fallback");
    });
  });

  describe("case handling", () => {
    test("extension detection is case-insensitive", () => {
      const result = detector.detect("/path/to/file.MD", new Uint8Array(0));
      expect(result.mime).toBe("text/markdown");
    });
  });
});

describe("getDefaultMimeDetector", () => {
  test("returns singleton instance", () => {
    const detector1 = getDefaultMimeDetector();
    const detector2 = getDefaultMimeDetector();
    expect(detector1).toBe(detector2);
  });
});

describe("isSupportedExtension", () => {
  test("returns true for supported extensions", () => {
    expect(isSupportedExtension(".md")).toBe(true);
    expect(isSupportedExtension(".txt")).toBe(true);
    expect(isSupportedExtension(".pdf")).toBe(true);
    expect(isSupportedExtension(".docx")).toBe(true);
    expect(isSupportedExtension(".xlsx")).toBe(true);
    expect(isSupportedExtension(".pptx")).toBe(true);
    expect(isSupportedExtension(".swift")).toBe(true);
    expect(isSupportedExtension(".c")).toBe(true);
  });

  test("returns false for unsupported extensions", () => {
    expect(isSupportedExtension(".jpg")).toBe(false);
    expect(isSupportedExtension(".exe")).toBe(false);
    expect(isSupportedExtension("")).toBe(false);
  });
});

describe("SUPPORTED_EXTENSIONS", () => {
  test("includes all MVP extensions", () => {
    expect(SUPPORTED_EXTENSIONS).toContain(".md");
    expect(SUPPORTED_EXTENSIONS).toContain(".txt");
    expect(SUPPORTED_EXTENSIONS).toContain(".pdf");
    expect(SUPPORTED_EXTENSIONS).toContain(".docx");
    expect(SUPPORTED_EXTENSIONS).toContain(".xlsx");
    expect(SUPPORTED_EXTENSIONS).toContain(".pptx");
    expect(SUPPORTED_EXTENSIONS).toContain(".swift");
    expect(SUPPORTED_EXTENSIONS).toContain(".c");
  });
});
