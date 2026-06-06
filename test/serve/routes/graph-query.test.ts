import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultConfig } from "../../../src/config/defaults";
import { handleGraphQuery } from "../../../src/serve/routes/graph";
import { SqliteAdapter } from "../../../src/store";
import { safeRm } from "../../helpers/cleanup";
import { assertValid, loadSchema } from "../../spec/schemas/validator";

describe("POST /api/graph/query", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let counter = 0;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-rest-graph-query-test-"));
    adapter = new SqliteAdapter();
    const open = await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    expect(open.ok).toBe(true);
    const sync = await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(sync.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function createDoc(relPath: string) {
    counter += 1;
    const sourceHash = `${counter.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
    const result = await adapter.upsertDocument({
      collection: "notes",
      relPath,
      sourceHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: "2026-01-01T00:00:00.000Z",
      mirrorHash: `mirror-${counter}`,
      title: relPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("document not created");
    }
    const doc = await adapter.getDocument("notes", relPath);
    expect(doc.ok).toBe(true);
    if (!doc.ok || !doc.value) {
      throw new Error("document not created");
    }
    return doc.value;
  }

  test("returns schema-valid bounded traversal", async () => {
    const root = await createDoc("root.md");
    const target = await createDoc("target.md");
    const setEdges = await adapter.setDocEdges(
      root.id,
      [
        {
          targetDocId: target.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
      ],
      "wikilink"
    );
    expect(setEdges.ok).toBe(true);
    const req = new Request("http://localhost/api/graph/query", {
      method: "POST",
      body: JSON.stringify({
        doc: root.uri,
        direction: "out",
        edgeType: "mentions",
        maxDepth: 1,
      }),
    });

    const res = await handleGraphQuery(adapter, createDefaultConfig(), req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const schema = await loadSchema("graph-query");

    expect(assertValid(body, schema)).toBe(true);
    expect(body.root.id).toBe(root.docid);
    expect(body.edges).toHaveLength(1);
    expect(body.meta.edgeType).toBe("mentions");
  });

  test("rejects invalid direction", async () => {
    const req = new Request("http://localhost/api/graph/query", {
      method: "POST",
      body: JSON.stringify({
        doc: "gno://notes/root.md",
        direction: "sideways",
      }),
    });

    const res = await handleGraphQuery(adapter, createDefaultConfig(), req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("direction");
  });

  test("rejects non-string edgeType", async () => {
    const req = new Request("http://localhost/api/graph/query", {
      method: "POST",
      body: JSON.stringify({ doc: "gno://notes/root.md", edgeType: 123 }),
    });

    const res = await handleGraphQuery(adapter, createDefaultConfig(), req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("edgeType");
  });

  test("rejects primitive JSON body", async () => {
    const req = new Request("http://localhost/api/graph/query", {
      method: "POST",
      body: JSON.stringify(null),
    });

    const res = await handleGraphQuery(adapter, createDefaultConfig(), req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("object");
  });
});
