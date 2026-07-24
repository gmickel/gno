import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChunkInput, DocumentRow } from "../../src/store/types";

import { createDefaultConfig } from "../../src/config/defaults";
import { diagnoseQueryTarget } from "../../src/pipeline/diagnose";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

describe("diagnoseQueryTarget", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let counter = 0;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-diagnose-test-"));
    adapter = new SqliteAdapter();
    const open = await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    expect(open.ok).toBe(true);
    await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function setupDocument(
    relPath: string,
    markdown: string,
    chunks: ChunkInput[],
    metadata?: {
      contentType?: string;
      contentTypeSource?: string;
      categories?: string[];
      author?: string;
      sourceMtime?: string;
    }
  ): Promise<DocumentRow> {
    counter += 1;
    const sourceHash = `${counter.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
    const mirrorHash = `mirror-${counter}`;
    const upsert = await adapter.upsertDocument({
      collection: "notes",
      relPath,
      sourceHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: markdown.length,
      sourceMtime: metadata?.sourceMtime ?? "2026-01-01T00:00:00.000Z",
      mirrorHash,
      title: relPath,
      contentType: metadata?.contentType,
      contentTypeSource: metadata?.contentTypeSource,
      categories: metadata?.categories,
      author: metadata?.author,
    });
    expect(upsert.ok).toBe(true);
    await adapter.upsertContent(mirrorHash, markdown);
    await adapter.upsertChunks(mirrorHash, chunks);
    await adapter.rebuildFtsForHash(mirrorHash);
    const doc = await adapter.getDocument("notes", relPath);
    expect(doc.ok).toBe(true);
    if (!doc.ok || !doc.value) {
      throw new Error("document not created");
    }
    return doc.value;
  }

  function deps() {
    return {
      store: adapter,
      config: createDefaultConfig(),
      vectorIndex: null,
      embedPort: null,
      expandPort: null,
      rerankPort: null,
    };
  }

  test("reports BM25-only with fusion active sourceCount 1", async () => {
    const target = await setupDocument(
      "alice.md",
      "Alice works at Acme",
      [
        {
          seq: 0,
          pos: 0,
          text: "Alice works at Acme",
          startLine: 1,
          endLine: 1,
          language: "en",
        },
      ],
      {
        contentType: "person",
        contentTypeSource: "frontmatter",
        categories: ["people"],
      }
    );

    const result = await diagnoseQueryTarget(deps(), "Alice Acme", {
      target: target.uri,
      noExpand: true,
      noRerank: true,
      contentTypeRules: [
        {
          id: "person",
          prefixes: [],
          preset: "source-summary",
          graphHints: ["works_at"],
          searchBoost: 1,
        },
      ],
      projectAffinity: {
        resolution: {
          matches: [
            {
              collection: "notes",
              collectionAlias: "collection_000000000000",
              distance: 0,
              relation: "exact",
              rootAlias: "root_000000000000",
              source: "cli_cwd",
            },
          ],
          roots: [],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe("1.1");
    expect(result.value.target.status).toBe("diagnosed");
    expect(result.value.target.graphHints).toEqual(["works_at"]);
    expect(result.value.meta.mode).toBe("bm25_only");
    expect(result.value.affinity).toMatchObject({
      affinityRequested: 0.03,
      collectionAlias: "collection_000000000000",
      combinedAuxiliaryCap: 0.08,
      matched: true,
      rootAlias: "root_000000000000",
      source: "cli_cwd",
    });
    expect(
      result.value.stages.find((stage) => stage.id === "vector")
    ).toMatchObject({
      status: "skipped",
      dropReason: "skipped",
    });
    expect(
      result.value.stages.find((stage) => stage.id === "fusion")
    ).toMatchObject({
      status: "active",
      sourceCount: 1,
      present: true,
    });
  });

  test("reports bounded content-type scoring without affinity", async () => {
    const target = await setupDocument(
      "decisions/search.md",
      "bounded search boost evidence",
      [
        {
          seq: 0,
          pos: 0,
          text: "bounded search boost evidence",
          startLine: 1,
          endLine: 1,
          language: "en",
        },
      ],
      {
        contentType: "decision",
        contentTypeSource: "frontmatter",
      }
    );

    const result = await diagnoseQueryTarget(
      deps(),
      "bounded search boost evidence",
      {
        target: target.uri,
        noExpand: true,
        noRerank: true,
        contentTypeRules: [
          {
            id: "decision",
            prefixes: ["decisions/"],
            preset: "decision-note",
            searchBoost: 2,
          },
        ],
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe("1.1");
    expect(result.value.affinity).toBeUndefined();
    expect(result.value.contentTypeBoost).toMatchObject({
      baseScore: 1,
      configuredFactor: 2,
      rawContribution: 0.05,
      cappedContribution: 0.05,
      combinedAuxiliaryRequested: 0.05,
      combinedAuxiliaryApplied: 0.05,
      finalScore: 1,
      ruleSource: "configured-id",
    });
  });

  test("preserves exact v1.0 bytes for absent, disabled, and untrusted affinity", async () => {
    const target = await setupDocument("v1.md", "legacy diagnose bytes", [
      {
        seq: 0,
        pos: 0,
        text: "legacy diagnose bytes",
        startLine: 1,
        endLine: 1,
        language: "en",
      },
    ]);
    const baseOptions = {
      target: target.uri,
      noExpand: true,
      noRerank: true,
    };
    const absent = await diagnoseQueryTarget(
      deps(),
      "legacy diagnose bytes",
      baseOptions
    );
    const disabled = await diagnoseQueryTarget(
      deps(),
      "legacy diagnose bytes",
      {
        ...baseOptions,
        projectAffinity: {
          enabled: false,
          resolution: { matches: [], roots: [] },
        },
      }
    );
    const untrusted = await diagnoseQueryTarget(
      deps(),
      "legacy diagnose bytes",
      {
        ...baseOptions,
        projectAffinity: {
          resolution: {
            matches: [],
            roots: [
              {
                collectionAliases: [],
                reason: "untrusted_remote_hint",
                repositoryRootDiscovered: false,
                rootAlias: "root_000000000000",
                source: "remote_hint",
                status: "zero",
              },
            ],
          },
        },
      }
    );
    expect(absent.ok && absent.value.schemaVersion).toBe("1.0");
    expect(absent.ok && "affinity" in absent.value).toBeFalse();
    expect(disabled).toEqual(absent);
    expect(untrusted).toEqual(absent);
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(absent));
    expect(JSON.stringify(untrusted)).toBe(JSON.stringify(absent));
  });

  test("reports filtered_out before tracing", async () => {
    const target = await setupDocument("alice.md", "Alice works at Acme", [
      {
        seq: 0,
        pos: 0,
        text: "Alice works at Acme",
        startLine: 1,
        endLine: 1,
        language: "en",
      },
    ]);

    const result = await diagnoseQueryTarget(deps(), "Alice Acme", {
      target: target.uri,
      collection: "other",
      noExpand: true,
      noRerank: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.status).toBe("filtered_out");
    expect(result.value.target.filterReasons).toContain("collection");
    expect(result.value.stages).toEqual([]);
  });

  test("uses canonical URI when same-docid collection copies have different affinity", async () => {
    await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      {
        name: "archive",
        path: join(testDir, "archive"),
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    const sourceHash = `deadbeef${"0".repeat(56)}`;
    const mirrorHash = "shared-diagnose-mirror";
    for (const [collection, relPath] of [
      ["notes", "shared.md"],
      ["archive", "shared-copy.md"],
    ] as const) {
      const upsert = await adapter.upsertDocument({
        collection,
        relPath,
        sourceHash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 15,
        sourceMtime: "2026-01-01T00:00:00.000Z",
        mirrorHash,
        title: relPath,
      });
      expect(upsert.ok).toBe(true);
    }
    await adapter.upsertContent(mirrorHash, "shared evidence");
    await adapter.upsertChunks(mirrorHash, [
      {
        seq: 0,
        pos: 0,
        text: "shared evidence",
        startLine: 1,
        endLine: 1,
        language: "en",
      },
    ]);
    await adapter.rebuildFtsForHash(mirrorHash);
    const archive = await adapter.getDocument("archive", "shared-copy.md");
    expect(archive.ok && archive.value).toBeTruthy();
    if (!archive.ok || !archive.value) return;

    const result = await diagnoseQueryTarget(deps(), "shared evidence", {
      target: archive.value.uri,
      noExpand: true,
      noRerank: true,
      projectAffinity: {
        resolution: {
          matches: [
            {
              collection: "notes",
              collectionAlias: "collection_000000000000",
              distance: 0,
              relation: "exact",
              rootAlias: "root_000000000000",
              source: "cli_cwd",
            },
          ],
          roots: [],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target.uri).toBe("gno://archive/shared-copy.md");
    expect(result.value.schemaVersion).toBe("1.1");
    expect(result.value.affinity).toMatchObject({
      affinityApplied: 0,
      affinityRequested: 0,
      collectionAlias: null,
      matched: false,
      rootAlias: null,
      source: null,
    });
  });

  test("reports non-diagnosed target states", async () => {
    const noContent = await setupDocument("empty.md", "", [], {});
    const inactive = await setupDocument("inactive.md", "inactive target", [
      {
        seq: 0,
        pos: 0,
        text: "inactive target",
        startLine: 1,
        endLine: 1,
      },
    ]);
    await adapter.markInactive("notes", [inactive.relPath]);

    const missing = await diagnoseQueryTarget(deps(), "anything", {
      target: "gno://notes/missing.md",
      noExpand: true,
      noRerank: true,
    });
    const inactiveResult = await diagnoseQueryTarget(deps(), "inactive", {
      target: inactive.uri,
      noExpand: true,
      noRerank: true,
    });
    const noContentResult = await diagnoseQueryTarget(deps(), "empty", {
      target: noContent.uri,
      noExpand: true,
      noRerank: true,
    });

    expect(missing.ok && missing.value.target.status).toBe("not_found");
    expect(inactiveResult.ok && inactiveResult.value.target.status).toBe(
      "inactive"
    );
    expect(noContentResult.ok && noContentResult.value.target.status).toBe(
      "no_indexed_content"
    );
  });
});
