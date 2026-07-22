import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StatusResult } from "../../src/cli/commands/status";

import { formatStatus } from "../../src/cli/commands/status";
import { runCli } from "../../src/cli/run";
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
              code: "no_documents",
            },
            lexical: {
              status: "skipped",
              startedAt: null,
              completedAt: null,
              latencyMs: null,
              code: "no_documents",
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
            code: "no_documents",
            command: "gno index notes --no-embed",
            message: "Index at least one supported text document.",
          },
        },
      ],
      connectors: [],
      connectorProjection: { total: 0, projected: 0, truncated: false },
    },
  };
}

describe("gno status activation output", () => {
  test("keeps legacy fields and makes lexical failure visibly degraded", () => {
    const result = statusResult();
    const json = JSON.parse(formatStatus(result, { json: true }));
    expect(json.indexName).toBe("default");
    expect(json.healthy).toBe(false);
    expect(json.activation).toMatchObject({ usable: false, healthy: false });

    const terminal = formatStatus(result, {});
    expect(terminal).toContain("Health: DEGRADED");
    expect(terminal).toContain("Lexical activation: BLOCKED");
    expect(terminal).toContain("index: no_documents");
    expect(terminal).toContain("gno index notes --no-embed");
  });

  test("reports omitted connector projections in human-readable output", () => {
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
    };

    const projection =
      "Connector projection: 64/85 target/collection checks shown; 21 omitted";
    const terminal = formatStatus(result, {});
    const markdown = formatStatus(result, { md: true });
    expect(terminal).toContain(projection);
    expect(markdown).toContain(projection);
    expect(terminal).toContain("Health: DEGRADED");
    expect(terminal).toContain("Lexical activation: READY");
    expect(terminal).not.toContain("\nActivation: READY");
    expect(markdown).toContain("**Lexically healthy**: true");
    expect(markdown).not.toContain("**Healthy**: true");
    expect(JSON.parse(formatStatus(result, { json: true })).healthy).toBe(
      false
    );
  });

  test("exits 0 with structured unhealthy activation", async () => {
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
        healthy: false,
        activation: { usable: false, healthy: false },
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      setOptionalEnv("GNO_CONFIG_DIR", previousEnv.config);
      setOptionalEnv("GNO_DATA_DIR", previousEnv.data);
      setOptionalEnv("GNO_CACHE_DIR", previousEnv.cache);
      await safeRm(testDir);
    }
  });
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}
