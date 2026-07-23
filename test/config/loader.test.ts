import { describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory cleanup; Bun has no directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
// node:os tmpdir and node:path join have no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromPath } from "../../src/config/loader";
import { getCollectionFromScope, parseScope } from "../../src/config/types";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/config");

describe("loadConfigFromPath", () => {
  describe("valid configs", () => {
    test("loads minimal config", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "valid-minimal.yml")
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.version).toBe("1.0");
      // Default tokenizer is now snowball english for multilingual stemming
      expect(result.value.ftsTokenizer).toBe("snowball english");
      expect(result.value.collections).toEqual([]);
      expect(result.value.contexts).toEqual([]);
    });

    test("loads full config with collections and contexts", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "valid-full.yml")
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.version).toBe("1.0");
      expect(result.value.ftsTokenizer).toBe("unicode61");
      expect(result.value.collections).toHaveLength(2);
      expect(result.value.contexts).toHaveLength(3);

      // Check first collection
      const notes = result.value.collections[0];
      expect(notes?.name).toBe("notes");
      expect(notes?.path).toBe("/Users/test/notes");
      expect(notes?.pattern).toBe("**/*.md");
      expect(notes?.updateCmd).toBe("git pull");
      expect(notes?.languageHint).toBe("en");

      // Check contexts
      const globalCtx = result.value.contexts[0];
      expect(globalCtx?.scopeType).toBe("global");
      expect(globalCtx?.scopeKey).toBe("/");

      const collectionCtx = result.value.contexts[1];
      expect(collectionCtx?.scopeType).toBe("collection");
      expect(collectionCtx?.scopeKey).toBe("notes:");

      const prefixCtx = result.value.contexts[2];
      expect(prefixCtx?.scopeType).toBe("prefix");
      expect(prefixCtx?.scopeKey).toBe("gno://notes/projects");
    });

    test("loads optional editorUriTemplate", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "valid-full.yml")
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.editorUriTemplate).toBeUndefined();
    });

    test("loads resident HTTP gateway security and limit configuration", async () => {
      const dir = await mkdtemp(join(tmpdir(), "gno-gateway-config-"));
      const path = join(dir, "config.yml");
      try {
        await Bun.write(
          path,
          `version: "1.0"
gateway:
  host: 0.0.0.0
  tokenFile: /run/secrets/gno-mcp
  allowedHosts: [gateway.example.test:8443]
  allowedOrigins: [https://client.example.test]
  enableWrite: true
  limits:
    maxBodyBytes: 65536
    maxRequestsPerMinute: 30
    maxConcurrentRequests: 4
    maxQueuedRequests: 2
    maxSessions: 8
    sessionIdleTimeoutMs: 60000
`
        );
        const result = await loadConfigFromPath(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.gateway).toEqual({
          host: "0.0.0.0",
          tokenFile: "/run/secrets/gno-mcp",
          allowedHosts: ["gateway.example.test:8443"],
          allowedOrigins: ["https://client.example.test"],
          enableWrite: true,
          limits: {
            maxBodyBytes: 65_536,
            maxRequestsPerMinute: 30,
            maxConcurrentRequests: 4,
            maxQueuedRequests: 2,
            maxSessions: 8,
            sessionIdleTimeoutMs: 60_000,
          },
        });
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  describe("error cases", () => {
    test("returns NOT_FOUND for missing file", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "nonexistent.yml")
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent.yml");
    });

    test("returns VERSION_MISMATCH for wrong version", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "invalid-version.yml")
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe("VERSION_MISMATCH");
      if (result.error.code === "VERSION_MISMATCH") {
        expect(result.error.found).toBe("2.0");
        expect(result.error.expected).toBe("1.0");
      }
    });

    test("returns VALIDATION_ERROR for invalid collection name", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "invalid-collection-name.yml")
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe("VALIDATION_ERROR");
    });

    test("returns VALIDATION_ERROR for invalid context scope", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "invalid-context-scope.yml")
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe("VALIDATION_ERROR");
    });

    test("returns PARSE_ERROR for invalid YAML syntax", async () => {
      const result = await loadConfigFromPath(
        join(FIXTURES_DIR, "invalid-yaml-syntax.yml")
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe("PARSE_ERROR");
    });
  });
});

describe("parseScope", () => {
  test("parses global scope", () => {
    const result = parseScope("/");
    expect(result).toEqual({ type: "global", key: "/" });
  });

  test("parses collection scope", () => {
    const result = parseScope("notes:");
    expect(result).toEqual({ type: "collection", key: "notes:" });
  });

  test("parses collection scope with hyphens", () => {
    const result = parseScope("my-notes:");
    expect(result).toEqual({ type: "collection", key: "my-notes:" });
  });

  test("parses prefix scope", () => {
    const result = parseScope("gno://notes/projects");
    expect(result).toEqual({ type: "prefix", key: "gno://notes/projects" });
  });

  test("returns null for invalid scope", () => {
    expect(parseScope("")).toBeNull();
    expect(parseScope("notes")).toBeNull(); // missing colon
    expect(parseScope("http://example.com")).toBeNull();
  });
});

describe("getCollectionFromScope", () => {
  test("returns null for global scope", () => {
    expect(getCollectionFromScope("/")).toBeNull();
  });

  test("extracts collection from collection scope", () => {
    expect(getCollectionFromScope("notes:")).toBe("notes");
    expect(getCollectionFromScope("my-work:")).toBe("my-work");
  });

  test("extracts collection from prefix scope", () => {
    expect(getCollectionFromScope("gno://notes/projects")).toBe("notes");
    expect(getCollectionFromScope("gno://work")).toBe("work");
  });
});
