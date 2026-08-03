import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";

import { getConfigPath, getIndexDbPath } from "../../../src/app/constants";
import { runCli } from "../../../src/cli/run";
import { loadConfig } from "../../../src/config";
import { Mutex } from "../../../src/mcp/context";
import {
  auditInputSchema,
  AUDIT_MCP_ANNOTATIONS,
  handleAudit,
} from "../../../src/mcp/tools/audit";
import {
  MCP_TOOL_DESCRIPTIONS,
  MCP_WRITE_TOOL_NAMES,
} from "../../../src/mcp/tools/index";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

const totalChanges = (store: SqliteAdapter): number =>
  store
    .getRawDb()
    .query<{ changes: number }, []>("SELECT total_changes() AS changes")
    .get()?.changes ?? 0;

describe("gno_audit MCP tool", () => {
  let root: string;
  let notes: string;
  let store: SqliteAdapter;
  let context: ToolContext;
  let previousEnvironment: Record<string, string | undefined>;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-mcp-audit-"));
    notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    previousEnvironment = {
      GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
      GNO_DATA_DIR: process.env.GNO_DATA_DIR,
      GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    };
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    await Bun.write(join(notes, "a.md"), "# A\n\n[[B]]\n");
    await Bun.write(join(notes, "b.md"), "# B\n");
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (): boolean => true;
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);
    process.stdout.write = originalStdoutWrite;

    const loaded = await loadConfig();
    if (!loaded.ok) throw new Error(loaded.error.message);
    store = new SqliteAdapter();
    const opened = store.openReadOnly(getIndexDbPath());
    if (!opened.ok) throw new Error(opened.error.message);
    context = {
      store,
      config: loaded.value,
      collections: loaded.value.collections,
      actualConfigPath: getConfigPath(),
      indexName: "default",
      toolMutex: new Mutex(),
      jobManager: {},
      serverInstanceId: "audit-test",
      writeLockPath: join(root, ".lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    } as unknown as ToolContext;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    await store?.close();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await safeRm(root);
  });

  test("returns the shared bounded report and performs no writes", async () => {
    const input = auditInputSchema.parse({ category: "links", maxFindings: 1 });
    const before = totalChanges(store);
    const result = await handleAudit(input, context);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.status).toBe("complete");
    expect(result.structuredContent?.scope).toMatchObject({
      categories: ["links"],
      indexName: "default",
    });
    expect(totalChanges(store)).toBe(before);
  });

  test("normalizes case-insensitive collection filters", async () => {
    const result = await handleAudit(
      auditInputSchema.parse({ category: "links", collections: [" Notes "] }),
      context
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.scope).toMatchObject({
      collections: ["notes"],
    });
  });

  test("returns explicit partial cancellation instead of false clean", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handleAudit(
      auditInputSchema.parse({ category: "all" }),
      context,
      controller.signal
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.status).toBe("partial");
    expect(result.structuredContent?.rules).toEqual([
      expect.objectContaining({
        ruleId: "audit.cancelled",
        status: "inconclusive",
        skipReason: "cancelled",
      }),
    ]);
  });

  test("projects unavailable source evidence through the same partial status", async () => {
    await rename(notes, join(root, "offline-notes"));
    const result = await handleAudit(
      auditInputSchema.parse({ category: "freshness" }),
      context
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.status).toBe("partial");
    expect(result.structuredContent?.rules).toContainEqual(
      expect.objectContaining({
        ruleId: "freshness.source-readable",
        status: "unavailable",
      })
    );
  });

  test("projects runtime failures as MCP errors rather than clean reports", async () => {
    const result = await handleAudit(
      auditInputSchema.parse({ collections: ["missing"] }),
      context
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "RUNTIME",
      message: "Collection not found: missing",
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Collection not found: missing"),
      })
    );
  });

  test("rejects path scopes that would widen or violate the report contract", async () => {
    const whitespace = await handleAudit(
      auditInputSchema.parse({ category: "links", paths: ["   "] }),
      context
    );
    expect(whitespace.isError).toBe(true);
    expect(whitespace.structuredContent).toEqual({
      error: "RUNTIME",
      message: "path filters must not be empty or whitespace-only",
    });

    const overlong = await handleAudit(
      auditInputSchema.parse({ category: "links", paths: ["x".repeat(2049)] }),
      context
    );
    expect(overlong.isError).toBe(true);
    expect(overlong.structuredContent).toEqual({
      error: "RUNTIME",
      message: "path filters must be at most 2048 characters",
    });

    const tag = await handleAudit(
      auditInputSchema.parse({ category: "links", tags: ["x".repeat(257)] }),
      context
    );
    expect(tag.isError).toBe(true);
    expect(tag.structuredContent).toEqual({
      error: "RUNTIME",
      message: "tags entries must be at most 256 characters",
    });
  });

  test("closes input and advertises independently verified read-only behavior", () => {
    expect(auditInputSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(AUDIT_MCP_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(MCP_WRITE_TOOL_NAMES.has("gno_audit")).toBe(false);
    expect(MCP_TOOL_DESCRIPTIONS.audit).toContain("read-only");
  });
});
