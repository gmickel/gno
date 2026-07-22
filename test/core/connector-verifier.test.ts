import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpConnectorVerificationTarget } from "../../src/core/connector-verifier";

import {
  getConnectorVerificationRemediation,
  isSafeLocalGnoMcpCommand,
  verifyConnectorActivation,
} from "../../src/core/connector-verifier";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const FIXED_NOW = new Date("2026-07-22T10:00:00.000Z");
const COLLECTION = "notes";
const REL_PATH = "architecture.md";
const URI = `gno://${COLLECTION}/${REL_PATH}`;

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

describe("connector activation verifier", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let sourceHash: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-connector-verifier-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index.sqlite"), "unicode61")).ok
    ).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: COLLECTION,
            path: testDir,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    const markdown =
      "# Architecture\nZephyrlattice proves connector retrieval.";
    sourceHash = hash(`source:${markdown}`);
    const mirrorHash = hash(`mirror:${markdown}`);
    expect(
      (
        await adapter.upsertDocument({
          collection: COLLECTION,
          relPath: REL_PATH,
          sourceHash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: markdown.length,
          sourceMtime: "2026-07-22T09:00:00.000Z",
          mirrorHash,
          title: "Architecture",
        })
      ).ok
    ).toBe(true);
    expect((await adapter.upsertContent(mirrorHash, markdown)).ok).toBe(true);
    expect(
      (
        await adapter.upsertChunks(mirrorHash, [
          {
            seq: 0,
            pos: 0,
            text: markdown,
            startLine: 1,
            endLine: 2,
          },
        ])
      ).ok
    ).toBe(true);
    expect((await adapter.syncDocumentFts(COLLECTION, REL_PATH)).ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  const options = {
    force: true,
    timeoutMs: 1000,
    now: () => FIXED_NOW,
    monotonicNow: () => 10,
  };

  async function createMcpFixture(
    mode:
      | "pass"
      | "missing-tools"
      | "status-fails"
      | "status-timeout"
      | "search-fails"
      | "mismatch"
  ): Promise<{ command: string; args: string[] }> {
    const fixtureDir = join(testDir, "fixture");
    await mkdir(fixtureDir, { recursive: true });
    const scriptPath = join(fixtureDir, "gno");
    const sdkRoot = join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm"
    );
    const hasSearch = mode !== "missing-tools";
    const hasStatus = mode !== "missing-tools";
    const script = `
import { McpServer } from ${JSON.stringify(`${sdkRoot}/server/mcp.js`)};
import { StdioServerTransport } from ${JSON.stringify(`${sdkRoot}/server/stdio.js`)};
import { z } from ${JSON.stringify(join(process.cwd(), "node_modules/zod/index.js"))};
const server = new McpServer({ name: "fixture", version: "1.0.0" });
${
  hasStatus
    ? mode === "status-timeout"
      ? `server.tool("gno_status", {}, async () => await new Promise(() => {}));`
      : `server.tool("gno_status", {}, async () => ({ isError: ${mode === "status-fails"}, content: [{ type: "text", text: "status" }], structuredContent: {} }));`
    : ""
}
${
  hasSearch
    ? `server.tool("gno_search", { query: z.string(), collection: z.string(), limit: z.number() }, async () => ({ isError: ${mode === "search-fails"}, content: [{ type: "text", text: "discarded snippet" }], structuredContent: { results: [{ uri: ${JSON.stringify(mode === "mismatch" ? "gno://notes/wrong.md" : URI)}, snippet: "discarded snippet", source: { sourceHash: ${JSON.stringify(sourceHash)} } }] } }));`
    : ""
}
await server.connect(new StdioServerTransport());
await new Promise((resolve) => process.stdin.once("end", resolve));
`;
    await Bun.write(scriptPath, script);
    return { command: process.execPath, args: [scriptPath, "mcp"] };
  }

  function mcpTarget(serverEntry: {
    command: string;
    args: string[];
  }): McpConnectorVerificationTarget {
    return {
      kind: "mcp",
      id: "fixture-mcp",
      target: "fixture",
      scope: "user",
      configPath: join(testDir, "mcp.json"),
      configured: true,
      serverEntry,
    };
  }

  test("accepts only local read-only GNO command shapes", () => {
    expect(
      isSafeLocalGnoMcpCommand({ command: "/usr/local/bin/gno", args: ["mcp"] })
    ).toBe(true);
    expect(
      isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["/Users/test/.bun/bin/gno", "mcp"],
      })
    ).toBe(true);
    expect(
      isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["run", "/Users/test/work/gno/src/cli/index.ts", "mcp"],
      })
    ).toBe(true);
    expect(
      isSafeLocalGnoMcpCommand({
        command: process.execPath,
        args: ["x", "@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      isSafeLocalGnoMcpCommand({
        command: "bunx",
        args: ["@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      isSafeLocalGnoMcpCommand({
        command: "npx",
        args: ["@gmickel/gno", "mcp"],
      })
    ).toBe(false);
    expect(
      isSafeLocalGnoMcpCommand({
        command: "/usr/local/bin/gno",
        args: ["mcp", "--enable-write"],
      })
    ).toBe(false);
    expect(
      isSafeLocalGnoMcpCommand({ command: "sh", args: ["-c", "gno mcp"] })
    ).toBe(false);
  });

  test("executes tools list, status, and scoped search through stdio", async () => {
    const result = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget(await createMcpFixture("pass")),
      options
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(true);
    expect(result.value.stages.connector.status).toBe("passed");
    expect(result.value.evidence.connectorTarget).toMatch(
      /^mcp:fixture:user:[a-f0-9]{64}$/
    );

    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("Zephyrlattice");
    expect(serialized).not.toContain("discarded snippet");
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
      16_384
    );
  });

  test("reports skill installation as runtime-unverifiable, never passed", async () => {
    const result = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      {
        kind: "skill",
        id: "codex-skill",
        target: "codex",
        scope: "user",
        configPath: join(testDir, "skills/gno"),
        installed: true,
      },
      options
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages.connector).toMatchObject({
        status: "skipped",
        code: "target_runtime_unverifiable",
      });
    }
  });

  test("reports missing and unavailable MCP targets with stable codes", async () => {
    const missingConfig = mcpTarget({
      command: "/missing/gno",
      args: ["mcp"],
    });
    missingConfig.configured = false;
    missingConfig.serverEntry = undefined;
    const notConfigured = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      missingConfig,
      options
    );
    expect(notConfigured.ok).toBe(true);
    if (notConfigured.ok) {
      expect(notConfigured.value.stages.connector).toMatchObject({
        status: "skipped",
        code: "connector_not_configured",
      });
    }

    const unavailable = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget({ command: "/missing/gno", args: ["mcp"] }),
      options
    );
    expect(unavailable.ok).toBe(true);
    if (unavailable.ok) {
      expect(unavailable.value.stages.connector).toMatchObject({
        status: "failed",
        code: "connector_start_failed",
      });
    }
  });

  test.each([
    ["missing-tools", "connector_missing_tools"],
    ["status-fails", "connector_status_failed"],
    ["status-timeout", "connector_timeout"],
    ["search-fails", "connector_search_failed"],
    ["mismatch", "connector_result_mismatch"],
  ] as const)("maps %s to stable failure code", async (mode, expectedCode) => {
    const result = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget(await createMcpFixture(mode)),
      options
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages.connector).toMatchObject({
        status: "failed",
        code: expectedCode,
      });
    }
  });

  test("rejects unsafe config without spawning and maps bounded remediation", async () => {
    const result = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget({
        command: process.execPath,
        args: ["x", "@gmickel/gno", "mcp"],
      }),
      options
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages.connector.code).toBe(
        "connector_unsupported_config"
      );
    }
    expect(
      getConnectorVerificationRemediation(
        "connector_unsupported_config",
        "Cursor"
      )
    ).toBe("Replace the Cursor entry with a local read-only GNO MCP command.");
  });

  test("invalidates connector success when config identity changes", async () => {
    const serverEntry = await createMcpFixture("pass");
    const first = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget(serverEntry),
      options
    );
    const secondTarget = mcpTarget(serverEntry);
    secondTarget.configPath = join(testDir, "project/mcp.json");
    secondTarget.scope = "project";
    const second = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      secondTarget,
      options
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.fingerprint).not.toBe(second.value.fingerprint);
      expect(first.value.evidence.connectorTarget).not.toBe(
        second.value.evidence.connectorTarget
      );
    }

    const changedCommand = mcpTarget({
      ...serverEntry,
      args: [...serverEntry.args, "serve"],
    });
    changedCommand.id = "fixture-mcp-v2";
    const third = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      changedCommand,
      options
    );
    expect(third.ok).toBe(true);
    if (first.ok && third.ok) {
      expect(first.value.fingerprint).not.toBe(third.value.fingerprint);
    }
  });

  test("persists no child output or raw probe query", async () => {
    const result = await verifyConnectorActivation(
      adapter,
      COLLECTION,
      mcpTarget(await createMcpFixture("pass")),
      options
    );
    expect(result.ok).toBe(true);
    const rows = adapter
      .getRawDb()
      .query<{ receipt_json: string }, []>(
        "SELECT receipt_json FROM activation_receipts"
      )
      .all();
    const persisted = rows.map(({ receipt_json }) => receipt_json).join("\n");
    expect(persisted).not.toContain("Zephyrlattice");
    expect(persisted).not.toContain("discarded snippet");
    expect(persisted).not.toContain("@gmickel/gno");
  });
});
