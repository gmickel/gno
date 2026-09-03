/**
 * MCP gno_capture tool tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
  const originalSyncPaths =
    defaultSyncService.syncPaths.bind(defaultSyncService);

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
    defaultSyncService.syncPaths = originalSyncPaths;
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

  test("fails the tool when the file is written but sync fails", async () => {
    defaultSyncService.syncPaths = (async () => ({
      collection: "notes",
      filesProcessed: 1,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesErrored: 1,
      filesSkipped: 0,
      filesMarkedInactive: 0,
      durationMs: 1,
      files: [
        {
          relPath: "sync-failed.md",
          status: "error",
          errorCode: "PARSE_ERROR",
          errorMessage: "bad markdown",
        },
      ],
      errors: [],
    })) as unknown as typeof defaultSyncService.syncPaths;

    const result = await handleCapture(
      {
        collection: "notes",
        content: "Written before sync fails",
        path: "sync-failed.md",
      },
      toolContext(true)
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toBe("CAPTURE_SYNC_FAILED");
    expect(result.content[0]?.text).toContain(
      `Capture written to ${join(tmpDir, "sync-failed.md")} but lexical sync failed: PARSE_ERROR - bad markdown`
    );
    expect(await Bun.file(join(tmpDir, "sync-failed.md")).text()).toContain(
      "Written before sync fails"
    );
  });

  test("open_existing syncs a disk-only file before returning", async () => {
    await Bun.write(
      join(tmpDir, "on-disk.md"),
      "# On disk\n\nunindexed body\n"
    );
    const before = await store.getDocument("notes", "on-disk.md");
    expect(before.ok && before.value).toBeNull();

    const result = await handleCapture(
      {
        collection: "notes",
        content: "ignored",
        path: "on-disk.md",
        collisionPolicy: "open_existing",
      },
      toolContext(true)
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.openedExisting).toBe(true);
    expect(result.structuredContent?.sync).toMatchObject({
      status: "completed",
    });
    expect(result.structuredContent?.docid).toBeString();
    const after = await store.getDocument("notes", "on-disk.md");
    expect(after.ok && after.value?.docid).toBe(
      result.structuredContent?.docid as string
    );
    const hit = await store.searchFts("unindexed", { limit: 5 });
    expect(
      hit.ok && hit.value.some((row) => row.relPath === "on-disk.md")
    ).toBe(true);
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
