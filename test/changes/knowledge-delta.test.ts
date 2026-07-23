import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import {
  analyzeKnowledgeImpact,
  getKnowledgeDiff,
  listKnowledgeChanges,
} from "../../src/core/knowledge-delta";
import {
  changesInputSchema,
  diffInputSchema,
} from "../../src/mcp/tools/changes";
import { handleChanges, handleDiff } from "../../src/serve/routes/changes";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const hash = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

describe("knowledge delta services", () => {
  let directory = "";
  let store: SqliteAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gno-knowledge-delta-"));
    store = new SqliteAdapter();
    expect(
      (await store.open(join(directory, "index.sqlite"), "porter")).ok
    ).toBe(true);
    expect(
      (
        await store.syncCollections([
          {
            name: "notes",
            path: directory,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(directory);
  });

  async function create(
    relPath: string,
    observedAtMs: number,
    truncated = false
  ): Promise<{ id: number; docid: string }> {
    const input: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash(`source-${relPath}`),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: new Date(observedAtMs).toISOString(),
      mirrorHash: hash(`mirror-${relPath}`),
      title: relPath,
      changeJournal: {
        observedAtMs,
        structureDelta: {
          headings: { added: [`# ${relPath}`], removed: [] },
          truncated,
        },
      },
    };
    const created = await store.upsertDocument(input);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  test("lists by time/cursor and discloses partial and expired history", async () => {
    const root = await create("root.md", 1000);
    await create("later.md", 2000);
    const updated = await store.upsertDocument({
      collection: "notes",
      relPath: "root.md",
      sourceHash: hash("source-root-updated"),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 11,
      sourceMtime: new Date(3000).toISOString(),
      mirrorHash: hash("mirror-root-updated"),
      title: "root.md",
      changeJournal: {
        observedAtMs: 3000,
        structureDelta: { truncated: true },
      },
    });
    expect(updated.ok).toBe(true);

    const byTime = await listKnowledgeChanges(store, {
      since: new Date(2000).toISOString(),
      limit: 1,
    });
    expect(byTime.success).toBe(true);
    if (!byTime.success) return;
    expect(byTime.data.changes[0]?.current?.uri).toBe("gno://notes/later.md");
    expect(byTime.data.page.nextCursor).not.toBeNull();

    const next = await listKnowledgeChanges(store, {
      since: byTime.data.page.nextCursor!,
    });
    expect(next.success && next.data.changes[0]?.kind).toBe("update");
    const changeId = next.success ? next.data.changes[0]?.id : undefined;
    expect(changeId).toBeDefined();

    const diff = await getKnowledgeDiff(store, "gno://notes/root.md", changeId);
    expect(diff.success && diff.data.history).toEqual({
      status: "partial",
      reason: "structure_delta_truncated",
    });
    expect(diff.success && diff.data.content.status).toBe("not_retained");

    const retained = await store.enforceDocumentChangeRetention(
      { maxAgeDays: 3650, maxEntries: 1, maxBytes: 1024 * 1024 },
      4000
    );
    expect(retained.ok).toBe(true);
    const first = await listKnowledgeChanges(store, { limit: 1 });
    expect(first.success && first.data.page.retentionTruncated).toBe(true);
    const expired = await getKnowledgeDiff(
      store,
      "gno://notes/root.md",
      "gno-change-v1.eyJzZXF1ZW5jZSI6MX0="
    );
    expect(expired.success && expired.data.status).toBe("expired");
    expect(root.id).toBeGreaterThan(0);
  });

  test("rejects provided-empty collection and change selectors across core, REST, and MCP", async () => {
    expect(
      await listKnowledgeChanges(store, { collection: "   " })
    ).toMatchObject({
      success: false,
      isValidation: true,
      error: expect.stringContaining("collection"),
    });
    expect(
      await getKnowledgeDiff(store, "gno://notes/root.md", " ")
    ).toMatchObject({
      success: false,
      isValidation: true,
      error: expect.stringContaining("changeId"),
    });

    const changesResponse = await handleChanges(
      store,
      new URL("http://localhost/api/changes?collection=")
    );
    expect(changesResponse.status).toBe(400);
    const diffResponse = await handleDiff(
      store,
      new URL(
        "http://localhost/api/diff?ref=gno%3A%2F%2Fnotes%2Froot.md&change="
      )
    );
    expect(diffResponse.status).toBe(400);

    expect(changesInputSchema.safeParse({ collection: "" }).success).toBe(
      false
    );
    expect(
      diffInputSchema.safeParse({
        ref: "gno://notes/root.md",
        change: "   ",
      }).success
    ).toBe(false);
  });

  test("keeps cycle and hub traversal bounded with evidence paths", async () => {
    const root = await create("root.md", 1000);
    const middle = await create("middle.md", 1100);
    const leaf = await create("leaf.md", 1200);
    expect(
      (
        await store.setDocEdges(
          middle.id,
          [
            {
              targetDocId: root.id,
              edgeType: "mentions",
              confidence: "parsed",
            },
          ],
          "wikilink"
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await store.setDocEdges(
          leaf.id,
          [
            {
              targetDocId: middle.id,
              edgeType: "depends_on",
              confidence: "configured",
            },
          ],
          "frontmatter-relation"
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await store.setDocEdges(
          root.id,
          [
            {
              targetDocId: leaf.id,
              edgeType: "cycle",
              confidence: "manual",
            },
          ],
          "frontmatter-relation"
        )
      ).ok
    ).toBe(true);
    for (let index = 0; index < 12; index += 1) {
      const hub = await create(`hub-${index}.md`, 2000 + index);
      await store.setDocEdges(
        hub.id,
        [
          {
            targetDocId: root.id,
            edgeType: "references",
            confidence: "parsed",
          },
        ],
        "markdown-link"
      );
    }

    const impact = await analyzeKnowledgeImpact(store, "gno://notes/root.md", {
      maxDepth: 4,
      maxNodes: 20,
      maxEdges: 5,
      frontierLimit: 20,
      visitedLimit: 30,
    });
    expect(impact.success).toBe(true);
    if (!impact.success) return;
    expect(impact.data.meta.truncated).toBe(true);
    expect(impact.data.meta.warnings).toContain("maxEdges reached");
    expect(impact.data.meta.returnedEdges).toBeLessThanOrEqual(5);
    expect(
      impact.data.impacted.every((item) => item.evidencePath.length > 0)
    ).toBe(true);
    expect(
      impact.data.impacted.every(
        (item) => item.evidencePath.length === item.depth
      )
    ).toBe(true);
  });
});
