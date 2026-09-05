import { expect, test } from "bun:test";

import { handleDocBacklinks } from "../../src/serve/routes/links";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

test("hash lookup prefers a current owner after rename and retains deterministic fallback", async () => {
  const store = new SqliteAdapter();
  expect((await store.open(":memory:", "unicode61")).ok).toBe(true);
  try {
    await store.syncCollections([
      {
        name: "notes",
        path: "/synthetic",
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    async function add(relPath: string, sourceHash = "1234567890abcdef") {
      const result = await store.upsertDocument({
        collection: "notes",
        relPath,
        sourceHash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 10,
        sourceMtime: "2026-09-05T00:00:00Z",
        title: relPath,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    const original = await add("old.md");
    await store.markInactive("notes", ["old.md"]);
    const current = await add("moved.md");
    await add("copy.md");
    const source = await add("source.md", "abcdef1234567890");
    expect(
      (
        await store.setDocLinks(
          source.id,
          [
            {
              targetRef: "moved.md",
              targetRefNorm: "moved.md",
              linkType: "markdown",
              startLine: 1,
              startCol: 1,
              endLine: 1,
              endCol: 10,
            },
          ],
          "parsed"
        )
      ).ok
    ).toBe(true);

    const resolved = await store.getDocumentByDocid(original.docid);
    expect(resolved.ok && resolved.value?.id).toBe(current.id);
    const response = await handleDocBacklinks(store, original.docid);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.totalBacklinks).toBe(1);
    expect(body.backlinks[0].sourceUri).toBe("gno://notes/source.md");

    await store.markInactive("notes", ["moved.md", "copy.md"]);
    const inactive = await store.getDocumentByDocid(original.docid);
    expect(inactive.ok && inactive.value?.id).toBe(original.id);
  } finally {
    await store.close();
  }
});
