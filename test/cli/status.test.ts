import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StatusResult } from "../../src/cli/commands/status";

import { formatStatus } from "../../src/cli/commands/status";
import { runCli } from "../../src/cli/run";
import { loadConfigFromPath, saveConfigToPath } from "../../src/config";
import { safeRm } from "../helpers/cleanup";

function statusResult(): StatusResult {
  return {
    success: true,
    status: {
      version: "1.0",
      indexName: "default",
      configPath: "/tmp/config.yml",
      dbPath: "/tmp/index.sqlite",
      ftsTokenizer: "unicode61",
      collections: [],
      totalDocuments: 0,
      activeDocuments: 0,
      totalChunks: 0,
      embeddingBacklog: 0,
      recentErrors: 0,
      lastUpdatedAt: null,
      healthy: true,
    },
    activation: {
      schemaVersion: "1.0",
      usable: false,
      healthy: false,
      collections: [
        {
          collection: "notes",
          ready: false,
          generatedAt: "2026-07-22T10:00:00.000Z",
          stages: {
            index: {
              status: "failed",
              startedAt: null,
              completedAt: null,
              latencyMs: 1,
              code: "index_out_of_sync",
            },
            lexical: {
              status: "skipped",
              startedAt: null,
              completedAt: null,
              latencyMs: null,
              code: "index_out_of_sync",
            },
            semantic: {
              status: "pending",
              startedAt: null,
              completedAt: null,
              latencyMs: null,
              code: "semantic_not_checked",
            },
            connector: {
              status: "skipped",
              startedAt: null,
              completedAt: null,
              latencyMs: null,
              code: "connector_not_requested",
            },
          },
          semanticAvailability: {
            status: "pending",
            code: "models_missing",
            command: "gno models pull --embed",
          },
          remediation: {
            stage: "index",
            code: "index_out_of_sync",
            command: "gno index notes --no-embed",
            message: "Rebuild this collection's lexical index.",
          },
        },
      ],
      connectors: [],
      connectorProjection: { total: 0, projected: 0, truncated: false },
    },
    contentTypeBoost: {
      rulesFingerprint:
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      rules: [],
    },
    memory: {
      managedCollections: 0,
      records: 0,
      malformed: 0,
      collections: [],
    },
    backgroundIssues: [],
    budgetStops: [],
  };
}

test("default chunking preserves terminal output while custom pending state is explicit", () => {
  const result = statusResult();
  if (!result.success) throw new Error("Expected status fixture");
  const original = formatStatus(result, {});
  result.status.chunking = {
    configured: { maxTokens: 800, overlapPercent: 0.15 },
    applied: { maxTokens: 800, overlapPercent: 0.15 },
    state: "legacy-default",
    pendingDocuments: 0,
    pendingMirrors: 0,
  };
  expect(formatStatus(result, {})).toBe(original);
  result.status.chunking.configured = { maxTokens: 256, overlapPercent: 0 };
  result.status.chunking.state = "pending";
  result.status.chunking.pendingDocuments = 2;
  result.status.chunking.pendingMirrors = 1;
  expect(formatStatus(result, {})).toContain(
    "configured 256 approximate tokens / 0% overlap"
  );
  expect(formatStatus(result, {})).toContain(
    "applied 800 approximate tokens / 15% overlap"
  );
  expect(formatStatus(result, { md: true })).toContain(
    "2 documents / 1 mirrors pending"
  );
  expect(JSON.parse(formatStatus(result, { json: true })).chunking).toEqual(
    result.status.chunking
  );
});

