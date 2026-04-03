import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { handleBrowseTree, handleDocs } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("browse tree API", () => {
  let tmpDir: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-browse-tree-"));
    store = new SqliteAdapter();
    const openResult = await store.open(join(tmpDir, "test.db"), "porter");
    expect(openResult.ok).toBe(true);
    const syncResult = await store.syncCollections([
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      {
        name: "docs",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  async function createDoc(
    collection: string,
    relPath: string,
    hash: string
  ): Promise<void> {
    const doc: DocumentInput = {
      collection,
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: new Date().toISOString(),
      title: relPath,
      mirrorHash: hash,
      ingestVersion: 2,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
  }

  test("returns cross-collection folder tree with counts", async () => {
    await createDoc("notes", "projects/gno/spec.md", "hash-1");
    await createDoc("notes", "projects/roadmap.md", "hash-2");
    await createDoc("docs", "api/search.md", "hash-3");

    const response = await handleBrowseTree(store);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      collections: Array<{
        name: string;
        documentCount: number;
        children: Array<{ name: string; documentCount: number }>;
      }>;
      totalCollections: number;
      totalDocuments: number;
    };

    expect(body.totalCollections).toBe(2);
    expect(body.totalDocuments).toBe(3);
    expect(
      body.collections.find((node) => node.name === "notes")?.documentCount
    ).toBe(2);
    expect(
      body.collections.find((node) => node.name === "notes")?.children[0]?.name
    ).toBe("projects");
  });

  test("filters docs to direct children of the selected folder", async () => {
    await createDoc("notes", "projects/gno/spec.md", "hash-1");
    await createDoc("notes", "projects/gno/tasks.md", "hash-2");
    await createDoc("notes", "projects/gno/nested/too-deep.md", "hash-3");
    await createDoc("notes", "projects/overview.md", "hash-4");
    await createDoc("notes", "root.md", "hash-5");

    const rootResponse = await handleDocs(
      store,
      new URL(
        "http://localhost/api/docs?collection=notes&directChildrenOnly=true"
      )
    );
    const rootBody = (await rootResponse.json()) as {
      documents: Array<{ relPath: string }>;
    };
    expect(rootBody.documents.map((doc) => doc.relPath)).toEqual(["root.md"]);

    const folderResponse = await handleDocs(
      store,
      new URL(
        "http://localhost/api/docs?collection=notes&pathPrefix=projects/gno&directChildrenOnly=true"
      )
    );
    const folderBody = (await folderResponse.json()) as {
      documents: Array<{ relPath: string }>;
    };
    expect(folderBody.documents.map((doc) => doc.relPath)).toEqual([
      "projects/gno/spec.md",
      "projects/gno/tasks.md",
    ]);
  });
});
