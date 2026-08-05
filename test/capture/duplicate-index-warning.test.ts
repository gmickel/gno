/**
 * Duplicating a note into a destination the collection does not index.
 *
 * All three duplicate surfaces hand back `uri` synchronously. A `syncCollection`
 * that did not throw is not proof that the copy is indexed - an excluded (or
 * unreachable) destination is `skipped`, an ordinary non-error - so `uri` used
 * to name a document that does not exist, with nothing said about it.
 *
 * The copy itself is real, and callers need its path, so the honest report is
 * the warning channel these surfaces already carry, not a thrown failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises has no Bun equivalent for directory creation.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/server";
import type { ContextHolder } from "../../src/serve/routes/api";

import { defaultSyncService, withContentTypeRules } from "../../src/ingestion";
import { handleDuplicateNote } from "../../src/mcp/tools/workspace-write";
import { createDefaultConfig, createGnoClient } from "../../src/sdk";
import { handleDuplicateDoc } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const NOT_INDEXED = "not indexed";

/** `archive/` is a real directory that the collection deliberately excludes. */
const collectionAt = (root: string): Collection => ({
  name: "notes",
  path: join(root, "notes"),
  pattern: "**/*.md",
  include: [],
  exclude: ["archive/**"],
});

const configFor = (root: string): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [collectionAt(root)],
  contexts: [],
});

let roots: string[] = [];

const makeRoot = async (prefix: string): Promise<string> => {
  // `mkdtemp` rather than a `Date.now()`/`Math.random()` name under the OS temp
  // dir: the latter is a PREDICTABLE path in a world-writable directory, so
  // another local user can pre-create it (or plant a symlink at it) and this
  // suite then writes its fixtures - and its SQLite index - through their file.
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await mkdir(join(root, "notes", "archive"), { recursive: true });
  await Bun.write(join(root, "notes", "doc.md"), "# Source\n\nBody.\n");
  roots.push(root);
  return root;
};

const openIndexedStore = async (root: string): Promise<SqliteAdapter> => {
  const store = new SqliteAdapter();
  const opened = await store.open(join(root, "index.sqlite"), "unicode61");
  if (!opened.ok) throw new Error(opened.error.message);
  const registered = await store.syncCollections([collectionAt(root)]);
  if (!registered.ok) throw new Error(registered.error.message);
  await defaultSyncService.syncCollection(
    collectionAt(root),
    store,
    withContentTypeRules({ runUpdateCmd: false }, configFor(root))
  );
  return store;
};

describe("duplicating into an unindexed destination", () => {
  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    for (const root of roots) await safeRm(root);
  });

  test("REST reports the copy is not indexed instead of implying it is", async () => {
    // DISCRIMINATING: at ede2ed1a the response was a bare success carrying a
    // `uri` for a document the index does not have.
    const root = await makeRoot("gno-dup-rest");
    const store = await openIndexedStore(root);
    try {
      const listed = await store.listDocuments("notes");
      if (!listed.ok) throw new Error(listed.error.message);
      const source = listed.value.find((doc) => doc.relPath === "doc.md");
      expect(source).toBeDefined();
      const config = configFor(root);
      const ctxHolder = {
        current: { config } as ContextHolder["current"],
        config,
        scheduler: null,
        eventBus: null,
        watchService: null,
      } as ContextHolder;

      const res = await handleDuplicateDoc(
        ctxHolder,
        store,
        source?.docid ?? "",
        new Request("http://localhost/api/docs/x/duplicate", {
          method: "POST",
          body: JSON.stringify({ folderPath: "archive" }),
        })
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        relPath: string;
        warning?: string;
      };
      expect(body.relPath).toBe("archive/doc.md");
      expect(body.warning).toContain(NOT_INDEXED);
      expect(
        await Bun.file(join(root, "notes", "archive", "doc.md")).exists()
      ).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("MCP reports the copy is not indexed instead of implying it is", async () => {
    // DISCRIMINATING: at ede2ed1a `warnings` said nothing about indexing.
    const root = await makeRoot("gno-dup-mcp");
    const store = await openIndexedStore(root);
    try {
      const ctx: ToolContext = {
        indexName: "default",
        store,
        config: configFor(root),
        collections: [collectionAt(root)],
        actualConfigPath: join(root, "config.yml"),
        toolMutex: {
          acquire: async () => () => {},
        } as ToolContext["toolMutex"],
        jobManager: {} as ToolContext["jobManager"],
        serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
        writeLockPath: join(root, ".lock"),
        enableWrite: true,
        isShuttingDown: () => false,
      };

      const result = await handleDuplicateNote(
        { ref: "notes/doc.md", folderPath: "archive" },
        ctx
      );

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as unknown as {
        relPath: string;
        warnings: string[];
      };
      expect(structured.relPath).toBe("archive/doc.md");
      expect(structured.warnings.join("\n")).toContain(NOT_INDEXED);
    } finally {
      await store.close();
    }
  });

  test("SDK reports the copy is not indexed instead of implying it is", async () => {
    // DISCRIMINATING: at ede2ed1a `warnings` said nothing about indexing.
    const root = await makeRoot("gno-dup-sdk");
    const config = createDefaultConfig();
    // `unicode61` keeps this portable: the snowball tokenizer has no
    // linux-arm64 build, and the tokenizer is irrelevant to what is asserted.
    config.ftsTokenizer = "unicode61";
    config.collections = [collectionAt(root)];
    const client = await createGnoClient({
      config,
      dbPath: join(root, "index.sqlite"),
      downloadPolicy: { offline: false, allowDownload: false },
    });
    try {
      await client.update();
      const duplicated = await client.duplicateNote({
        ref: "notes/doc.md",
        folderPath: "archive",
      });

      expect(duplicated.relPath).toBe("archive/doc.md");
      expect(duplicated.warnings.join("\n")).toContain(NOT_INDEXED);
    } finally {
      await client.close();
    }
  });
});
