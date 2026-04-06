/**
 * Tests for collection API endpoints.
 *
 * These tests are hermetic - they use a temp config directory to avoid
 * mutating the developer's real config.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";

import {
  handleClearCollectionEmbeddings,
  handleCollections,
  handleCreateCollection,
  handleDeleteCollection,
  handleImportPreview,
  handleUpdateCollection,
} from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

interface ErrorBody {
  error: { code: string };
}

// Import config path utilities to find actual config location
import { getConfigPaths } from "../../src/config/paths";

let originalConfigContent: string | null = null;
let configFilePath: string;

// Set up hermetic config directory before all tests
beforeAll(async () => {
  // Use the actual config path (respects platform-specific locations)
  const paths = getConfigPaths();
  configFilePath = paths.configFile;

  // Save original config if it exists
  const file = Bun.file(configFilePath);
  if (await file.exists()) {
    originalConfigContent = await file.text();
  }

  // Ensure config directory exists
  const nodePath = await import("node:path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(nodePath.dirname(configFilePath), { recursive: true });

  await resetConfig();
});

afterAll(async () => {
  // Restore original config or remove test config
  if (originalConfigContent !== null) {
    await writeFile(configFilePath, originalConfigContent);
  }
});

// Helper to reset config to default state
async function resetConfig() {
  await writeFile(
    configFilePath,
    'version: "1.0"\nftsTokenizer: unicode61\ncollections: []\ncontexts: []\n'
  );
}

// Helper to write config with collections/contexts using Bun.YAML
async function writeConfig(config: Partial<Config>) {
  const fullConfig = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [] as Config["collections"],
    contexts: [] as Config["contexts"],
    ...config,
  };
  const yaml = Bun.YAML.stringify(fullConfig);
  await writeFile(configFilePath, yaml);
}

// Minimal mock store for testing
function createMockStore() {
  const collections: Array<{ name: string; path: string }> = [];

  return {
    collections,
    getCollections() {
      return Promise.resolve({ ok: true as const, value: collections });
    },
    syncCollections(cols: Array<{ name: string; path: string }>) {
      collections.length = 0;
      collections.push(...cols);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    syncContexts() {
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    clearEmbeddingsForCollection(
      collection: string,
      options: { mode: "stale" | "all" }
    ) {
      return Promise.resolve({
        ok: true as const,
        value: {
          collection,
          deletedVectors: options.mode === "all" ? 4 : 2,
          deletedModels:
            options.mode === "all"
              ? ["active-model", "old-model"]
              : ["old-model"],
          mode: options.mode,
          protectedSharedVectors: 1,
        },
      });
    },
  };
}

// Minimal mock context holder
function createMockContextHolder(config?: Partial<Config>): ContextHolder {
  const fullConfig: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    ...config,
  };
  return {
    current: { config: fullConfig } as ContextHolder["current"],
    config: fullConfig,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

describe("GET /api/collections", () => {
  test("returns empty list when no collections", async () => {
    const res = await handleCollections({
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [],
      contexts: [],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("returns collections list", async () => {
    const res = await handleCollections({
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "docs",
          path: "/path/to/docs",
          pattern: "**/*.md",
          include: [],
          exclude: [],
          models: {
            embed: "hf:test/embed.gguf",
          },
        },
      ],
      contexts: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      activePresetId: string;
      effectiveModels: { embed: string };
      modelSources: { embed: string };
      models?: { embed?: string };
      name: string;
      path: string;
    }>;
    expect(body[0]?.name).toBe("docs");
    expect(body[0]?.path).toBe("/path/to/docs");
    expect(body[0]?.models?.embed).toBe("hf:test/embed.gguf");
    expect(body[0]?.effectiveModels.embed).toBe("hf:test/embed.gguf");
    expect(body[0]?.modelSources.embed).toBe("override");
    expect(body[0]?.activePresetId).toBe("slim-tuned");
  });
});

