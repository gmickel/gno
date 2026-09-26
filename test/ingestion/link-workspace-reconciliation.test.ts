/**
 * Incremental graph reconciliation with cross-collection referrers (R8, A10):
 * changing documents in one collection updates edges of referrers in another,
 * and the incremental result equals a forced full projection.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises rename/unlink: filesystem mutations, no Bun equivalent.
import { mkdir, mkdtemp, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SyncService } from "../../src/ingestion";
import { projectGraph } from "../../src/ingestion/graph-reconciliation";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  openLinkWorkspaceFixture,
  type LinkWorkspaceFixture,
} from "../fixtures/link-workspace/fixture";
import { safeRm } from "../helpers/cleanup";

let fixture: LinkWorkspaceFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const edges = (f: LinkWorkspaceFixture): string[] =>
  f.store
    .getRawDb()
    .query<{ edge: string }, []>(
      `SELECT s.uri || ' -> ' || d.uri || ' ' || e.edge_type || ' ' || e.source AS edge
       FROM doc_edges e
       JOIN documents s ON s.id = e.src_doc_id AND s.active = 1
       JOIN documents d ON d.id = e.dst_doc_id AND d.active = 1
       ORDER BY edge`
    )
    .all()
    .map(({ edge }) => edge);

test("mutations in one collection re-resolve referrers in another; incremental equals full", async () => {
  fixture = await openLinkWorkspaceFixture();
  const f = fixture;
  const ai = f.collections.find((collection) => collection.name === "ai")!;
  const aiPath = (relPath: string) => join(ai.path, relPath);
  // Referrer in work names a file that lives deep in ai.
  await f.write(
    "work",
    "Deep Referrer.md",
    "# Deep referrer\n\n[[Deep]] [[Private]] [[Planner]]\n"
  );
  await f.write("ai", "X/Y/Deep.md", "# Deep far\n");
  await f.sync();
  const referrer = "gno://work/Deep%20Referrer.md";
  expect(edges(f)).toContain(
    `${referrer} -> gno://ai/X/Y/Deep.md mentions wikilink`
  );

  const steps: Array<[string, () => Promise<void>, (all: string[]) => void]> = [
    [
      "add a nearer duplicate",
      () => f.write("ai", "Deep.md", "# Deep near\n"),
      (all) =>
        expect(all).toContain(
          `${referrer} -> gno://ai/Deep.md mentions wikilink`
        ),
    ],
    [
      "delete the previous winner",
      () => unlink(aiPath("Deep.md")),
      (all) =>
        expect(all).toContain(
          `${referrer} -> gno://ai/X/Y/Deep.md mentions wikilink`
        ),
    ],
    [
      "rename a target",
      () => rename(aiPath("Agents/Planner.md"), aiPath("Agents/Strategist.md")),
      (all) =>
        expect(all.some((edge) => edge.includes("Planner.md"))).toBe(false),
    ],
    [
      "move a target",
      async () => {
        await mkdir(aiPath("Archive"), { recursive: true });
        await rename(aiPath("Private.md"), aiPath("Archive/Private.md"));
      },
      (all) =>
        expect(all).toContain(
          `${referrer} -> gno://ai/Archive/Private.md mentions wikilink`
        ),
    ],
  ];

  for (const [label, mutate, check] of steps) {
    await mutate();
    await f.service.syncCollection(ai, f.store);
    const incremental = edges(f);
    check(incremental);
    const errors = await projectGraph(f.store, {}, undefined, true);
    expect(errors).toEqual([]);
    expect({ label, edges: incremental }).toEqual({ label, edges: edges(f) });
  }
});

test("a workspace membership change re-projects the whole graph", async () => {
  fixture = await openLinkWorkspaceFixture();
  const before = edges(fixture);
  expect(before).toContain(
    "gno://ai/Agents/Planner.md -> gno://work/Lonely.md mentions wikilink"
  );
  // Opting ai out of the workspace changes membership: the next sync must
  // drop cross-collection edges even though no document changed.
  await fixture.reconfigure(
    fixture.collections.map((collection) =>
      collection.name === "ai"
        ? { ...collection, workspaceRoot: false }
        : collection
    )
  );
  const result = await fixture.service.syncAll(
    fixture.collections,
    fixture.store
  );
  // The fallback to a full projection is reported, never silent.
  expect(result.graphRebuild).toBe("collections-changed");
  const after = edges(fixture);
  // The plain link loses its cross-collection target; the explicit
  // [[work:Roadmap]] link is unaffected by membership.
  expect(after).not.toContain(
    "gno://ai/Agents/Planner.md -> gno://work/Lonely.md mentions wikilink"
  );
  expect(after).toContain(
    "gno://ai/Agents/Planner.md -> gno://work/Roadmap.md mentions wikilink"
  );
  expect(after).toContain(
    "gno://ai/Agents/Planner.md -> gno://ai/Titled.md mentions wikilink"
  );
  await projectGraph(fixture.store, {}, undefined, true);
  expect(edges(fixture)).toEqual(after);
});

test("the projection's referrer query finds plain links from other collections", async () => {
  fixture = await openLinkWorkspaceFixture();
  // Title "Deep far" differs from the file name, so only the workspace
  // basename clause can find the referrer in another collection.
  await fixture.write("ai", "X/Y/Deep.md", "# Deep far\n");
  await fixture.write("work", "Referrer.md", "# Referrer\n\n[[Deep]]\n");
  await fixture.sync();
  const row = fixture.store
    .getRawDb()
    .query<
      {
        id: number;
        docid: string;
        uri: string;
        title: string | null;
        mirror_hash: string | null;
        source_hash: string;
      },
      [string]
    >(
      "SELECT id, docid, uri, title, mirror_hash, source_hash FROM documents WHERE uri = ?"
    )
    .get("gno://ai/X/Y/Deep.md")!;
  const sources = fixture.store.graphReferenceStore().incomingLinkSources([
    {
      documentId: row.id,
      collection: "ai",
      relPath: "X/Y/Deep.md",
      docid: row.docid,
      uri: row.uri,
      title: row.title,
      mirrorHash: row.mirror_hash,
      sourceHash: row.source_hash,
      contentType: null,
    },
  ]);
  expect(sources).toContain(fixture.docId("gno://work/Referrer.md"));
});

test("frontmatter relations resolve like wiki links (projection vs shared resolver parity)", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-ws-parity-"));
  const store = new SqliteAdapter();
  try {
    const files: Record<string, string> = {
      "vault/A/Src.md": [
        "---",
        "relations:",
        '  related_to: ["Folder/Note.md", "Note", "Folder/Note"]',
        "---",
        "# Source",
        "",
        "[[Folder/Note.md]] [[Note]] [[Folder/Note]]",
        "",
      ].join("\n"),
      "vault/A/Folder/Note.md": "# Note in A\n",
      "vault/Folder/Note.md": "# Note in B\n",
    };
    await mkdir(join(root, "vault", ".obsidian"), { recursive: true });
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Bun.write(join(root, path), body);
    }
    const collections = [
      { name: "a", path: join(root, "vault", "A") },
      { name: "b", path: join(root, "vault", "Folder") },
    ].map((collection) => ({
      ...collection,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }));
    expect((await store.open(":memory:", "porter")).ok).toBe(true);
    expect((await store.syncCollections(collections)).ok).toBe(true);
    await new SyncService().syncAll(collections, store);
    const targets = (edgeSource: string) =>
      store
        .getRawDb()
        .query<{ uri: string }, [string]>(
          `SELECT DISTINCT d.uri FROM doc_edges e
           JOIN documents s ON s.id = e.src_doc_id
           JOIN documents d ON d.id = e.dst_doc_id
           WHERE s.uri = 'gno://a/Src.md' AND e.source = ?
           ORDER BY d.uri`
        )
        .all(edgeSource)
        .map(({ uri }) => uri);
    // Workspace path Folder/Note.md is b:Note.md; it outranks the
    // collection-relative a:Folder/Note.md for links and relations alike.
    expect(targets("wikilink")).toEqual(["gno://b/Note.md"]);
    expect(targets("frontmatter-relation")).toEqual(targets("wikilink"));
  } finally {
    await store.close();
    await safeRm(root);
  }
});
