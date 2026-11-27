import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("FTS name-match boost regression (#372)", () => {
  let adapter: SqliteAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-name-boost-"));
    adapter = new SqliteAdapter();
    const opened = await adapter.open(
      join(testDir, "test.sqlite"),
      "unicode61"
    );
    expect(opened.ok).toBe(true);
    await adapter.syncCollections([
      {
        name: "docs",
        path: "/docs",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function addDoc(input: {
    relPath: string;
    title: string;
    markdown: string;
  }) {
    const key = input.relPath.replace(/\W/g, "_");
    const mirrorHash = `mirror_${key}`;
    await adapter.upsertDocument({
      collection: "docs",
      relPath: input.relPath,
      sourceHash: `source_${key}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: input.markdown.length,
      sourceMtime: "2026-01-01T00:00:00Z",
      mirrorHash,
      title: input.title,
    });
    await adapter.upsertContent(mirrorHash, input.markdown);
    await adapter.upsertChunks(mirrorHash, [
      {
        seq: 0,
        pos: 0,
        text: input.markdown,
        startLine: 1,
        endLine: 1,
      },
    ]);
    await adapter.rebuildFtsForHash(mirrorHash);
  }

  test("ranks named document first at limit 4 above 100 body-heavy mentions (#372)", async () => {
    const filler =
      "Quarterly milestones, platform architecture, deployment topology, regional availability, incident response contacts, and onboarding checklists for engineering teams. ";
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nOrientation note.\n\n${filler.repeat(12)}`,
    });

    for (let i = 1; i <= 100; i += 1) {
      const reps = 3 + (i % 13);
      const body = Array.from(
        { length: reps },
        (_, idx) => `Acme overview note ${idx + 1}: Acme overview status.`
      ).join("\n");
      await addDoc({
        relPath: `report-${String(i).padStart(3, "0")}.md`,
        title: `Weekly Sync ${i}`,
        markdown: `# Weekly Sync ${i}\n\n${body}`,
      });
    }

    const res = await searchBm25(adapter, "Acme Overview", { limit: 4 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.results).toHaveLength(4);
    expect(res.value.results[0]?.source.relPath).toBe("Acme_Overview.md");
  });
});