describe("gno status activation output", () => {
  test("keeps legacy fields and makes lexical failure visibly degraded", () => {
    const result = statusResult();
    const json = JSON.parse(formatStatus(result, { json: true }));
    if (!result.success) {
      throw new Error("Expected successful status fixture");
    }
    expect(json.indexName).toBe("default");
    expect(json.healthy).toBe(false);
    expect(json.activation).toMatchObject({ usable: false, healthy: false });
    expect(json.contentTypeBoost).toEqual(result.contentTypeBoost);

    const terminal = formatStatus(result, {});
    expect(terminal).toContain("Health: DEGRADED");
    expect(terminal).toContain("Lexical activation: BLOCKED");
    expect(terminal).toContain("index: index_out_of_sync");
    expect(terminal).toContain("gno index notes --no-embed");
  });

  test.each([
    {
      label: "unevaluated",
      omitted: undefined,
      projection:
        "Connector projection: 64/85 target/collection checks shown; 21 omitted, no result claimed",
      healthy: false,
    },
    {
      label: "evaluated and passing",
      omitted: { passed: 21, failed: 0, incomplete: 0, notApplicable: 0 },
      projection:
        "Connector projection: 64/85 target/collection checks shown; 21 omitted (21 passed)",
      healthy: true,
    },
  ])(
    "reports omitted connector projections in human-readable output: $label",
    ({ omitted, projection, healthy }) => {
      const result = statusResult();
      if (!result.success) {
        throw new Error("Expected status fixture to succeed");
      }
      result.activation.usable = true;
      result.activation.healthy = true;
      result.activation.connectors = Array.from({ length: 64 }, (_, index) => ({
        collection: "notes",
        target: index === 0 ? "cursor-mcp" : `connector-${index}`,
        status: "passed",
        remediation: null,
      }));
      result.activation.connectorProjection = {
        total: 85,
        projected: 64,
        truncated: true,
        ...(omitted ? { omitted } : {}),
      };

      const terminal = formatStatus(result, {});
      const markdown = formatStatus(result, { md: true });
      expect(terminal).toContain(projection);
      expect(markdown).toContain(projection);
      expect(terminal).toContain(healthy ? "Health: OK" : "Health: DEGRADED");
      expect(terminal).toContain("Lexical activation: READY");
      expect(terminal).not.toContain("\nActivation: READY");
      expect(markdown).toContain("**Lexically healthy**: true");
      expect(markdown).not.toContain("**Healthy**: true");
      expect(JSON.parse(formatStatus(result, { json: true })).healthy).toBe(
        healthy
      );
    }
  );

  test("reports a collection with no documents as informational, not degraded", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "gno-status-activation-"));
    const emptyDir = join(testDir, "empty");
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const previousEnv = {
      config: process.env.GNO_CONFIG_DIR,
      data: process.env.GNO_DATA_DIR,
      cache: process.env.GNO_CACHE_DIR,
    };
    let output = "";

    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    try {
      await mkdir(emptyDir, { recursive: true });
      expect(
        await runCli(["bun", "gno", "init", emptyDir, "--name", "empty"])
      ).toBe(0);
      output = "";

      const code = await runCli(["bun", "gno", "status", "--json"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed).toMatchObject({
        healthy: true,
        activation: { usable: false, healthy: true },
      });
      expect(parsed.activation.collections[0].remediation).toMatchObject({
        code: "no_documents",
        command: "gno update",
      });

      output = "";
      expect(await runCli(["bun", "gno", "status"])).toBe(0);
      expect(output).toContain("Lexical activation: NO DOCUMENTS YET");
      expect(output).toContain(
        "empty: no documents yet (add files, then run gno update)"
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
      setOptionalEnv("GNO_CONFIG_DIR", previousEnv.config);
      setOptionalEnv("GNO_DATA_DIR", previousEnv.data);
      setOptionalEnv("GNO_CACHE_DIR", previousEnv.cache);
      await safeRm(testDir);
    }
  });
});

