/**
 * Integration tests for link extraction during sync.
 *
 * @module test/ingestion/sync-links
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { INGEST_VERSION, SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("SyncService link extraction", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-links-test-"));
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
    await safeRm(tmpDir);
  });

  test("extracts wiki links during sync", async () => {
    const content = `# Notes

See [[Meeting Notes]] for details.

Also check [[Project Plan]].
`;
    await writeFile(join(collectionDir, "index.md"), content);

    const syncService = new SyncService();
    const result = await syncService.syncCollection(collection, adapter);

    expect(result.filesProcessed).toBe(1);
    expect(result.filesAdded).toBe(1);

    const docResult = await adapter.getDocument("docs", "index.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(2);

    const targets = linksResult.value.map((l) => l.targetRef);
    expect(targets).toContain("Meeting Notes");
    expect(targets).toContain("Project Plan");

    // Verify link types
    expect(linksResult.value.every((l) => l.linkType === "wiki")).toBe(true);
  });

  test("extracts path-style wiki links during sync", async () => {
    const content = `# Notes

See [[Folder/Note.md]] and [[Folder/Note]] and [[02 Action/Projects/Task.md]].
`;
    await writeFile(join(collectionDir, "paths.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "paths.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    const targets = linksResult.value.map((l) => l.targetRefNorm);
    expect(targets).toContain("folder/note.md");
    expect(targets).toContain("folder/note");
    expect(targets).toContain("02 action/projects/task.md");
  });

  test("extracts markdown links during sync", async () => {
    const content = `# Guide

Check the [installation guide](./install.md) first.

Then read [advanced setup](./docs/advanced.md#config).
`;
    await writeFile(join(collectionDir, "readme.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "readme.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(2);

    // Check first link
    const installLink = linksResult.value.find(
      (l) => l.targetRef === "./install.md"
    );
    expect(installLink).toBeDefined();
    expect(installLink?.linkType).toBe("markdown");
    expect(installLink?.targetRefNorm).toBe("install.md");

    // Check second link with anchor
    const advancedLink = linksResult.value.find((l) =>
      l.targetRef.includes("advanced")
    );
    expect(advancedLink).toBeDefined();
    expect(advancedLink?.targetAnchor).toBe("config");
  });

  test("extracts wiki links with anchors", async () => {
    const content = `# FAQ

See [[Guide#Installation]] for setup.
`;
    await writeFile(join(collectionDir, "faq.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "faq.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.targetRef).toBe("Guide");
    expect(linksResult.value[0]?.targetAnchor).toBe("Installation");
  });

  test("extracts wiki links with aliases", async () => {
    const content = `# Notes

Check [[Meeting Notes|the meeting]] for updates.
`;
    await writeFile(join(collectionDir, "notes.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "notes.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.targetRef).toBe("Meeting Notes");
    expect(linksResult.value[0]?.linkText).toBe("the meeting");
  });

  test("skips links inside code blocks", async () => {
    const content = `# Example

\`\`\`markdown
Use [[Wiki Syntax]] for links.
\`\`\`

But [[Real Link]] works.
`;
    await writeFile(join(collectionDir, "example.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "example.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.targetRef).toBe("Real Link");
  });

  test("skips external URLs", async () => {
    const content = `# Resources

Check [Google](https://google.com) and [local docs](./local.md).
`;
    await writeFile(join(collectionDir, "resources.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "resources.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.targetRef).toBe("./local.md");
  });

  test("skips markdown links with collection prefix", async () => {
    // Markdown links with collection: prefix are not supported
    // (use wiki links for cross-collection references)
    const content = `# Refs

Cross-collection: [guide](other:guide.md) should be skipped.
Local: [local](./local.md) should work.
Wiki cross-collection: [[other:Guide]] should work.
`;
    await writeFile(join(collectionDir, "refs.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "refs.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    // Should only have 2 links: local markdown and wiki cross-collection
    // The markdown with collection prefix should be skipped
    expect(linksResult.value).toHaveLength(2);

    const types = linksResult.value.map((l) => l.linkType);
    expect(types).toContain("markdown");
    expect(types).toContain("wiki");

    const mdLink = linksResult.value.find((l) => l.linkType === "markdown");
    expect(mdLink?.targetRef).toBe("./local.md");

    const wikiLink = linksResult.value.find((l) => l.linkType === "wiki");
    expect(wikiLink?.targetRef).toBe("Guide");
    expect(wikiLink?.targetCollection).toBe("other");
  });

  test("normalizes wiki links for matching", async () => {
    const content = `# Notes

See [[My Note]] for details.
`;
    await writeFile(join(collectionDir, "source.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "source.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    // targetRefNorm should be lowercase normalized
    expect(linksResult.value[0]?.targetRefNorm).toBe("my note");
  });

  test("resolves relative markdown paths", async () => {
    // Create nested directory structure
    await Bun.$`mkdir -p ${join(collectionDir, "docs")}`;

    const content = `# Page

See [parent](../readme.md) and [sibling](./guide.md).
`;
    await writeFile(join(collectionDir, "docs/page.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "docs/page.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(2);

    // Check that paths are resolved
    const parentLink = linksResult.value.find((l) =>
      l.targetRef.includes("readme")
    );
    expect(parentLink?.targetRefNorm).toBe("readme.md");

    const siblingLink = linksResult.value.find((l) =>
      l.targetRef.includes("guide")
    );
    expect(siblingLink?.targetRefNorm).toBe("docs/guide.md");
  });

  test("stores correct line/column positions", async () => {
    const content = `Line 1
[[Link on Line 2]]
Line 3`;
    await writeFile(join(collectionDir, "positions.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "positions.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.startLine).toBe(2);
    expect(linksResult.value[0]?.startCol).toBe(1);
  });

  test("updates links when document is re-synced", async () => {
    // Create initial document
    const initialContent = `# Notes
See [[Old Link]].
`;
    await writeFile(join(collectionDir, "updated.md"), initialContent);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    // Update document with different link
    const updatedContent = `# Notes
See [[New Link]].
`;
    await writeFile(join(collectionDir, "updated.md"), updatedContent);

    // Sync again
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "updated.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    // Should only have the new link
    expect(linksResult.value).toHaveLength(1);
    expect(linksResult.value[0]?.targetRef).toBe("New Link");
  });

  test("clears links when document has none", async () => {
    // Create document with link
    const withLinks = `# Notes
See [[Link]].
`;
    await writeFile(join(collectionDir, "cleared.md"), withLinks);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    // Update to remove links
    const noLinks = `# Notes
No links here.
`;
    await writeFile(join(collectionDir, "cleared.md"), noLinks);

    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "cleared.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    const linksResult = await adapter.getLinksForDoc(docResult.value.id);
    expect(linksResult.ok).toBe(true);
    if (!linksResult.ok) return;

    expect(linksResult.value).toHaveLength(0);
  });

  test("sets correct ingest version with links", async () => {
    const content = `# Notes
See [[Link]].
`;
    await writeFile(join(collectionDir, "versioned.md"), content);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const docResult = await adapter.getDocument("docs", "versioned.md");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value) return;

    expect(docResult.value.ingestVersion).toBe(INGEST_VERSION);
  });
});

describe("SyncService backlinks integration", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-backlinks-test-"));
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
    await safeRm(tmpDir);
  });

  test("finds backlinks via wiki link normalization", async () => {
    // Create target and source documents
    const targetContent = `# Target Note

This is the target.
`;
    const sourceContent = `# Source

See [[Target Note]] for more.
`;
    await writeFile(join(collectionDir, "target.md"), targetContent);
    await writeFile(join(collectionDir, "source.md"), sourceContent);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    // Get target document
    const targetDoc = await adapter.getDocument("docs", "target.md");
    expect(targetDoc.ok).toBe(true);
    if (!targetDoc.ok || !targetDoc.value) return;

    // Get backlinks
    const backlinks = await adapter.getBacklinksForDoc(targetDoc.value.id);
    expect(backlinks.ok).toBe(true);
    if (!backlinks.ok) return;

    expect(backlinks.value).toHaveLength(1);
    expect(backlinks.value[0]?.sourceDocUri).toContain("source.md");
  });

  test("finds backlinks via markdown path", async () => {
    // Create target and source documents
    const targetContent = `# Guide

This is the guide.
`;
    const sourceContent = `# Index

Read [the guide](./guide.md) first.
`;
    await writeFile(join(collectionDir, "guide.md"), targetContent);
    await writeFile(join(collectionDir, "index.md"), sourceContent);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    // Get target document
    const targetDoc = await adapter.getDocument("docs", "guide.md");
    expect(targetDoc.ok).toBe(true);
    if (!targetDoc.ok || !targetDoc.value) return;

    // Get backlinks
    const backlinks = await adapter.getBacklinksForDoc(targetDoc.value.id);
    expect(backlinks.ok).toBe(true);
    if (!backlinks.ok) return;

    expect(backlinks.value).toHaveLength(1);
    expect(backlinks.value[0]?.sourceDocUri).toContain("index.md");
  });

  test("finds backlinks via path-style wiki links", async () => {
    const targetContent = `# Target Note

This is the target.
`;
    const sourceContent = `# Source

See [[vault/Target Note.md]] for more.
`;
    await writeFile(join(collectionDir, "target.md"), targetContent);
    await writeFile(join(collectionDir, "source.md"), sourceContent);

    const syncService = new SyncService();
    await syncService.syncCollection(collection, adapter);

    const targetDoc = await adapter.getDocument("docs", "target.md");
    expect(targetDoc.ok).toBe(true);
    if (!targetDoc.ok || !targetDoc.value) return;

    const backlinks = await adapter.getBacklinksForDoc(targetDoc.value.id);
    expect(backlinks.ok).toBe(true);
    if (!backlinks.ok) return;

    expect(backlinks.value).toHaveLength(1);
    expect(backlinks.value[0]?.sourceDocUri).toContain("source.md");
  });
});
