import { describe, expect, test } from "bun:test";

import type { StatusResult } from "../../src/cli/commands/status";

import { formatStatus } from "../../src/cli/commands/status";

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
    expect(terminal).toContain("Activation: BLOCKED");
    expect(terminal).toContain("index: no_documents");
    expect(terminal).toContain("gno index notes --no-embed");
  });
});
