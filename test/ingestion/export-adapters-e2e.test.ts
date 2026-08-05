import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { RecordAdapter } from "../../src/converters/types";

import { formatSyncResultLines } from "../../src/cli/commands/shared";
import { CONFIG_VERSION } from "../../src/config/types";
import { ConversionPipeline } from "../../src/converters/pipeline";
import { ConverterRegistry } from "../../src/converters/registry";
import { sha256Text } from "../../src/core/context-capsule-validation";
import {
  materializeContextEvidenceCandidates,
  toContextCapsuleEvidence,
} from "../../src/core/context-evidence";
import { SyncService } from "../../src/ingestion/sync";
import { searchBm25 } from "../../src/pipeline/search";
import { getDocumentByRef } from "../../src/sdk/documents";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { err } from "../../src/store/types";
import { safeRm } from "../helpers/cleanup";

describe("file/export adapter ingestion", () => {
  let root: string;
  let store: SqliteAdapter;
  let config: Config;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-export-e2e-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "index.db"), "unicode61")).ok).toBe(
      true
    );
    config = {
      version: CONFIG_VERSION,
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "exports",
          path: root,
          pattern: "**/*",
          include: [],
          exclude: [],
          recordAdapters: {
            jsonl: {
              fieldMapping: {
                id: "/id",
                title: "/title",
                body: "/text",
                author: "/author",
                participants: "/participants",
                threadId: "/thread",
                dateFields: { created: "/created" },
              },
            },
          },
        },
      ],
      contexts: [],
    };
    expect((await store.syncCollections(config.collections)).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("indexes logical records with stable partial and complete snapshot semantics", async () => {
    const exportPath = join(root, "decisions.jsonl");
    const initial = [
      {
        id: "launch",
        title: "Launch decision",
        text: "Project Zephyr launches Friday",
        author: "Ada",
        participants: ["Ada", "Lin"],
        thread: "decision-7",
        created: "2026-07-22T09:00:00Z",
      },
      {
        id: "budget",
        title: "Budget decision",
        text: "Budget remains capped at forty units",
        author: "Lin",
        participants: ["Lin"],
        thread: "decision-8",
        created: "2026-07-22T10:00:00Z",
      },
    ];
    await Bun.write(
      exportPath,
      `${initial.map((record) => JSON.stringify(record)).join("\n")}\n`
    );

    const sync = new SyncService();
    const first = await sync.syncCollection(config.collections[0]!, store, {
      projectTypedEdges: false,
    });
    expect(first.filesAdded).toBe(1);
    const firstItems = first.files?.[0]?.recordImport?.items ?? [];
    expect(firstItems).toHaveLength(2);
    expect(firstItems.every((item) => item.outcome === "added")).toBe(true);
    expect(
      firstItems.every(
        (item) =>
          /^[a-f0-9]{64}$/.test(item.recordKey) &&
          /^[a-f0-9]{64}$/.test(item.sourceHash) &&
          /^[a-f0-9]{64}$/.test(item.adapterFingerprint) &&
          item.sourceLocator.startsWith("line:")
      )
    ).toBe(true);

    let documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(documents.value.filter((document) => document.active)).toHaveLength(
      2
    );
    const launch = documents.value.find(
      (document) => document.recordMetadata?.threadId === "decision-7"
    );
    expect(launch?.recordSourcePath).toBe("decisions.jsonl");
    expect(launch?.recordSourceLocator).toBe("line:1");
    expect(launch?.recordMetadata?.participants).toEqual(["Ada", "Lin"]);
    expect(launch?.recordAnchors).toEqual([{ kind: "line", value: "1" }]);
    expect(launch?.frontmatterDate).toBe("2026-07-22T09:00:00.000Z");

    const changed = { ...initial[0], text: "Project Zephyr launches Monday" };
    await Bun.write(exportPath, `${JSON.stringify(changed)}\n{broken\n`);
    const partial = await sync.syncCollection(config.collections[0]!, store, {
      projectTypedEdges: false,
    });
    expect(partial.filesErrored).toBe(0);
    expect(partial.files?.[0]?.recordImport).toMatchObject({
      snapshotState: "partial",
      authoritative: false,
      records: { accepted: 1, failed: 1, preserved: 1 },
      failures: [
        {
          code: "MALFORMED_RECORD",
          retryable: false,
          sourceLocator: "line:2",
        },
      ],
    });
    expect(
      partial.files?.[0]?.recordImport?.items.map((item) => item.outcome).sort()
    ).toEqual(["preserved", "updated"]);
    expect(partial.files?.[0]?.recordImport?.warnings).toEqual([]);
    const storedErrors = await store.getRecentErrors();
    expect(storedErrors.ok && storedErrors.value[0]?.detailsJson).toContain(
      '"sourceLocator":"line:2"'
    );
    documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(documents.value.filter((document) => document.active)).toHaveLength(
      2
    );

    await Bun.write(exportPath, `${JSON.stringify(changed)}\n`);
    const complete = await sync.syncCollection(config.collections[0]!, store, {
      projectTypedEdges: false,
    });
    expect(
      complete.files?.[0]?.recordImport?.items
        .map((item) => item.outcome)
        .sort()
    ).toEqual(["deactivated", "unchanged"]);
    documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(documents.value.filter((document) => document.active)).toHaveLength(
      1
    );

    const searched = await searchBm25(store, "Zephyr Monday", {
      collection: "exports",
      lineNumbers: true,
    });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    const result = searched.value.results[0];
    expect(result?.source.relPath).toBe("decisions.jsonl");
    expect(result?.source.absPath).toBe(exportPath);
    expect(result?.record?.threadId).toBe("decision-7");
    expect(result?.record?.sourceLocator).toBe("line:1");
    expect(result?.record?.adapter).toMatchObject({
      id: "adapter/jsonl",
      version: "1.0.0",
    });

    const fetched = await getDocumentByRef(store, config, result?.uri ?? "");
    expect(fetched.source.relPath).toBe("decisions.jsonl");
    expect(fetched.record?.participants).toEqual(["Ada", "Lin"]);

    const materialized = await materializeContextEvidenceCandidates(
      store,
      [
        {
          result: result!,
          retrievalRank: 1,
          retrievalSources: ["bm25"],
          graphExpanded: false,
          contextIds: [],
          observedAt: null,
        },
      ],
      "default"
    );
    expect(materialized[0]?.ok).toBe(true);
    if (!materialized[0]?.ok) return;
    const candidate = materialized[0].candidate;
    expect(candidate.value.record?.sourceLocator).toBe("line:1");
    const evidence = toContextCapsuleEvidence(
      {
        ...candidate,
        candidateId: sha256Text("record-candidate"),
        passageHash: sha256Text(candidate.text),
        facets: ["launch"],
        retrievalRank: 1,
        retrievalSources: ["bm25"],
        graphExpanded: false,
      },
      1
    );
    expect(evidence.record?.threadId).toBe("decision-7");
    expect(evidence.record?.anchors).toEqual([{ kind: "line", value: "1" }]);
    expect(evidence.record?.adapter.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("reports a partial snapshot with no adapter failures and retains attachment provenance", async () => {
    const adapter: RecordAdapter = {
      id: "adapter/partial-receipt",
      version: "1.0.0",
      canHandle: (_mime, ext) => ext === ".vtt",
      records: async function* () {
        yield {
          type: "record",
          record: {
            stableId: "record-1",
            sourceLocator: "item:1",
            markdown: "Retained partial evidence",
            metadata: {
              attachments: [
                {
                  name: "agenda.pdf",
                  mime: "application/pdf",
                  bytes: 42,
                  disposition: "attachment",
                },
              ],
            },
          },
        };
        yield { type: "snapshot", state: "partial" };
      },
    };
    const registry = new ConverterRegistry();
    registry.registerRecordAdapter(adapter);
    const sync = new SyncService(
      undefined,
      undefined,
      undefined,
      new ConversionPipeline(registry)
    );
    await Bun.write(join(root, "receipt.vtt"), "source");

    const result = await sync.syncCollection(config.collections[0]!, store, {
      projectTypedEdges: false,
    });
    const receipt = result.files?.find(
      (file) => file.relPath === "receipt.vtt"
    )?.recordImport;
    expect(receipt?.failures).toEqual([]);
    expect(receipt?.warnings).toEqual([
      {
        code: "PARTIAL_SNAPSHOT",
        message:
          "Adapter reported a partial snapshot; unseen records were preserved.",
        retryable: true,
      },
    ]);
    expect(receipt?.items).toMatchObject([
      {
        outcome: "added",
        sourceLocator: "item:1",
        attachments: [
          {
            name: "agenda.pdf",
            mime: "application/pdf",
            bytes: 42,
            disposition: "attachment",
          },
        ],
      },
    ]);
    expect(
      formatSyncResultLines(
        {
          collections: [result],
          totalDurationMs: result.durationMs,
          totalFilesProcessed: result.filesProcessed,
          totalFilesAdded: result.filesAdded,
          totalFilesUpdated: result.filesUpdated,
          totalFilesErrored: result.filesErrored,
          totalFilesSkipped: result.filesSkipped,
        },
        { verbose: true }
      ).join("\n")
    ).toContain(
      "receipt.vtt: 1 record warning (partial snapshot)\n    [PARTIAL_SNAPSHOT]"
    );
  });

  test("routes every supported export family through the shared registry", async () => {
    const fixtureRoot = join(import.meta.dir, "../fixtures/exports");
    const fixtures = [
      ["message.eml", "mail/nested.eml"],
      ["mailbox.mbox", "mail/mixed.mbox"],
      ["calendar.ics", "calendar/sample.ics"],
      ["meeting.vtt", "transcript/sample.vtt"],
      ["bookmarks.browser-export", "browser/chrome-bookmarks.json"],
    ] as const;
    for (const [destination, source] of fixtures) {
      await Bun.write(
        join(root, destination),
        Bun.file(join(fixtureRoot, source))
      );
    }

    const result = await new SyncService().syncCollection(
      config.collections[0]!,
      store,
      { projectTypedEdges: false }
    );
    expect(result.filesErrored).toBe(0);
    const documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    const active = documents.value.filter((document) => document.active);
    expect(new Set(active.map((document) => document.converterId))).toEqual(
      new Set([
        "adapter/browser-export",
        "native/email-export",
        "adapter/ical-export",
        "adapter/transcript",
      ])
    );
    expect(active.every((document) => document.recordSourcePath)).toBe(true);
    expect(active.every((document) => document.recordSourceLocator)).toBe(true);
    expect(active.every((document) => document.recordKey)).toBe(true);
    const calendar = active.find(
      (document) =>
        document.converterId === "adapter/ical-export" &&
        document.title === "Client review"
    );
    expect(calendar?.dateFields?.start).toBe("2026-10-25T08:30:00.000Z");
  });

  test("reindexes unchanged JSONL bytes when declarative mappings change", async () => {
    const exportPath = join(root, "mapping.jsonl");
    await Bun.write(
      exportPath,
      `${JSON.stringify({ id: "same", title: "Mapped", left: "old body", right: "new body" })}\n`
    );
    const collection = config.collections[0]!;
    collection.recordAdapters = {
      jsonl: {
        fieldMapping: { id: "/id", title: "/title", body: "/left" },
      },
    };
    const sync = new SyncService();
    expect(
      (
        await sync.syncCollection(collection, store, {
          projectTypedEdges: false,
        })
      ).filesAdded
    ).toBe(1);
    const before = await store.listDocuments("exports");
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const first = before.value.find(
      (document) => document.recordSourcePath === "mapping.jsonl"
    );
    expect(first?.recordAdapterFingerprint).toBeTruthy();
    const firstContent = first?.mirrorHash
      ? await store.getContent(first.mirrorHash)
      : undefined;
    expect(firstContent?.ok && firstContent.value).toContain("old body");

    collection.recordAdapters = {
      jsonl: {
        fieldMapping: { id: "/id", title: "/title", body: "/right" },
      },
    };
    const changed = await sync.syncCollection(collection, store, {
      projectTypedEdges: false,
    });
    expect(changed.filesUpdated).toBe(1);
    const after = await store.listDocuments("exports");
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const second = after.value.find(
      (document) => document.recordSourcePath === "mapping.jsonl"
    );
    expect(second?.recordAdapterFingerprint).not.toBe(
      first?.recordAdapterFingerprint
    );
    const secondContent = second?.mirrorHash
      ? await store.getContent(second.mirrorHash)
      : undefined;
    expect(secondContent?.ok && secondContent.value).toContain("new body");
  });

  test("discovers configured JSON transcripts with the default include", async () => {
    await Bun.write(
      join(root, "configured-transcript.json"),
      JSON.stringify({
        id: "session-99",
        title: "Configured transcript",
        segments: [
          {
            id: "segment-1",
            speaker: "Ada",
            text: "JSON transcript discovery evidence",
          },
        ],
      })
    );
    const collection = config.collections[0]!;
    collection.recordAdapters = { transcript: { format: "json" } };

    const result = await new SyncService().syncCollection(collection, store, {
      projectTypedEdges: false,
    });

    expect(result.filesAdded).toBe(1);
    expect(result.filesErrored).toBe(0);
    const documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(
      documents.value.some(
        (document) =>
          document.active &&
          document.recordSourcePath === "configured-transcript.json" &&
          document.converterId === "adapter/transcript"
      )
    ).toBe(true);
  });

  test("rolls back record writes and preserves source evidence when a lane transition fails", async () => {
    const sourcePath = join(root, "atomic.txt");
    await Bun.write(sourcePath, "Alice: source evidence survives\n");
    const collection = config.collections[0]!;
    collection.recordAdapters = undefined;
    const sync = new SyncService();
    const ordinary = await sync.syncFiles(collection, store, ["atomic.txt"], {
      projectTypedEdges: false,
    });
    expect(ordinary[0]?.status).toBe("added");
    const before = await store.getDocument("exports", "atomic.txt");
    expect(before.ok && before.value?.mirrorHash).toBeTruthy();
    if (!(before.ok && before.value?.mirrorHash)) return;
    const originalMirrorHash = before.value.mirrorHash;

    collection.recordAdapters = { transcript: { format: "text" } };
    const originalMarkInactive = store.markInactive.bind(store);
    store.markInactive = async (collectionName, relPaths) => {
      if (relPaths.includes("atomic.txt")) {
        return err("QUERY_FAILED", "injected source-lane transition failure");
      }
      return originalMarkInactive(collectionName, relPaths);
    };
    let failed: Awaited<ReturnType<SyncService["syncFiles"]>>;
    try {
      failed = await sync.syncFiles(collection, store, ["atomic.txt"], {
        projectTypedEdges: false,
      });
    } finally {
      store.markInactive = originalMarkInactive;
    }
    expect(failed[0]?.status).toBe("error");

    const after = await store.getDocument("exports", "atomic.txt");
    expect(after.ok && after.value?.active).toBe(true);
    expect(after.ok && after.value?.mirrorHash).toBe(originalMirrorHash);
    const originalContent = await store.getContent(originalMirrorHash);
    expect(originalContent.ok && originalContent.value).toContain(
      "source evidence survives"
    );
    const records = await store.listRecordDocuments("exports", "atomic.txt");
    expect(records.ok && records.value).toEqual([]);
  });

  test("deactivates the previous representation when adapter selection changes", async () => {
    const transcriptPath = join(root, "talk.txt");
    await Bun.write(transcriptPath, "Alice: export-only evidence\n");
    const collection = config.collections[0]!;
    collection.recordAdapters = { transcript: { format: "text" } };
    const sync = new SyncService();
    await sync.syncCollection(collection, store, { projectTypedEdges: false });
    let documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(
      documents.value.filter(
        (document) =>
          document.active && document.recordSourcePath === "talk.txt"
      ).length
    ).toBeGreaterThan(0);
    expect(
      documents.value.find((document) => document.relPath === "talk.txt")
        ?.active
    ).not.toBe(true);

    collection.recordAdapters = undefined;
    await sync.syncCollection(collection, store, { projectTypedEdges: false });
    documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(
      documents.value.filter(
        (document) =>
          document.active && document.recordSourcePath === "talk.txt"
      )
    ).toEqual([]);
    expect(
      documents.value.find((document) => document.relPath === "talk.txt")
        ?.active
    ).toBe(true);

    collection.recordAdapters = { transcript: { format: "text" } };
    await Bun.write(
      transcriptPath,
      new Uint8Array([
        ...new TextEncoder().encode("Alice: retained valid segment\n"),
        0xff,
        0xfe,
        0x0a,
      ])
    );
    await sync.syncCollection(collection, store, { projectTypedEdges: false });
    documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(
      documents.value.find((document) => document.relPath === "talk.txt")
        ?.active
    ).toBe(true);
    expect(
      documents.value.filter(
        (document) =>
          document.active && document.recordSourcePath === "talk.txt"
      ).length
    ).toBeGreaterThan(0);

    await Bun.write(transcriptPath, "Alice: authoritative segment\n");
    await sync.syncCollection(collection, store, { projectTypedEdges: false });
    documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(
      documents.value.find((document) => document.relPath === "talk.txt")
        ?.active
    ).toBe(false);
  });

  test("cannot disguise a live browser profile behind a watched symlink", async () => {
    const liveDirectory = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default"
    );
    await mkdir(liveDirectory, { recursive: true });
    const liveBookmarks = join(liveDirectory, "Bookmarks");
    await Bun.write(liveBookmarks, new Uint8Array([0xff, 0xfe]));
    await symlink(liveBookmarks, join(root, "disguised.browser-export"));

    const sync = new SyncService();
    const result = await sync.syncPaths(config.collections[0]!, store, [
      "disguised.browser-export",
    ]);
    // Refused BEFORE any adapter runs, not after one failed on the bytes it
    // pulled through the link. `FileWalker.walk` scans `followSymlinks: false`
    // and emits no symlink - to a directory OR to a regular file - so a full
    // `gno update` never reaches this path, and `syncPaths` now agrees. The
    // absence of a `recordImport` is the discriminator: the pre-fix code
    // followed the link, read the live profile and reported ADAPTER_FAILURE.
    expect(result.files?.[0]?.recordImport).toBeUndefined();
    expect(result.filesAdded).toBe(0);
    expect(result.filesUpdated).toBe(0);
    const documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(documents.value).toEqual([]);
  });

  /**
   * The companion to the test above, and the reason its assertions could move:
   * the ADAPTER's refusal of live-profile bytes is still exercised, just on a
   * path the walker can actually reach. Without this, tightening the symlink
   * case to "never read" would have quietly retired the adapter coverage.
   */
  test("still refuses a live browser profile reached without a symlink", async () => {
    const profile = join(
      root,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default"
    );
    await mkdir(profile, { recursive: true });
    const relPath =
      "Library/Application Support/Google/Chrome/Default/live.browser-export";
    await Bun.write(join(root, relPath), new Uint8Array([0xff, 0xfe]));

    const sync = new SyncService();
    const result = await sync.syncPaths(config.collections[0]!, store, [
      relPath,
    ]);
    expect(result.filesErrored).toBe(1);
    expect(result.files?.[0]?.status).toBe("error");
    expect(result.files?.[0]?.recordImport?.failures[0]?.code).toBe(
      "ADAPTER_FAILURE"
    );
    const documents = await store.listDocuments("exports");
    expect(documents.ok).toBe(true);
    if (!documents.ok) return;
    expect(documents.value).toEqual([]);
  });
});
