import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocLinkInput, DocumentInput } from "../../src/store/types";

import { evaluateLinkAudit } from "../../src/core/audit-links";
import { parseLinks } from "../../src/core/links";
import { buildLineOffsets } from "../../src/ingestion/position";
import { getExcludedRanges } from "../../src/ingestion/strip";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { resolveGraphLinkTargetsBulk } from "../../src/store/sqlite/graph-link-bulk-resolver";
import { captureAuditLinkSnapshot } from "../../src/store/sqlite/graph-link-resolver";
import { safeRm } from "../helpers/cleanup";

describe("link integrity audit", () => {
  let tempDirectory: string;
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "gno-audit-links-"));
    adapter = new SqliteAdapter();
    const opened = await adapter.open(
      join(tempDirectory, "index.db"),
      "porter"
    );
    expect(opened.ok).toBe(true);
    const synced = await adapter.syncCollections([
      {
        name: "notes",
        path: tempDirectory,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(synced.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tempDirectory);
  });

  const addDocument = async (
    relPath: string,
    title: string,
    mirrorHash = `mirror-${relPath}`
  ): Promise<number> => {
    const document: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: `source-${relPath}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: "2026-08-03T12:00:00.000Z",
      title,
      mirrorHash,
      ingestVersion: 3,
    };
    const result = await adapter.upsertDocument(document);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.id;
  };

  test("uses the graph resolver for exact, ambiguous, and unresolved evidence", async () => {
    const sourceId = await addDocument("source.md", "Source");
    await addDocument("projects/task.md", "Task");
    await addDocument("archive/task.md", "Task");
    await addDocument("guide.md", "Guide");
    const links: DocLinkInput[] = [
      {
        targetRef: "task.md",
        targetRefNorm: "task.md",
        targetAnchor: "Next",
        linkType: "wiki",
        startLine: 2,
        startCol: 1,
        endLine: 2,
        endCol: 18,
      },
      {
        targetRef: "missing.md",
        targetRefNorm: "missing.md",
        linkType: "markdown",
        startLine: 3,
        startCol: 1,
        endLine: 3,
        endCol: 20,
      },
      {
        targetRef: "guide.md",
        targetRefNorm: "guide.md",
        linkType: "markdown",
        startLine: 4,
        startCol: 1,
        endLine: 4,
        endCol: 18,
      },
    ];
    expect((await adapter.setDocLinks(sourceId, links, "parsed")).ok).toBe(
      true
    );

    const database = adapter.getRawDb();
    const changesBefore = database
      .query<{ changes: number }, []>("SELECT total_changes() AS changes")
      .get()?.changes;
    const snapshot = captureAuditLinkSnapshot(database);
    const changesAfter = database
      .query<{ changes: number }, []>("SELECT total_changes() AS changes")
      .get()?.changes;
    const rules = evaluateLinkAudit(snapshot, {
      rootUris: ["gno://notes/source.md"],
      ignorePathPrefixes: [],
    });
    const unresolved = rules.find(
      ({ ruleId }) => ruleId === "links.local-targets"
    );
    const ambiguous = rules.find(
      ({ ruleId }) => ruleId === "links.ambiguous-targets"
    );
    expect(unresolved?.findings).toHaveLength(1);
    expect(unresolved?.findings?.[0]?.message).toContain("Broken local link");
    expect(ambiguous?.findings).toHaveLength(1);
    expect(ambiguous?.findings?.[0]?.evidence[0]?.detail).toContain(
      '"matchCount":2'
    );
    expect(snapshot.metrics.batchedResolution).toBe(true);
    expect(snapshot.metrics.linkRowsExamined).toBe(3);
    expect(changesAfter).toBe(changesBefore);
  });

  test("applies explicit roots, ignored prefixes, and mirror duplicate policy", async () => {
    await addDocument("root.md", "Root");
    await addDocument("ignored/draft.md", "Draft");
    await addDocument("mirror-a.md", "Mirror A", "same-mirror");
    await addDocument("mirror-b.md", "Mirror B", "same-mirror");
    await addDocument("orphan.md", "Orphan");

    const rules = evaluateLinkAudit(
      captureAuditLinkSnapshot(adapter.getRawDb()),
      {
        rootUris: ["gno://notes/root.md"],
        ignorePathPrefixes: ["ignored"],
      }
    );
    const orphans = rules.find(({ ruleId }) => ruleId === "links.orphans");
    expect(orphans?.findings?.map(({ subject }) => subject)).toEqual([
      "gno://notes/orphan.md",
    ]);
  });

  test("applies orphan ignores to logical-record source paths", async () => {
    const result = await adapter.upsertDocument({
      collection: "notes",
      relPath: ".gno/records/decisions.jsonl/decision-1.md",
      sourceHash: "record-decision-1",
      sourceMime: "application/jsonl",
      sourceExt: ".jsonl",
      sourceSize: 100,
      sourceMtime: "2026-08-03T12:00:00.000Z",
      title: "Decision 1",
      mirrorHash: "record-decision-1-mirror",
      recordKey: "decision-1",
      recordSourcePath: "decisions.jsonl",
      ingestVersion: 3,
    });
    expect(result.ok).toBe(true);

    const rules = evaluateLinkAudit(
      captureAuditLinkSnapshot(adapter.getRawDb()),
      {
        rootUris: [],
        ignorePathPrefixes: ["decisions.jsonl"],
      }
    );
    const orphans = rules.find(({ ruleId }) => ruleId === "links.orphans");
    expect(orphans?.findings).toEqual([]);
  });

  test("parser excludes external URLs while retaining path-style and fragment links", () => {
    const markdown =
      "[web](https://example.com) [[Folder/Note.md#Part]] [local](./guide.md#Install)";
    const links = parseLinks(
      markdown,
      buildLineOffsets(markdown),
      getExcludedRanges(markdown)
    );
    expect(links).toHaveLength(2);
    expect(links.map(({ targetRef }) => targetRef)).toEqual([
      "Folder/Note.md",
      "./guide.md",
    ]);
    expect(links.map(({ targetAnchor }) => targetAnchor)).toEqual([
      "Part",
      "Install",
    ]);
  });

  test("bounded snapshots retain exact totals and become inconclusive", async () => {
    const sourceId = await addDocument("source.md", "Source");
    const links: DocLinkInput[] = Array.from({ length: 20 }, (_, index) => ({
      targetRef: `missing-${index}.md`,
      targetRefNorm: `missing-${index}.md`,
      linkType: "markdown",
      startLine: index + 1,
      startCol: 1,
      endLine: index + 1,
      endCol: 10,
    }));
    expect((await adapter.setDocLinks(sourceId, links, "parsed")).ok).toBe(
      true
    );
    const snapshot = captureAuditLinkSnapshot(adapter.getRawDb(), {
      maxLinks: 5,
    });
    expect(snapshot.links).toHaveLength(5);
    expect(snapshot.totals.links).toBe(20);
    expect(snapshot.truncated.links).toBe(true);
    const rules = evaluateLinkAudit(snapshot, {
      rootUris: ["gno://notes/source.md"],
      ignorePathPrefixes: [],
    });
    expect(
      rules.every(
        ({ status }) => status === "inconclusive" || status === "pass"
      )
    ).toBe(true);
  });

  test("selects the canonical finding subset before evaluator caps", () => {
    const targets = Array.from(
      { length: 1001 },
      (_, index) => `missing-${index.toString().padStart(4, "0")}.md`
    );
    const snapshotFor = (orderedTargets: string[]) => ({
      documents: [
        {
          id: 1,
          docid: "#source",
          uri: "gno://notes/source.md",
          collection: "notes",
          relPath: "source.md",
          recordSourcePath: null,
          title: "Source",
          mirrorHash: "source-mirror",
        },
      ],
      links: orderedTargets.map((targetRef) => ({
        sourceId: 1,
        sourceDocid: "#source",
        sourceUri: "gno://notes/source.md",
        sourceCollection: "notes",
        sourceRelPath: "source.md",
        targetRef,
        targetRefNorm: targetRef,
        targetAnchor: null,
        targetCollection: "notes",
        linkType: "markdown" as const,
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        resolved: null,
      })),
      totals: { documents: 1, links: orderedTargets.length },
      truncated: { documents: false, links: false },
      metrics: {
        documentRowsExamined: 1,
        linkRowsExamined: orderedTargets.length,
        uniqueTargetsResolved: orderedTargets.length,
        batchedResolution: true as const,
      },
    });
    const findingsFor = (orderedTargets: string[]) =>
      evaluateLinkAudit(snapshotFor(orderedTargets), {
        rootUris: ["gno://notes/source.md"],
        ignorePathPrefixes: [],
      }).find(({ ruleId }) => ruleId === "links.local-targets")?.findings;

    expect(findingsFor(targets)).toEqual(findingsFor([...targets].reverse()));
    expect(findingsFor(targets)).toHaveLength(1000);
  });

  test("captures only parsed links for integrity evaluation", async () => {
    const sourceId = await addDocument("source.md", "Source");
    const link = (targetRef: string): DocLinkInput => ({
      targetRef,
      targetRefNorm: targetRef,
      linkType: "markdown",
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 10,
    });
    expect(
      (await adapter.setDocLinks(sourceId, [link("parsed.md")], "parsed")).ok
    ).toBe(true);
    expect(
      (await adapter.setDocLinks(sourceId, [link("suggested.md")], "suggested"))
        .ok
    ).toBe(true);

    const snapshot = captureAuditLinkSnapshot(adapter.getRawDb());
    expect(snapshot.totals.links).toBe(1);
    expect(snapshot.links.map(({ targetRef }) => targetRef)).toEqual([
      "parsed.md",
    ]);
  });

  test("bulk resolver preserves ranked results above the adaptive threshold", async () => {
    const sourceId = await addDocument("source.md", "Source");
    await addDocument("projects/task.md", "Task");
    await addDocument("archive/task.md", "Task");
    await addDocument("guide.md", "Guide");
    await addDocument("Flooid/Pack.md", "Pack");
    await addDocument("empty.md", "");
    const links: DocLinkInput[] = [
      {
        targetRef: "task.md",
        targetRefNorm: "task.md",
        linkType: "wiki",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 10,
      },
      {
        targetRef: "guide.md",
        targetRefNorm: "guide.md",
        linkType: "markdown",
        startLine: 2,
        startCol: 1,
        endLine: 2,
        endCol: 10,
      },
      {
        targetRef: "Flooid/Pack.md",
        targetRefNorm: "Flooid/Pack.md",
        linkType: "markdown",
        startLine: 3,
        startCol: 1,
        endLine: 3,
        endCol: 10,
      },
      {
        targetRef: "_artefakte/",
        targetRefNorm: "_artefakte/",
        linkType: "wiki",
        startLine: 4,
        startCol: 1,
        endLine: 4,
        endCol: 10,
      },
      ...Array.from({ length: 127 }, (_, index) => ({
        targetRef: `missing-${index}.md`,
        targetRefNorm: `missing-${index}.md`,
        linkType: "markdown" as const,
        startLine: index + 5,
        startCol: 1,
        endLine: index + 5,
        endCol: 10,
      })),
    ];
    expect((await adapter.setDocLinks(sourceId, links, "parsed")).ok).toBe(
      true
    );

    const snapshot = captureAuditLinkSnapshot(adapter.getRawDb());
    expect(snapshot.metrics.uniqueTargetsResolved).toBe(131);
    expect(snapshot.links[0]?.resolved).toMatchObject({
      matchRank: 1,
      matchCount: 2,
    });
    expect(snapshot.links[1]?.resolved).toMatchObject({
      matchRank: 5,
      matchCount: 1,
    });
    expect(snapshot.links[2]?.resolved).toMatchObject({
      matchRank: 5,
      matchCount: 1,
    });
    expect(snapshot.links[3]?.resolved).toMatchObject({
      matchRank: 4,
      matchCount: 1,
    });
    expect(
      snapshot.links.filter(({ resolved }) => resolved === null)
    ).toHaveLength(127);
  });

  test("bulk resolver declines before materializing an oversized index", async () => {
    await addDocument("one.md", "One");
    await addDocument("two.md", "Two");
    expect(
      resolveGraphLinkTargetsBulk(
        adapter.getRawDb(),
        [
          {
            targetRefNorm: "one.md",
            targetCollection: "notes",
            linkType: "wiki",
          },
        ],
        1
      )
    ).toBeNull();
  });

  test("source and target lookups retain supporting indexes", () => {
    const indexes = adapter
      .getRawDb()
      .query<{ name: string }, []>("PRAGMA index_list('doc_links')")
      .all()
      .map(({ name }) => name);
    expect(indexes.some((name) => name.includes("source"))).toBe(true);
    const documentIndexes = adapter
      .getRawDb()
      .query<{ name: string }, []>("PRAGMA index_list('documents')")
      .all()
      .map(({ name }) => name);
    expect(documentIndexes.length).toBeGreaterThan(0);
  });

  test("collection and path filters stay bound and exact", async () => {
    await addDocument("projects/one.md", "One");
    await addDocument("archive/two.md", "Two");
    const snapshot = captureAuditLinkSnapshot(adapter.getRawDb(), {
      collections: ["notes"],
      pathPrefixes: ["projects"],
    });
    expect(snapshot.totals.documents).toBe(1);
    expect(snapshot.documents.map(({ relPath }) => relPath)).toEqual([
      "projects/one.md",
    ]);
  });
});
