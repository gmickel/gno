/**
 * Explicit cross-collection relocation (gno#359): a moved, unchanged file
 * keeps its document identity and derived data instead of being re-ingested.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir/rename (filesystem structure ops)
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
// Bun has no temporary-directory or path API.
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Collection } from "../../src/config/types";
import type {
  RelocationRefusalCode,
  RelocationRequest,
} from "../../src/ingestion/relocate";
import type { DirectoryAvailabilityPort } from "../../src/ingestion/source-availability";

import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  createVectorVariantStore,
  type VectorVariantStore,
} from "../../src/store/vector/variants";
import { safeRm } from "../helpers/cleanup";

const identity = {
  model: "test-model",
  modelFingerprint: "test-weights",
  contextSize: 512,
  truncationPolicy: "test-tail-v1",
  dimensions: 3,
};

let tmpDir: string;
let adapter: SqliteAdapter;
let notes: Collection;
let data: Collection;
let vectors: VectorVariantStore;
const sync = new SyncService();

const write = async (root: string, relPath: string, text: string) => {
  await mkdir(dirname(join(root, relPath)), { recursive: true });
  await writeFile(join(root, relPath), text);
};

const move = async (from: string, to: string) => {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
};

const doc = async (collection: string, relPath: string) => {
  const found = await adapter.getDocument(collection, relPath);
  if (!found.ok) throw new Error(found.error.message);
  return found.value;
};

const db = () => adapter.getRawDb();

/** Embed every pending owner with a constant vector (no model). */
const embedAll = () => {
  const pending = vectors.pending({ limit: 10_000 });
  vectors.write(
    pending.map((owner) => ({ owner, embedding: new Float32Array([1, 0, 0]) }))
  );
  return pending.length;
};

const pendingFor = (documentId: number) =>
  vectors.pending({ limit: 10_000 }).filter((o) => o.documentId === documentId)
    .length;

const ownerCount = (documentId: number) =>
  db()
    .query<{ n: number }, [number]>(
      "SELECT count(*) AS n FROM vector_owners WHERE document_id = ?"
    )
    .get(documentId)!.n;

const relocate = (requests: RelocationRequest[], dryRun = false) =>
  sync.relocateDocuments([notes, data], adapter, requests, { dryRun });

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gno-relocate-"));
  notes = {
    name: "notes",
    path: join(tmpDir, "notes"),
    pattern: "**/*",
    include: [],
    exclude: [],
  };
  data = {
    name: "data",
    path: join(tmpDir, "data"),
    pattern: "**/*",
    include: [],
    exclude: [],
  };
  await mkdir(notes.path, { recursive: true });
  await mkdir(data.path, { recursive: true });
  adapter = new SqliteAdapter();
  expect((await adapter.open(join(tmpDir, "index.db"), "porter")).ok).toBe(
    true
  );
  expect((await adapter.syncCollections([notes, data])).ok).toBe(true);
  vectors = await createVectorVariantStore(adapter.getRawDb(), identity);
});

afterEach(async () => {
  await adapter.close();
  await safeRm(tmpDir);
});

const index = async () => {
  await sync.syncCollection(notes, adapter);
  await sync.syncCollection(data, adapter);
};

