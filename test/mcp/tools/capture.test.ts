/**
 * MCP gno_capture tool tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";

import { CAPTURE_MAX_TEXT_BYTES } from "../../../src/core/capture";
import { defaultSyncService } from "../../../src/ingestion";
import { handleCapture } from "../../../src/mcp/tools/capture";
import { registerTools } from "../../../src/mcp/tools/index";
import { handleTracePurge } from "../../../src/mcp/tools/trace";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

describe("gno_capture MCP", () => {
  let tmpDir: string;
  let store: SqliteAdapter;
  const originalSyncFiles =
    defaultSyncService.syncFiles.bind(defaultSyncService);

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-mcp-capture-"));
    store = new SqliteAdapter();
    const openResult = await store.open(join(tmpDir, "test.db"), "porter");
    expect(openResult.ok).toBe(true);
    const syncResult = await store.syncCollections([
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    defaultSyncService.syncFiles = originalSyncFiles;
    await store.close();
    await safeRm(tmpDir);
  });

  function toolContext(enableWrite = true): ToolContext {
    return {
      indexName: "default",
      store,
      config: {
        version: "1.0",
        ftsTokenizer: "porter",
        collections: [],
        contexts: [],
      },
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      actualConfigPath: join(tmpDir, "config.yml"),
      toolMutex: {
        acquire: async () => () => {},
      } as ToolContext["toolMutex"],
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "test-server",
      writeLockPath: join(tmpDir, ".lock"),
      enableWrite,
      isShuttingDown: () => false,
    };
  }

  test("does not register write tools when writes are disabled", () => {
    const names: string[] = [];
    const fakeServer = {
      tool: (name: string) => {
        names.push(name);
      },
      registerTool: (name: string) => {
        names.push(name);
      },
    };

    registerTools(fakeServer as never, toolContext(false));

    expect(names).not.toContain("gno_capture");
    expect(names).toContain("gno_search");
    expect(names).toContain("gno_section");
    expect(names).toContain("gno_trace_list");
    expect(names).toContain("gno_trace_show");
    expect(names).not.toContain("gno_trace_label");
    expect(names).not.toContain("gno_trace_export");
    expect(names).not.toContain("gno_trace_delete");
    expect(names).not.toContain("gno_trace_purge");
  });

  test("trace mutation handlers defend against direct disabled dispatch", async () => {
    const result = await handleTracePurge(
      { confirm: true },
      toolContext(false)
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "WRITE_DISABLED",
      message:
        "Trace mutations require gateway.enableWrite or --mcp-enable-write",
    });
  });

  test("direct handler rejects disabled writes", async () => {
    const result = await handleCapture(
      { collection: "notes", content: "hello" },
      toolContext(false)
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Write tools disabled");
  });

  test("returns a provenance receipt with legacy MCP fields", async () => {
    let contentGeneration = 0;
    const ctx = toolContext(true);
    ctx.markContentMutation = () => {
      contentGeneration += 1;
    };
    const result = await handleCapture(
      {
        collection: "notes",
        content: "# Captured\n\nBody",
        title: "Captured",
        path: "captured",
        tags: ["Project/GNO", "project/gno"],
        source: {
          kind: "web",
          title: "Source page",
          url: "https://example.com/source",
          observedAt: "2026-06-04T12:00:00Z",
        },
      },
      ctx
    );

    expect(result.isError).toBeUndefined();
    const receipt = result.structuredContent;
    expect(receipt?.uri).toBe("gno://notes/captured.md");
    expect(receipt?.relPath).toBe("captured.md");
    expect(receipt?.created).toBe(true);
    expect(receipt?.openedExisting).toBe(false);
    expect(receipt?.collisionPolicyResult).toBe("created");
    expect(receipt?.serverInstanceId).toBe("test-server");
    expect(receipt?.absPath).toBe(join(tmpDir, "captured.md"));
    expect(receipt?.docid).toBeString();
    expect(receipt?.contentHash).toBeString();
    expect(receipt?.sync).toEqual({ status: "completed" });
    expect(receipt?.embed).toEqual({
      status: "not_requested",
      reason: "Capture does not embed automatically.",
    });
    expect(receipt?.tags).toEqual(["project/gno"]);
    expect(receipt?.source).toMatchObject({
      kind: "web",
      title: "Source page",
      url: "https://example.com/source",
      observedAt: "2026-06-04T12:00:00.000Z",
    });

    const written = await Bun.file(join(tmpDir, "captured.md")).text();
    expect(written).toContain("source:");
    expect(written).toContain('url: "https://example.com/source"');
    expect(result.content[0]?.text).toContain("Content hash:");
    expect(contentGeneration).toBe(1);
  });

  test("captures into a real nested directory and indexes it", async () => {
    // Non-discriminating regression guard: passes at fc38f2de too. It keeps
    // the two refusals below from being satisfied by refusing subdirectory
    // captures wholesale.
    const result = await handleCapture(
      {
        collection: "notes",
        content: "Nested body",
        title: "Nested",
        path: "deep/nested/note.md",
      },
      toolContext(true)
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      sync: { status: "completed" },
    });
    expect(result.structuredContent?.docid).toBeTruthy();
    const stored = await store.getDocument("notes", "deep/nested/note.md");
    expect(stored.ok && stored.value?.active).toBe(true);
  });

  test("refuses to capture beneath a symlinked parent inside the collection", async () => {
    // DISCRIMINATING: at fc38f2de `mkdir -p` followed `alias`, the note landed
    // in `real/`, the no-follow indexer never saw it, and the receipt still
    // said `completed`.
    await mkdir(join(tmpDir, "real"), { recursive: true });
    await symlink(join(tmpDir, "real"), join(tmpDir, "alias"));

    const result = await handleCapture(
      {
        collection: "notes",
        content: "Through the alias",
        title: "Aliased",
        path: "alias/note.md",
      },
      toolContext(true)
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("symlink");
    // DISCRIMINATING for the structured reason: at ede2ed1a the payload was
    // `{error, message}` only, so a machine caller had to read the sentence to
    // tell "unreachable alias" from "escapes the collection".
    expect(result.structuredContent).toMatchObject({
      error: "INVALID_INPUT",
      details: { code: "PATH_NOT_WALKABLE", relPath: "alias/note.md" },
    });
    expect(await Bun.file(join(tmpDir, "real", "note.md")).exists()).toBe(
      false
    );
  });

  test("reports containment when a symlinked parent escapes the collection", async () => {
    // DISCRIMINATING: at fc38f2de this wrote OUTSIDE the collection and
    // reported a completed capture.
    const outsideDir = await mkdtemp(join(tmpdir(), "gno-mcp-outside-"));
    try {
      await symlink(outsideDir, join(tmpDir, "escape"));

      const result = await handleCapture(
        {
          collection: "notes",
          content: "Out of bounds",
          title: "Escaped",
          path: "escape/note.md",
        },
        toolContext(true)
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "resolving outside the collection root"
      );
      // DISCRIMINATING: the reason is carried structurally, and it is the
      // containment code - not the same code the unreachable alias reports.
      expect(result.structuredContent).toMatchObject({
        error: "INVALID_INPUT",
        details: {
          code: "PATH_OUTSIDE_COLLECTION",
          relPath: "escape/note.md",
        },
      });
      expect(await Bun.file(join(outsideDir, "note.md")).exists()).toBe(false);
    } finally {
      await safeRm(outsideDir);
    }
  });

  test("supports open_existing through shared collision planning", async () => {
    const ctx = toolContext(true);
    const first = await handleCapture(
      {
        collection: "notes",
        content: "Original",
        title: "Same",
        path: "same.md",
      },
      ctx
    );
    expect(first.isError).toBeUndefined();

    const second = await handleCapture(
      {
        collection: "notes",
        content: "Replacement ignored",
        title: "Same",
        path: "same.md",
        collisionPolicy: "open_existing",
      },
      ctx
    );

    expect(second.isError).toBeUndefined();
    expect(second.structuredContent?.openedExisting).toBe(true);
    expect(second.structuredContent?.created).toBe(false);
    expect(second.structuredContent?.collisionPolicyResult).toBe(
      "opened_existing"
    );
    expect(await Bun.file(join(tmpDir, "same.md")).text()).toContain(
      "Original"
    );
  });

  test("legacy overwrite returns overwritten collision result", async () => {
    const ctx = toolContext(true);
    await handleCapture(
      {
        collection: "notes",
        content: "Original",
        title: "Overwrite",
        path: "overwrite.md",
      },
      ctx
    );

    const overwritten = await handleCapture(
      {
        collection: "notes",
        content: "Updated",
        title: "Overwrite",
        path: "overwrite.md",
        overwrite: true,
      },
      ctx
    );

    expect(overwritten.isError).toBeUndefined();
    expect(overwritten.structuredContent?.overwritten).toBe(true);
    expect(overwritten.structuredContent?.created).toBe(false);
    expect(overwritten.structuredContent?.collisionPolicyResult).toBe(
      "overwritten"
    );
    expect(await Bun.file(join(tmpDir, "overwrite.md")).text()).toContain(
      "Updated"
    );
  });

  test("rejects sensitive directories at any path depth", async () => {
    const result = await handleCapture(
      {
        collection: "notes",
        content: "secret",
        path: "project/.git/config.md",
      },
      toolContext(true)
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("sensitive directory: .git");
    expect(
      await Bun.file(join(tmpDir, "project/.git/config.md")).exists()
    ).toBe(false);
  });

  test("returns failed sync receipt after a successful write", async () => {
    defaultSyncService.syncFiles = (async () => [
      {
        status: "error",
        path: "sync-failed.md",
        errorCode: "PARSE_ERROR",
        errorMessage: "bad markdown",
      },
    ]) as unknown as typeof defaultSyncService.syncFiles;

    const result = await handleCapture(
      {
        collection: "notes",
        content: "Written before sync fails",
        path: "sync-failed.md",
      },
      toolContext(true)
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.sync).toEqual({
      status: "failed",
      error: "INGEST_ERROR: PARSE_ERROR - bad markdown",
    });
    expect(result.structuredContent?.docid).toBe("");
    expect(result.structuredContent?.relPath).toBe("sync-failed.md");
    expect(await Bun.file(join(tmpDir, "sync-failed.md")).text()).toContain(
      "Written before sync fails"
    );
  });

  test("rejects content beyond the shared byte limit", async () => {
    const result = await handleCapture(
      {
        collection: "notes",
        content: "x".repeat(CAPTURE_MAX_TEXT_BYTES + 1),
      },
      toolContext(true)
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("byte limit");
  });
});

describe("gno_capture MCP - record containers", () => {
  let tmpDir: string;
  let store: SqliteAdapter;

  const collection = () => ({
    name: "records",
    path: tmpDir,
    pattern: "**/*",
    include: [],
    exclude: [],
    recordAdapters: {
      jsonl: {
        fieldMapping: { id: "/id", title: "/title", body: "/text" },
      },
    },
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-mcp-capture-records-"));
    store = new SqliteAdapter();
    expect((await store.open(join(tmpDir, "test.db"), "porter")).ok).toBe(true);
    expect((await store.syncCollections([collection()])).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  function recordsContext(): ToolContext {
    return {
      indexName: "default",
      store,
      config: {
        version: "1.0",
        ftsTokenizer: "porter",
        collections: [],
        contexts: [],
      },
      collections: [collection()],
      actualConfigPath: join(tmpDir, "config.yml"),
      toolMutex: {
        acquire: async () => () => {},
      } as ToolContext["toolMutex"],
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "test-server",
      writeLockPath: join(tmpDir, ".lock"),
      enableWrite: true,
      isShuttingDown: () => false,
    };
  }

  test("the TEXT an agent reads states the container fact and omits an empty Doc", async () => {
    const result = await handleCapture(
      {
        collection: "records",
        path: "export.jsonl",
        content: `${[
          { id: "one", title: "First", text: "Zephyr ships Friday" },
          { id: "two", title: "Second", text: "Budget capped at forty" },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
      },
      recordsContext()
    );

    expect(result.isError).toBeUndefined();
    // The JSON half is unchanged: `docid` is still required by the schema and
    // is still the empty string for "not resolved".
    expect(result.structuredContent?.docid).toBe("");
    expect(result.structuredContent?.sync).toMatchObject({
      status: "completed",
    });

    const text = result.content[0]?.text ?? "";
    // DISCRIMINATING against 0a3b57f5: there this text opened with a bare
    // `Doc: ` and reported `Sync: completed` with no further word, reading as
    // an ordinary capture of a document that does not exist.
    expect(text).not.toContain("Doc: ");
    expect(text).toContain("Sync: completed");
    expect(text).toContain("Note: ");
    expect(text).toContain("2 logical record documents");
    expect(text).toContain("the container path itself has no document");
  });

  /**
   * Opening an existing file asks the same question the post-write proof asks -
   * "is it indexed?" - and must ask it by EFFECTIVE SOURCE PATH. A container is
   * indexed as N logical records at virtual paths with nothing at its own rel
   * path, so a `getDocument`-only answer is "no" for a fully indexed file.
   */
  test("opening an existing container reports it as indexed", async () => {
    const ctx = recordsContext();
    const content = `${[
      { id: "one", title: "First", text: "Zephyr ships Friday" },
      { id: "two", title: "Second", text: "Budget capped at forty" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`;
    const created = await handleCapture(
      { collection: "records", path: "export.jsonl", content },
      ctx
    );
    expect(created.isError).toBeUndefined();

    const opened = await handleCapture(
      {
        collection: "records",
        path: "export.jsonl",
        content: "ignored on open",
        collisionPolicy: "open_existing",
      },
      ctx
    );

    expect(opened.isError).toBeUndefined();
    expect(opened.structuredContent?.openedExisting).toBe(true);
    // DISCRIMINATING against 5d3c7939: the opened-existing branch asked only
    // `getDocument(collection, relPath)`, which is null for a container, so
    // this reported `skipped` / "not indexed yet" for a file indexed as two
    // records.
    expect(opened.structuredContent?.sync).toMatchObject({
      status: "completed",
    });
    const reason = (
      opened.structuredContent?.sync as { reason?: string } | undefined
    )?.reason;
    expect(reason).toContain("2 logical record documents");
    expect(reason).not.toContain("not indexed");
    // `docid` stays the schema-required empty string: the container path has no
    // document of its own, and any one record would disagree with the URI.
    expect(opened.structuredContent?.docid).toBe("");

    const text = opened.content[0]?.text ?? "";
    expect(text).not.toContain("Doc: ");
    expect(text).toContain("Sync: completed");
    expect(text).toContain("Note: Existing file is a record container");
  });

  test("opening an existing ordinary markdown file is still reported plainly", async () => {
    const ctx = recordsContext();
    const created = await handleCapture(
      { collection: "records", path: "plain.md", content: "# Plain\n\nBody" },
      ctx
    );
    expect(created.isError).toBeUndefined();

    const opened = await handleCapture(
      {
        collection: "records",
        path: "plain.md",
        content: "ignored on open",
        collisionPolicy: "open_existing",
      },
      ctx
    );

    expect(opened.structuredContent?.openedExisting).toBe(true);
    expect(opened.structuredContent?.sync).toMatchObject({
      status: "completed",
      reason: "Existing capture already indexed.",
    });
    expect(opened.structuredContent?.docid).not.toBe("");
  });

  test("opening an existing UNINDEXED file is still reported as unindexed", async () => {
    await Bun.write(join(tmpDir, "stray.jsonl"), '{"id":"a","text":"b"}\n');

    const opened = await handleCapture(
      {
        collection: "records",
        path: "stray.jsonl",
        content: "ignored on open",
        collisionPolicy: "open_existing",
      },
      recordsContext()
    );

    expect(opened.structuredContent?.openedExisting).toBe(true);
    // The record-aware lookup must not become a rubber stamp: nothing synced
    // this file, so it is on disk and in no index.
    expect(opened.structuredContent?.sync).toMatchObject({
      status: "skipped",
      reason: "Existing capture opened from disk but is not indexed yet.",
    });
    expect(opened.structuredContent?.docid).toBe("");
  });

  test("an ordinary markdown capture still prints Doc and no Note line", async () => {
    const result = await handleCapture(
      { collection: "records", path: "plain.md", content: "# Plain\n\nBody" },
      recordsContext()
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Doc: ");
    expect(result.structuredContent?.docid).not.toBe("");
    expect(text).not.toContain("Note: ");
  });
});
