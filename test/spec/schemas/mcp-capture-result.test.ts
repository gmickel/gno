import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-capture-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-capture-result");
  });

  test("valid capture result", () => {
    const result = {
      docid: "#abc123",
      uri: "gno://notes/test.md",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      openedExisting: false,
      createdWithSuffix: false,
      overwritten: false,
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      source: {
        kind: "direct",
        capturedAt: "2026-06-04T12:34:56.000Z",
      },
      tags: [],
      sync: { status: "completed" },
      embed: { status: "not_requested" },
      collisionPolicyResult: "created",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("valid failed sync capture result", () => {
    const result = {
      docid: "",
      uri: "gno://notes/test.md",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      openedExisting: false,
      createdWithSuffix: false,
      overwritten: false,
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      source: {
        kind: "direct",
        capturedAt: "2026-06-04T12:34:56.000Z",
      },
      tags: [],
      sync: {
        status: "failed",
        error: "INGEST_ERROR: PARSE_ERROR - bad markdown",
      },
      embed: { status: "not_requested" },
      collisionPolicyResult: "created",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects missing uri", () => {
    const result = {
      docid: "#abc123",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      openedExisting: false,
      createdWithSuffix: false,
      overwritten: false,
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      source: {
        kind: "direct",
        capturedAt: "2026-06-04T12:34:56.000Z",
      },
      tags: [],
      sync: { status: "completed" },
      embed: { status: "not_requested" },
      collisionPolicyResult: "created",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });

  test("valid browser clip provenance projects through MCP receipt", () => {
    const hash = "a".repeat(64);
    const result = {
      docid: "#abc123",
      uri: "gno://notes/test.md",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      openedExisting: false,
      createdWithSuffix: false,
      overwritten: false,
      contentHash: hash,
      source: {
        kind: "web",
        url: "https://example.com/article",
        canonicalUrl: "https://example.com/article",
        site: "Example",
        publishedAt: "2026-07-23",
        capturedAt: "2026-07-24T08:01:00.000Z",
        browserClip: {
          schemaVersion: "1.0",
          mode: "reader",
          sourceUrl: "https://example.com/article",
          canonicalUrl: "https://example.com/article",
          title: "Example",
          author: null,
          site: "Example",
          publishedAt: "2026-07-23",
          observedAt: "2026-07-24T08:00:00.000Z",
          capturedAt: "2026-07-24T08:01:00.000Z",
          extractionHash: "1".repeat(64),
          finalBodyHash: hash,
          clipIdentity: "3".repeat(64),
          previewDigest: "4".repeat(64),
          exactSelection: null,
          extractionWarnings: ["reader_partial"],
          browser: {
            name: "Firefox",
            version: "141",
            platform: "Linux",
          },
        },
      },
      tags: ["web"],
      sync: { status: "completed" },
      embed: { status: "not_requested" },
      collisionPolicyResult: "created",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertValid(result, schema)).toBeTrue();
  });
});