describe("PATCH /api/collections/:name", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-"));
    await writeConfig({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("sets collection embed override", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const req = new Request("http://localhost/api/collections/docs", {
      method: "PATCH",
      body: JSON.stringify({
        models: {
          embed:
            "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
        },
      }),
    });

    const res = await handleUpdateCollection(
      ctxHolder,
      store as never,
      "docs",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: {
        effectiveModels: { embed: string };
        modelSources: { embed: string };
        models?: { embed?: string };
      };
      success: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.collection.models?.embed).toContain("Qwen3-Embedding-0.6B");
    expect(body.collection.effectiveModels.embed).toContain(
      "Qwen3-Embedding-0.6B"
    );
    expect(body.collection.modelSources.embed).toBe("override");
  });

  test("clears one role override without clobbering siblings", async () => {
    await writeConfig({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
          models: {
            embed: "hf:test/embed.gguf",
            rerank: "hf:test/rerank.gguf",
          },
        },
      ],
    });

    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
          models: {
            embed: "hf:test/embed.gguf",
            rerank: "hf:test/rerank.gguf",
          },
        },
      ],
    });

    const req = new Request("http://localhost/api/collections/docs", {
      method: "PATCH",
      body: JSON.stringify({
        models: {
          embed: null,
        },
      }),
    });

    const res = await handleUpdateCollection(
      ctxHolder,
      store as never,
      "docs",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection: {
        effectiveModels: { embed: string; rerank: string };
        modelSources: { embed: string; rerank: string };
        models?: { embed?: string; rerank?: string };
      };
    };
    expect(body.collection.models?.embed).toBeUndefined();
    expect(body.collection.models?.rerank).toBe("hf:test/rerank.gguf");
    expect(body.collection.modelSources.embed).toBe("preset");
    expect(body.collection.modelSources.rerank).toBe("override");
  });
});

describe("POST /api/collections/:name/embeddings/clear", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-"));
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("clears stale embeddings for a collection", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const req = new Request(
      "http://localhost/api/collections/docs/embeddings/clear",
      {
        method: "POST",
        body: JSON.stringify({ mode: "stale" }),
      }
    );
    const res = await handleClearCollectionEmbeddings(
      ctxHolder,
      store as never,
      "docs",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: {
        deletedVectors: number;
        mode: string;
        protectedSharedVectors: number;
      };
      success: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.stats.mode).toBe("stale");
    expect(body.stats.deletedVectors).toBe(2);
    expect(body.stats.protectedSharedVectors).toBe(1);
  });

  test("rejects invalid mode", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const req = new Request(
      "http://localhost/api/collections/docs/embeddings/clear",
      {
        method: "POST",
        body: JSON.stringify({ mode: "bogus" }),
      }
    );
    const res = await handleClearCollectionEmbeddings(
      ctxHolder,
      store as never,
      "docs",
      req
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/collections", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-"));
    await resetConfig();
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("rejects missing path", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/collections", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION");
  });

  test("rejects non-existent path", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/collections", {
      method: "POST",
      body: JSON.stringify({ path: "/nonexistent/path", name: "test" }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("PATH_NOT_FOUND");
  });

  test("rejects duplicate collection name", async () => {
    // Write config with existing collection to disk
    await writeConfig({
      collections: [
        {
          name: "existing",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/collections", {
      method: "POST",
      body: JSON.stringify({ path: tmpDir, name: "existing" }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("DUPLICATE");
  });

  test("rejects duplicate collection path", async () => {
    await writeConfig({
      collections: [
        {
          name: "existing",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const store = createMockStore();
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "existing",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });
    const req = new Request("http://localhost/api/collections", {
      method: "POST",
      body: JSON.stringify({ path: tmpDir, name: "new-name" }),
    });
    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("DUPLICATE_PATH");
  });

  test("returns success when display name is mixed case but collection is normalized", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/collections", {
      method: "POST",
      body: JSON.stringify({ path: tmpDir, name: "SW2" }),
    });

    const res = await handleCreateCollection(ctxHolder, store as never, req);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      collection: { name: string; path: string };
      jobId: string;
    };
    expect(body.collection.name).toBe("sw2");
    expect(body.collection.path).toBe(tmpDir);
    expect(body.jobId.length).toBeGreaterThan(0);
  });
});

describe("POST /api/import/preview", () => {
  test("detects Obsidian-style vaults and duplicate conflicts", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "gno-import-"));
    await Bun.write(join(tmpDir, "note.md"), "# Hello");
    await Bun.$`mkdir -p ${join(tmpDir, ".obsidian")}`.quiet();

    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "existing",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });
    const req = new Request("http://localhost/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ path: tmpDir }),
    });

    const res = await handleImportPreview(ctxHolder, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preview: { folderType: string; conflicts: string[]; guidance: string[] };
    };
    expect(body.preview.folderType).toBe("obsidian-vault");
    expect(body.preview.conflicts[0]).toContain("already indexed");
    expect(body.preview.guidance[0]).toContain("Obsidian");

    await safeRm(tmpDir);
  });
});

describe("DELETE /api/collections/:name", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-"));
    await resetConfig();
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("rejects non-existent collection", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const res = await handleDeleteCollection(
      ctxHolder,
      store as never,
      "nonexistent"
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("rejects collection with context references", async () => {
    // Write config with collection and context reference to disk
    await writeConfig({
      collections: [
        {
          name: "docs",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [{ scopeType: "collection", scopeKey: "docs:", text: "test" }],
    });

    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const res = await handleDeleteCollection(ctxHolder, store as never, "docs");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("HAS_REFERENCES");
  });
});
