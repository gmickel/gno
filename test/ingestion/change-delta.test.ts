import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import {
  diffDocumentStructure,
  extractDocumentStructure,
} from "../../src/core/change-diff";
import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

describe("sync document change deltas", () => {
  let adapter: SqliteAdapter;
  let collection: Collection;
  let collectionDir = "";
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-change-delta-test-"));
    collectionDir = join(testDir, "notes");
    await mkdir(collectionDir);
    collection = {
      name: "notes",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBe(true);
    expect((await adapter.syncCollections([collection])).ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("journals exact heading, link, typed-edge, date, and hash transitions", async () => {
    const path = join(collectionDir, "source.md");
    await Bun.write(
      path,
      `---
date: 2026-01-01
deadline: 2026-02-01
relations:
  Depends On:
    - "[[Old Target]]"
---
# Alpha
## Removed
See [[Old Target]] and [old guide](./old.md#Part).
`
    );
    const service = new SyncService();
    await service.syncCollection(collection, adapter);
    const firstDocument = await adapter.getDocument("notes", "source.md");
    expect(firstDocument.ok && firstDocument.value).toBeTruthy();
    if (!firstDocument.ok || !firstDocument.value) return;

    await Bun.write(
      path,
      `---
date: 2026-01-02
created: 2025-12-01
relations:
  Depends On:
    - "[[New Target]]"
---
# Alpha
## Added
See [[New Target]] and [new guide](./new.md#Next).
`
    );
    await service.syncCollection(collection, adapter);
    const secondDocument = await adapter.getDocument("notes", "source.md");
    expect(secondDocument.ok && secondDocument.value).toBeTruthy();
    if (!secondDocument.ok || !secondDocument.value) return;

    const changes = await adapter.listDocumentChanges();
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.value.changes).toHaveLength(2);
    expect(changes.value.changes[1]).toMatchObject({
      kind: "update",
      oldSourceHash: firstDocument.value.sourceHash,
      newSourceHash: secondDocument.value.sourceHash,
      oldMirrorHash: firstDocument.value.mirrorHash,
      newMirrorHash: secondDocument.value.mirrorHash,
      structureDelta: {
        headings: { added: ["## Added"], removed: ["## Removed"] },
        links: {
          added: ["markdown:new.md#next", "wiki:new target"],
          removed: ["markdown:old.md#part", "wiki:old target"],
        },
        typedEdges: {
          added: ["depends_on:new target"],
          removed: ["depends_on:old target"],
        },
        dates: {
          added: ["created"],
          removed: ["deadline"],
          changed: ["date"],
        },
        truncated: false,
      },
    });

    await service.syncCollection(collection, adapter);
    const afterNoop = await adapter.listDocumentChanges();
    expect(afterNoop.ok && afterNoop.value.changes).toHaveLength(2);
  });

  test("coalesces concurrent same-generation syncs into one update", async () => {
    const path = join(collectionDir, "race.md");
    await Bun.write(path, "# First\n\n[[One]]\n");
    const service = new SyncService();
    await service.syncCollection(collection, adapter);

    await Bun.write(path, "# Second\n\n[[Two]]\n");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.syncPaths(collection, adapter, ["race.md"])
      )
    );
    expect(results.every((result) => result.filesErrored === 0)).toBe(true);

    const changes = await adapter.listDocumentChanges();
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "update",
    ]);
    expect(changes.value.changes[1]?.structureDelta).toMatchObject({
      headings: { added: ["# Second"], removed: ["# First"] },
      links: { added: ["wiki:two"], removed: ["wiki:one"] },
    });
  });

  test("bounds large structural changes with explicit truncation", async () => {
    const headings = Array.from(
      { length: 40 },
      (_, index) => `## Heading ${index}`
    ).join("\n");
    await Bun.write(join(collectionDir, "large.md"), `# Root\n${headings}\n`);
    await new SyncService().syncCollection(collection, adapter);

    const changes = await adapter.listDocumentChanges();
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    const delta = changes.value.changes[0]?.structureDelta;
    expect(delta?.truncated).toBe(true);
    expect(delta?.headings.added).toHaveLength(16);
    expect(JSON.stringify(delta)).not.toContain("Heading 39");
  });

  test("discloses unavailable prior structure without inventing removals", () => {
    const next = extractDocumentStructure("# Current\n\n[[Target]]\n", "a.md", {
      date: "2026-01-01T00:00:00.000Z",
    });
    const result = diffDocumentStructure(undefined, next);

    expect(result.history).toBe("unavailable");
    expect(result.delta.truncated).toBe(true);
    expect(result.delta.headings).toEqual({ added: [], removed: [] });
    expect(result.delta.links).toEqual({ added: [], removed: [] });
    expect(result.delta.dates).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  test("journals a truncated delta when prior mirror history is unavailable", async () => {
    const path = join(collectionDir, "missing-history.md");
    await Bun.write(path, "# Before\n\n[[Old]]\n");
    const service = new SyncService();
    await service.syncCollection(collection, adapter);
    const document = await adapter.getDocument("notes", "missing-history.md");
    expect(document.ok && document.value?.mirrorHash).toBeTruthy();
    if (!document.ok || !document.value?.mirrorHash) return;

    adapter
      .getRawDb()
      .run("DELETE FROM content WHERE mirror_hash = ?", [
        document.value.mirrorHash,
      ]);
    await Bun.write(path, "# After\n\n[[New]]\n");
    await service.syncCollection(collection, adapter);

    const changes = await adapter.listDocumentChanges();
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.value.changes[1]?.structureDelta).toEqual({
      headings: { added: [], removed: [] },
      links: { added: [], removed: [] },
      typedEdges: { added: [], removed: [] },
      dates: { added: [], removed: [], changed: [] },
      truncated: true,
    });
  });
});