describe("relocateDocuments", () => {
  test("keeps identity, chunks, tags and vectors across collections", async () => {
    await write(
      notes.path,
      "reports/q1.md",
      "---\ntags: [finance]\n---\n# Quarterly report\n\nThe zanzibar figures are in.\n"
    );
    await index();
    const before = (await doc("notes", "reports/q1.md"))!;
    expect(embedAll()).toBeGreaterThan(0);
    const chunksBefore = (await adapter.getChunks(before.mirrorHash!)).ok;
    expect(chunksBefore).toBe(true);
    const mirrorState = db()
      .query("SELECT partition_id, dirty FROM vector_mirror_state")
      .all();
    const epoch = () =>
      db()
        .query<{ epoch: number }, []>(
          "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
        )
        .get()!.epoch;
    const epochBefore = epoch();

    await move(
      join(notes.path, "reports/q1.md"),
      join(data.path, "reports/q1.md")
    );
    const result = await relocate([
      { source: "notes/reports/q1.md", destination: "data/reports/" },
    ]);
    expect(result.refused).toBe(0);
    expect(result.items[0]).toMatchObject({
      status: "relocated",
      source: "gno://notes/reports/q1.md",
      destination: "gno://data/reports/q1.md",
      documentId: before.id,
    });

    const after = (await doc("data", "reports/q1.md"))!;
    expect(after.id).toBe(before.id);
    expect(after.docid).toBe(before.docid);
    expect(after.mirrorHash).toBe(before.mirrorHash);
    expect(after.uri).toBe("gno://data/reports/q1.md");
    expect(await doc("notes", "reports/q1.md")).toBeNull();
    expect(ownerCount(after.id)).toBeGreaterThan(0);
    expect(pendingFor(after.id)).toBe(0);
    const tags = await adapter.getTagsForDoc(after.id);
    expect(tags.ok && tags.value.map((t) => t.tag)).toEqual(["finance"]);

    // Text search finds it under the destination only.
    const inData = await adapter.searchFts("zanzibar", { collection: "data" });
    expect(inData.ok && inData.value.map((r) => r.uri)).toEqual([
      "gno://data/reports/q1.md",
    ]);
    const inNotes = await adapter.searchFts("zanzibar", {
      collection: "notes",
    });
    expect(inNotes.ok && inNotes.value).toEqual([]);
    const filepath = db()
      .query<{ filepath: string }, [number]>(
        "SELECT filepath FROM documents_fts WHERE rowid = ?"
      )
      .get(after.id);
    expect(filepath?.filepath).toBe("reports/q1.md");

    // The vector index mirror stays clean; epoch fences still advance.
    expect(
      db().query("SELECT partition_id, dirty FROM vector_mirror_state").all()
    ).toEqual(mirrorState);
    expect(epoch()).toBeGreaterThan(epochBefore);

    // Both collections' change feeds record the move.
    const changes = await adapter.listDocumentChanges();
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    const renames = changes.value.changes.filter((c) => c.kind === "rename");
    expect(renames.map((c) => c.collection).sort()).toEqual(["data", "notes"]);
    expect(renames[0]).toMatchObject({
      documentId: before.id,
      oldUri: "gno://notes/reports/q1.md",
      newUri: "gno://data/reports/q1.md",
    });

    // A following update has nothing to do for the moved file.
    const notesSync = await sync.syncCollection(notes, adapter);
    const dataSync = await sync.syncCollection(data, adapter);
    expect(notesSync.filesAdded + dataSync.filesAdded).toBe(0);
    expect(notesSync.filesMarkedInactive + dataSync.filesMarkedInactive).toBe(
      0
    );
    expect(dataSync.filesUnchanged).toBe(1);
    expect((await doc("data", "reports/q1.md"))!.id).toBe(before.id);
    expect(pendingFor(before.id)).toBe(0);
  });

  test("moves a folder and re-derives path-dependent metadata and links", async () => {
    await write(
      notes.path,
      "archive/notes/a.md",
      "# Alpha\n\nSee [beta](sub/b.md).\n"
    );
    await write(notes.path, "archive/notes/sub/b.md", "# Beta\n\nBody.\n");
    await write(notes.path, "keep.md", "# Keep\n");
    await index();
    const a = (await doc("notes", "archive/notes/a.md"))!;
    expect(a.contentType).toBe("notes");
    const linksBefore = await adapter.getLinksForDoc(a.id);
    expect(linksBefore.ok && linksBefore.value[0]?.targetRefNorm).toBe(
      "archive/notes/sub/b.md"
    );

    await move(join(notes.path, "archive"), join(data.path, "spec"));
    const result = await relocate([
      { source: "notes/archive/", destination: "data/spec/" },
    ]);
    expect(result.relocated).toBe(2);
    expect(result.refused).toBe(0);

    const moved = (await doc("data", "spec/notes/a.md"))!;
    expect(moved.id).toBe(a.id);
    // Path-based content type follows the new path, as a re-ingest would.
    expect(moved.contentType).toBe("spec");
    const linksAfter = await adapter.getLinksForDoc(a.id);
    expect(linksAfter.ok && linksAfter.value[0]?.targetRefNorm).toBe(
      "spec/notes/sub/b.md"
    );
    const backlinks = await adapter.getBacklinksForDoc(
      (await doc("data", "spec/notes/sub/b.md"))!.id
    );
    expect(backlinks.ok && backlinks.value.map((l) => l.sourceDocId)).toEqual([
      a.id,
    ]);
    expect((await doc("notes", "keep.md"))?.active).toBe(true);

    // The graph projection is current for the moved documents.
    const state = db()
      .query<{ dirty: number }, []>(
        "SELECT dirty FROM graph_projection_state WHERE id = 1"
      )
      .get();
    expect(state?.dirty).toBe(0);
    const inventory = db()
      .query<{ collection: string; rel_path: string }, [number]>(
        "SELECT collection, rel_path FROM graph_reference_documents WHERE document_id = ?"
      )
      .get(a.id);
    expect(inventory).toEqual({
      collection: "data",
      rel_path: "spec/notes/a.md",
    });
  });

  test("re-derives content type from the new path", async () => {
    await write(notes.path, "meetings/standup.md", "# Daily\n\nText.\n");
    await index();
    const before = (await doc("notes", "meetings/standup.md"))!;
    expect(before.contentType).toBe("meeting");
    await move(
      join(notes.path, "meetings/standup.md"),
      join(data.path, "misc/standup.md")
    );
    const result = await relocate([
      { source: "notes/meetings/standup.md", destination: "data/misc/" },
    ]);
    expect(result.relocated).toBe(1);
    // "standup" still names a meeting; the folder no longer matters here.
    expect((await doc("data", "misc/standup.md"))!.contentType).toBe("meeting");
  });

  test("a renamed file whose title comes from its name re-embeds but keeps its id", async () => {
    await write(notes.path, "old-name.txt", "plain text without a heading\n");
    await index();
    const before = (await doc("notes", "old-name.txt"))!;
    expect(before.title).toBe("old-name");
    embedAll();
    await move(
      join(notes.path, "old-name.txt"),
      join(data.path, "new-name.txt")
    );

    const result = await relocate([
      { source: "notes/old-name.txt", destination: "data/new-name.txt" },
    ]);
    expect(result.items[0]).toMatchObject({
      status: "relocated",
      titleChanged: true,
    });
    const after = (await doc("data", "new-name.txt"))!;
    expect(after.id).toBe(before.id);
    expect(after.title).toBe("new-name");
    // Stale vectors are not kept: the owners are pending again.
    expect(pendingFor(after.id)).toBeGreaterThan(0);
    const fts = db()
      .query<{ title: string; filepath: string }, [number]>(
        "SELECT title, filepath FROM documents_fts WHERE rowid = ?"
      )
      .get(after.id);
    expect(fts).toEqual({ title: "new-name", filepath: "new-name.txt" });
    const dataSync = await sync.syncCollection(data, adapter);
    expect(dataSync.filesUnchanged).toBe(1);
  });

  test("a renamed file with a content title keeps its vectors", async () => {
    await write(notes.path, "draft.md", "# Stable Title\n\nBody text.\n");
    await index();
    const before = (await doc("notes", "draft.md"))!;
    embedAll();
    await move(join(notes.path, "draft.md"), join(data.path, "final.md"));
    const result = await relocate([
      { source: before.docid, destination: "data/final.md" },
    ]);
    expect(result.items[0]).toMatchObject({
      status: "relocated",
      titleChanged: false,
    });
    expect(pendingFor(before.id)).toBe(0);
  });

  test("dry run reports without writing", async () => {
    await write(notes.path, "x.md", "# X\n");
    await index();
    await move(join(notes.path, "x.md"), join(data.path, "x.md"));
    const result = await relocate(
      [{ source: "notes/x.md", destination: "data" }],
      true
    );
    expect(result).toMatchObject({ dryRun: true, relocated: 1, refused: 0 });
    expect(result.items[0]?.status).toBe("would_relocate");
    expect((await doc("notes", "x.md"))?.active).toBe(true);
    expect(await doc("data", "x.md")).toBeNull();
  });

  describe("refusals leave the index unchanged", () => {
    const expectRefused = async (
      requests: RelocationRequest[],
      code: RelocationRefusalCode
    ) => {
      const snapshot = db()
        .query(
          "SELECT id, collection, rel_path, active FROM documents ORDER BY id"
        )
        .all();
      const result = await relocate(requests);
      expect(result.relocated).toBe(0);
      expect(result.items.map((i) => i.code)).toContain(code);
      expect(
        db()
          .query(
            "SELECT id, collection, rel_path, active FROM documents ORDER BY id"
          )
          .all()
      ).toEqual(snapshot);
    };

    test("destination already indexed", async () => {
      await write(notes.path, "a.md", "# A\n");
      await index();
      await move(join(notes.path, "a.md"), join(data.path, "a.md"));
      await sync.syncCollection(data, adapter);
      await expectRefused(
        [{ source: "notes/a.md", destination: "data" }],
        "DESTINATION_EXISTS"
      );
    });

    test("ambiguous docid of identical copies", async () => {
      await write(notes.path, "one.md", "# Same\n");
      await write(notes.path, "two.md", "# Same\n");
      await index();
      const one = (await doc("notes", "one.md"))!;
      await expectRefused(
        [{ source: one.docid, destination: "data" }],
        "AMBIGUOUS"
      );
    });

    test("two documents to one destination", async () => {
      await write(notes.path, "d1/same.md", "# One\n");
      await write(notes.path, "d2/same.md", "# Two\n");
      await index();
      await move(join(notes.path, "d1/same.md"), join(data.path, "same.md"));
      await expectRefused(
        [
          { source: "notes/d1/same.md", destination: "data" },
          { source: "notes/d2/same.md", destination: "data" },
        ],
        "AMBIGUOUS"
      );
    });

    test("changed bytes", async () => {
      await write(notes.path, "c.md", "# C\n");
      await index();
      await move(join(notes.path, "c.md"), join(data.path, "c.md"));
      await writeFile(join(data.path, "c.md"), "# C edited\n");
      await expectRefused(
        [{ source: "notes/c.md", destination: "data" }],
        "SOURCE_CHANGED"
      );
    });

    test("old path still present (a copy)", async () => {
      await write(notes.path, "copy.md", "# Copy\n");
      await write(data.path, "copy.md", "# Copy\n");
      await sync.syncCollection(notes, adapter);
      await expectRefused(
        [{ source: "notes/copy.md", destination: "data" }],
        "SOURCE_STILL_PRESENT"
      );
    });

    test("no file at the destination", async () => {
      await write(notes.path, "gone.md", "# Gone\n");
      await index();
      await move(join(notes.path, "gone.md"), join(tmpDir, "gone.md"));
      await expectRefused(
        [{ source: "notes/gone.md", destination: "data" }],
        "DESTINATION_MISSING"
      );
    });

    test("changed extension", async () => {
      await write(notes.path, "e.md", "plain\n");
      await index();
      await move(join(notes.path, "e.md"), join(data.path, "e.txt"));
      await expectRefused(
        [{ source: "notes/e.md", destination: "data/e.txt" }],
        "INCOMPATIBLE"
      );
    });

    test("different language hints", async () => {
      data = { ...data, languageHint: "de" };
      await write(notes.path, "l.md", "# L\n");
      await sync.syncCollection(notes, adapter);
      await move(join(notes.path, "l.md"), join(data.path, "l.md"));
      await expectRefused(
        [{ source: "notes/l.md", destination: "data" }],
        "INCOMPATIBLE"
      );
    });

    test("destination excluded by the collection's rules", async () => {
      data = { ...data, exclude: ["private"] };
      await write(notes.path, "p.md", "# P\n");
      await sync.syncCollection(notes, adapter);
      await move(join(notes.path, "p.md"), join(data.path, "private/p.md"));
      await expectRefused(
        [{ source: "notes/p.md", destination: "data/private/" }],
        "DESTINATION_NOT_ELIGIBLE"
      );
    });

    test("unknown collection and bad references", async () => {
      await write(notes.path, "u.md", "# U\n");
      await index();
      await expectRefused(
        [{ source: "notes/u.md", destination: "nowhere" }],
        "NOT_FOUND"
      );
      await expectRefused(
        [{ source: "notes/", destination: "data/file.md" }],
        "INVALID_REFERENCE"
      );
    });

    test("a row changed by another writer after planning", async () => {
      await write(notes.path, "w.md", "# W\n");
      await index();
      const row = (await doc("notes", "w.md"))!;
      const moved = await adapter.relocateDocument({
        documentId: row.id,
        expected: {
          collection: "notes",
          relPath: "w.md",
          sourceHash: "stale",
          mirrorHash: row.mirrorHash!,
        },
        collection: "data",
        relPath: "w.md",
      });
      expect(moved.ok).toBe(false);
      if (!moved.ok) expect(moved.error.code).toBe("CONSTRAINT_VIOLATION");
      expect((await doc("notes", "w.md"))?.active).toBe(true);
    });
  });

  test("nested collection roots: the same physical file changes collection", async () => {
    const inner: Collection = {
      name: "inner",
      path: join(notes.path, "inner"),
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    expect((await adapter.syncCollections([notes, data, inner])).ok).toBe(true);
    await write(notes.path, "inner/n.md", "# Nested\n");
    await sync.syncCollection(notes, adapter);
    const before = (await doc("notes", "inner/n.md"))!;

    // While the outer collection still indexes the file, the move is refused.
    const stillIndexed = await sync.relocateDocuments(
      [notes, data, inner],
      adapter,
      [{ source: "notes/inner/n.md", destination: "inner" }]
    );
    expect(stillIndexed.items[0]?.code).toBe("SOURCE_STILL_PRESENT");

    notes = { ...notes, exclude: ["inner"] };
    const result = await sync.relocateDocuments([notes, data, inner], adapter, [
      { source: "notes/inner/n.md", destination: "inner" },
    ]);
    expect(result.items[0]?.status).toBe("relocated");
    expect((await doc("inner", "n.md"))!.id).toBe(before.id);
    const update = await sync.syncAll([notes, data, inner], adapter);
    expect(update.totalFilesAdded).toBe(0);
    expect(await doc("notes", "inner/n.md")).toBeNull();
  });

  test("refuses an aliased destination path", async () => {
    await write(notes.path, "alias.md", "# Alias\n");
    await index();
    await move(join(notes.path, "alias.md"), join(data.path, "docs/alias.md"));
    for (const destination of [
      "data/docs//alias.md",
      "data/./docs/alias.md",
      "data/docs/../docs/alias.md",
    ]) {
      const result = await relocate([
        { source: "notes/alias.md", destination },
      ]);
      expect(result.items[0]?.code).toBe("DESTINATION_NOT_ELIGIBLE");
    }
    await symlink(join(data.path, "docs"), join(data.path, "link"));
    const viaLink = await relocate([
      { source: "notes/alias.md", destination: "data/link/alias.md" },
    ]);
    expect(viaLink.items[0]?.code).toBe("DESTINATION_NOT_ELIGIBLE");
    expect((await doc("notes", "alias.md"))?.active).toBe(true);
  });

  test("refuses chunks built under another chunking policy", async () => {
    await write(notes.path, "policy.md", "# Policy\n\nBody.\n");
    await index();
    await move(join(notes.path, "policy.md"), join(data.path, "policy.md"));
    const result = await sync.relocateDocuments(
      [notes, data],
      adapter,
      [{ source: "notes/policy.md", destination: "data" }],
      { chunking: { maxTokens: 100 } }
    );
    expect(result.items[0]?.code).toBe("NEEDS_REINDEX");
  });

  test("refuses a stored language that the destination would not derive", async () => {
    notes = { ...notes, languageHint: "en" };
    await write(notes.path, "lang.md", "# Lang\n");
    await sync.syncCollection(notes, adapter);
    await move(join(notes.path, "lang.md"), join(data.path, "lang.md"));
    notes = { ...notes, languageHint: "de" };
    data = { ...data, languageHint: "de" };
    const result = await relocate([
      { source: "notes/lang.md", destination: "data" },
    ]);
    expect(result.items[0]?.code).toBe("INCOMPATIBLE");
  });

  test("refuses a stored language hint once both collections drop theirs", async () => {
    notes = { ...notes, languageHint: "en" };
    await write(notes.path, "hint.md", "# Hint\n");
    await sync.syncCollection(notes, adapter);
    await move(join(notes.path, "hint.md"), join(data.path, "hint.md"));
    notes = { ...notes, languageHint: undefined };
    const result = await relocate([
      { source: "notes/hint.md", destination: "data" },
    ]);
    expect(result.items[0]?.code).toBe("INCOMPATIBLE");
  });

  test("lists a local source root only under the availability guard", async () => {
    await write(notes.path, "g.md", "# Guarded\n");
    await index();
    await move(join(notes.path, "g.md"), join(data.path, "g.md"));
    const guarded = new SyncService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (mode): DirectoryAvailabilityPort => ({
        mode,
        classify: async () => ({ kind: "available" }),
        readDirectory: () => ({
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "root became dataless",
        }),
      })
    );
    const result = await guarded.relocateDocuments(
      [{ ...notes, sourceAvailability: "local" }, data],
      adapter,
      [{ source: "notes/g.md", destination: "data" }]
    );
    expect(result.items[0]).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      message: "root became dataless",
    });
  });

  test("refuses when source availability cannot prove the old path is gone", async () => {
    await write(notes.path, "cloud/c.md", "# Cloud\n");
    await index();
    await move(join(notes.path, "cloud/c.md"), join(data.path, "c.md"));
    const guarded = new SyncService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (): DirectoryAvailabilityPort => ({
        mode: "local",
        classify: async (absPath) =>
          absPath.startsWith(notes.path)
            ? {
                kind: "dataless",
                code: "DATALESS_DIRECTORY",
                message: "not materialized",
              }
            : { kind: "available" },
        readDirectory: () => {
          throw new Error("not used by relocation");
        },
      })
    );
    const result = await guarded.relocateDocuments(
      [{ ...notes, sourceAvailability: "local" }, data],
      adapter,
      [{ source: "notes/cloud/c.md", destination: "data" }]
    );
    expect(result.items[0]?.code).toBe("SOURCE_UNAVAILABLE");
  });
});
