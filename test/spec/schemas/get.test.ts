import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("get schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("get");
  });

  describe("valid inputs", () => {
    test("validates minimal get response", () => {
      const response = {
        docid: "#abc123",
        uri: "gno://work/doc.md",
        content: "# Hello World\n\nThis is content.",
        totalLines: 3,
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
        capabilities: {
          editable: true,
          tagsEditable: true,
          tagsWriteback: true,
          canCreateEditableCopy: false,
          mode: "editable",
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates full get response", () => {
      const response = {
        docid: "#a1b2c3d4",
        uri: "gno://work/contracts/nda.docx",
        title: "Non-Disclosure Agreement",
        content: "# NDA\n\nThis agreement...",
        totalLines: 150,
        returnedLines: { start: 1, end: 50 },
        language: "en",
        source: {
          absPath: "/Users/user/work/contracts/nda.docx",
          relPath: "contracts/nda.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ext: ".docx",
          modifiedAt: "2025-12-23T10:00:00Z",
          sizeBytes: 45_678,
          sourceHash: "abc123def456",
        },
        conversion: {
          converterId: "adapter/markitdown-js",
          converterVersion: "1.0.0",
          mirrorHash: "def456abc123",
        },
        capabilities: {
          editable: false,
          tagsEditable: true,
          tagsWriteback: false,
          canCreateEditableCopy: true,
          mode: "read_only",
          reason:
            "This document is derived from a source format that GNO cannot safely write back in place.",
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates partial line range", () => {
      const response = {
        docid: "#abc123",
        uri: "gno://work/doc.md",
        content: "Partial content",
        totalLines: 100,
        returnedLines: { start: 50, end: 75 },
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
        capabilities: {
          editable: true,
          tagsEditable: true,
          tagsWriteback: true,
          canCreateEditableCopy: false,
          mode: "editable",
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing docid", () => {
      const response = {
        uri: "gno://work/doc.md",
        content: "Content",
        totalLines: 1,
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing content", () => {
      const response = {
        docid: "#abc123",
        uri: "gno://work/doc.md",
        totalLines: 1,
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects invalid docid format", () => {
      const response = {
        docid: "invalid",
        uri: "gno://work/doc.md",
        content: "Content",
        totalLines: 1,
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects negative totalLines", () => {
      const response = {
        docid: "#abc123",
        uri: "gno://work/doc.md",
        content: "Content",
        totalLines: -1,
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects returnedLines with invalid start", () => {
      const response = {
        docid: "#abc123",
        uri: "gno://work/doc.md",
        content: "Content",
        totalLines: 10,
        returnedLines: { start: 0, end: 5 },
        source: {
          relPath: "doc.md",
          mime: "text/markdown",
          ext: ".md",
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});
