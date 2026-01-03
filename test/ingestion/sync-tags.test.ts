/**
 * Integration tests for tag extraction during sync.
 *
 * @module test/ingestion/sync-tags
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { INGEST_VERSION, SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

describe("SyncService tag extraction", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-tags-test-"));
    collectionDir = join(tmpDir, "docs");
    await Bun.$`mkdir -p ${collectionDir}`;
    dbPath = join(tmpDir, "test.db");

    adapter = new SqliteAdapter();
    const openResult = await adapter.open(dbPath, "porter");
    expect(openResult.ok).toBe(true);

    collection = {
      name: "docs",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };

    const syncResult = await adapter.syncCollections([collection]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("extracts tags from frontmatter during sync", async () => {
    // Create a markdown file with frontmatter tags
    const content = `---
title: Test Document
tags:
  - work
  - project
---
# Test

Some content here.
`;
    await writeFile(join(collectionDir, "test.md"), content);

    // Sync the collection
    const syncService = new SyncService();
    const result = await syncService.syncCollection(collection, adapter);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesAdded).toBe(1);

    // Get the document ID
    const docResult = await adapter.getDocument("docs", "test.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    // Verify tags were extracted
    const tagsResult = await adapter.getTagsForDoc(docResult.value.id);
    expect(tagsResult.ok).toBe(true);
    if (!tagsResult.ok) return;

    const tags = tagsResult.value.map((t) => t.tag);
    expect(tags).toContain("work");
    expect(tags).toContain("project");
  });

  test("extracts hashtags from body during sync", async () => {
    // Create a markdown file with inline hashtags
    const content = `# Notes

This is about #work and #productivity.

Some more content with #project/frontend tag.
`;
    await writeFile(join(collectionDir, "notes.md"), content);

    // Sync the collection
    const syncService = new SyncService();
    const result = await syncService.syncCollection(collection, adapter);

    expect(result.filesProcessed).toBe(1);

    // Get the document ID
    const docResult = await adapter.getDocument("docs", "notes.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    // Verify tags were extracted
    const tagsResult = await adapter.getTagsForDoc(docResult.value.id);
    expect(tagsResult.ok).toBe(true);
    if (!tagsResult.ok) return;

    const tags = tagsResult.value.map((t) => t.tag);
    expect(tags).toContain("work");
    expect(tags).toContain("productivity");
    expect(tags).toContain("project/frontend");
  });

  test("combines frontmatter and hashtag tags", async () => {
    const content = `---
tags: [important]
---
# Document

This is #work related.
`;
    await writeFile(join(collectionDir, "combined.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "combined.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const tagsResult = await adapter.getTagsForDoc(docResult.value.id);
    expect(tagsResult.ok).toBe(true);
    if (!tagsResult.ok) return;

    const tags = tagsResult.value.map((t) => t.tag);
    expect(tags).toContain("important");
    expect(tags).toContain("work");
  });

  test("deduplicates tags from frontmatter and body", async () => {
    const content = `---
tags: [work]
---
# Document

This is #work related.
`;
    await writeFile(join(collectionDir, "dedup.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "dedup.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const tagsResult = await adapter.getTagsForDoc(docResult.value.id);
    expect(tagsResult.ok).toBe(true);
    if (!tagsResult.ok) return;

    // Only one "work" tag
    expect(tagsResult.value).toHaveLength(1);
    expect(tagsResult.value[0]?.tag).toBe("work");
  });

  test("sets ingest version on new documents", async () => {
    await writeFile(join(collectionDir, "new.md"), "# New document");

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "new.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    expect(docResult.value.ingestVersion).toBe(INGEST_VERSION);
  });
});

describe("SyncService version-aware backfill", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-backfill-test-"));
    collectionDir = join(tmpDir, "docs");
    await Bun.$`mkdir -p ${collectionDir}`;
    dbPath = join(tmpDir, "test.db");

    adapter = new SqliteAdapter();
    const openResult = await adapter.open(dbPath, "porter");
    expect(openResult.ok).toBe(true);

    collection = {
      name: "docs",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };

    const syncResult = await adapter.syncCollections([collection]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("re-processes documents with outdated ingest version", async () => {
    // Create and sync a document
    const content = `---
tags: [original]
---
# Document

Content here.
`;
    await writeFile(join(collectionDir, "versioned.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    // Manually set ingest version to 1 (outdated)
    // This simulates a document from before tag extraction was added
    const db = (adapter as unknown as { db?: { run: (sql: string) => void } })
      .db;
    if (db) {
      db.run(
        "UPDATE documents SET ingest_version = 1 WHERE rel_path = 'versioned.md'"
      );
    }

    // Verify version was changed
    const beforeDoc = await adapter.getDocument("docs", "versioned.md");
    expect(beforeDoc.ok).toBe(true);
    if (!beforeDoc.ok || !beforeDoc.value) return;
    expect(beforeDoc.value.ingestVersion).toBe(1);

    // Sync again - should re-process due to version mismatch
    const result = await syncService.syncCollection(collection, adapter);

    // Document should be updated (not skipped)
    expect(result.filesUpdated).toBe(1);
    expect(result.filesUnchanged).toBe(0);

    // Verify ingest version is now current
    const afterDoc = await adapter.getDocument("docs", "versioned.md");
    expect(afterDoc.ok).toBe(true);
    if (!afterDoc.ok || !afterDoc.value) return;
    expect(afterDoc.value.ingestVersion).toBe(INGEST_VERSION);

    // Verify tags were extracted during re-processing
    const tagsResult = await adapter.getTagsForDoc(afterDoc.value.id);
    expect(tagsResult.ok).toBe(true);
    if (!tagsResult.ok) return;
    expect(tagsResult.value.map((t) => t.tag)).toContain("original");
  });
});
