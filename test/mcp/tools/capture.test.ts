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
    };

    registerTools(fakeServer as never, toolContext(false));

    expect(names).not.toContain("gno_capture");
    expect(names).toContain("gno_search");
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
      toolContext(true)
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