async function withIsolatedGno(
  prefix: string,
  run: (ctx: {
    testDir: string;
    cli: (...args: string[]) => Promise<number>;
    readOutput: () => string;
  }) => Promise<void>
): Promise<void> {
  const testDir = await mkdtemp(join(tmpdir(), prefix));
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const previousEnv = {
    config: process.env.GNO_CONFIG_DIR,
    data: process.env.GNO_DATA_DIR,
    cache: process.env.GNO_CACHE_DIR,
  };
  let output = "";
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };

  try {
    await run({
      testDir,
      cli: (...args: string[]) => {
        output = "";
        return runCli(["bun", "gno", ...args]);
      },
      readOutput: () => output,
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
    setOptionalEnv("GNO_CONFIG_DIR", previousEnv.config);
    setOptionalEnv("GNO_DATA_DIR", previousEnv.data);
    setOptionalEnv("GNO_CACHE_DIR", previousEnv.cache);
    await safeRm(testDir);
  }
}

/** Index "keep" and "gone" without embedding, so each leaves one backlog chunk. */
async function indexTwoCollections(
  testDir: string,
  cli: (...args: string[]) => Promise<number>
): Promise<void> {
  for (const name of ["keep", "gone"]) {
    await Bun.write(join(testDir, name, `${name}.md`), `# ${name}\n\nbody\n`);
  }
  expect(await cli("init", join(testDir, "keep"), "--name", "keep")).toBe(0);
  expect(
    await cli("collection", "add", join(testDir, "gone"), "--name", "gone")
  ).toBe(0);
  expect(await cli("update")).toBe(0);
}

function goneRows(testDir: string): { collections: number; documents: number } {
  const db = new Database(join(testDir, "data", "index-default.sqlite"), {
    readonly: true,
  });
  try {
    const count = (sql: string): number =>
      db.query<{ n: number }, []>(sql).get()?.n ?? 0;
    return {
      collections: count(
        "SELECT COUNT(*) AS n FROM collections WHERE name = 'gone'"
      ),
      documents: count(
        "SELECT COUNT(*) AS n FROM documents WHERE collection = 'gone'"
      ),
    };
  } finally {
    db.close();
  }
}

test("gno collection remove clears the collection from the index at once", async () => {
  await withIsolatedGno(
    "gno-status-removed-",
    async ({ testDir, cli, readOutput }) => {
      await indexTwoCollections(testDir, cli);
      expect(await cli("status", "--json")).toBe(0);
      expect(JSON.parse(readOutput()).embeddingBacklog).toBe(2);

      expect(await cli("collection", "remove", "gone")).toBe(0);

      // No other command runs between the removal and these checks.
      expect(goneRows(testDir)).toEqual({ collections: 0, documents: 0 });
      expect(await cli("status", "--json")).toBe(0);
      const parsed = JSON.parse(readOutput());
      expect(parsed.collections.map((c: { name: string }) => c.name)).toEqual([
        "keep",
      ]);
      expect(parsed.totalDocuments).toBe(1);
      expect(parsed.totalChunks).toBe(1);
      expect(parsed.embeddingBacklog).toBe(1);
    }
  );
}, 30_000);

test("gno collection rename drops the old name's documents at once", async () => {
  await withIsolatedGno(
    "gno-status-renamed-",
    async ({ testDir, cli, readOutput }) => {
      await indexTwoCollections(testDir, cli);

      expect(await cli("collection", "rename", "gone", "moved")).toBe(0);
      expect(readOutput()).toContain("Run: gno update");

      expect(goneRows(testDir)).toEqual({ collections: 0, documents: 0 });
      expect(await cli("status", "--json")).toBe(0);
      let parsed = JSON.parse(readOutput());
      expect(
        parsed.collections.map((c: { name: string; documentCount: number }) => [
          c.name,
          c.documentCount,
        ])
      ).toEqual([
        ["keep", 1],
        ["moved", 0],
      ]);
      expect(parsed.embeddingBacklog).toBe(1);

      expect(await cli("update")).toBe(0);
      expect(await cli("status", "--json")).toBe(0);
      parsed = JSON.parse(readOutput());
      expect(parsed.totalDocuments).toBe(2);
      expect(parsed.embeddingBacklog).toBe(2);
    }
  );
}, 30_000);

test("status ignores and cleanup purges a collection removed by editing the config", async () => {
  await withIsolatedGno(
    "gno-status-hand-removed-",
    async ({ testDir, cli, readOutput }) => {
      await indexTwoCollections(testDir, cli);
      const configPath = join(testDir, "config", "index.yml");
      const loaded = await loadConfigFromPath(configPath);
      if (!loaded.ok) throw new Error(loaded.error.message);
      loaded.value.collections = loaded.value.collections.filter(
        (c) => c.name !== "gone"
      );
      const saved = await saveConfigToPath(loaded.value, configPath);
      if (!saved.ok) throw new Error(saved.error.message);

      // Rows of "gone" are still in the index, but status reads the config.
      expect(goneRows(testDir)).toEqual({ collections: 1, documents: 1 });
      expect(await cli("status", "--json")).toBe(0);
      const parsed = JSON.parse(readOutput());
      expect(parsed.totalDocuments).toBe(1);
      expect(parsed.embeddingBacklog).toBe(1);

      expect(await cli("cleanup")).toBe(0);
      expect(goneRows(testDir)).toEqual({ collections: 0, documents: 0 });
    }
  );
}, 30_000);

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

test("lists files stopped at the conversion budget in terminal output (fn-198)", () => {
  const result = statusResult();
  if (!result.success) throw new Error("Expected status fixture");
  result.budgetStops = [
    {
      collection: "wb",
      relPath: "reports/pivot.xlsx",
      code: "MEMORY_LIMIT",
      message:
        "Conversion stopped: resident memory 8300 MB exceeded the 8192 MB budget",
    },
  ];

  expect(formatStatus(result, {})).toContain(
    "Stopped at conversion budget (retried by the next update):\n  wb/reports/pivot.xlsx [MEMORY_LIMIT] Conversion stopped"
  );
});
