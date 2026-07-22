import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("doctor schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("doctor");
  });

  test("validates embedding fingerprint diagnostics", () => {
    const doctor = {
      healthy: true,
      activation: {
        schemaVersion: "1.0",
        usable: true,
        healthy: true,
        collections: [],
        connectors: [],
        connectorProjection: { total: 0, projected: 0, truncated: false },
      },
      checks: [
        {
          name: "embedding-fingerprint",
          status: "warn",
          message: "current abc123def456, 2 pending/stale, 1 legacy, 2 groups",
          details: [
            "Run: gno embed",
            "If vectors still look stale, run: gno embed --force",
          ],
          embeddingFingerprint: {
            model: "hf:model/embed.gguf",
            currentFingerprint: "abc123def4567890",
            pendingChunks: 2,
            legacyChunks: 1,
            mixedGroups: 2,
            groups: [
              {
                model: "hf:model/embed.gguf",
                fingerprint: "abc123def4567890",
                count: 10,
                current: true,
                legacy: false,
              },
              {
                model: "hf:model/embed.gguf",
                fingerprint: "",
                count: 1,
                current: false,
                legacy: true,
              },
            ],
          },
        },
      ],
    };

    expect(assertValid(doctor, schema)).toBe(true);
  });

  test("rejects negative fingerprint counts", () => {
    const doctor = {
      healthy: true,
      checks: [
        {
          name: "embedding-fingerprint",
          status: "ok",
          message: "current abc123def456, 0 pending/stale, 0 legacy, 0 groups",
          embeddingFingerprint: {
            model: "hf:model/embed.gguf",
            currentFingerprint: "abc123def4567890",
            pendingChunks: -1,
            legacyChunks: 0,
            mixedGroups: 0,
            groups: [],
          },
        },
      ],
    };

    expect(assertInvalid(doctor, schema)).toBe(true);
  });

  test("rejects arbitrary fields on connector projections", () => {
    const doctor = {
      healthy: false,
      activation: {
        schemaVersion: "1.0",
        usable: false,
        healthy: false,
        collections: [],
        connectors: [
          {
            collection: "notes",
            target: "cursor-mcp",
            status: "failed",
            code: "connector_search_failed",
            remediation: "Repeat explicit verification.",
            connectorOutput: "must not cross the diagnostic boundary",
          },
        ],
        connectorProjection: { total: 1, projected: 1, truncated: false },
      },
      checks: [],
    };

    expect(assertInvalid(doctor, schema)).toBe(true);
  });

  test("rejects contradictory semantic availability states", () => {
    const doctor = {
      healthy: true,
      activation: {
        schemaVersion: "1.0",
        usable: true,
        healthy: true,
        collections: [
          {
            collection: "notes",
            ready: true,
            generatedAt: "2026-07-22T10:00:00.000Z",
            stages: {
              index: {
                status: "passed",
                startedAt: null,
                completedAt: null,
                latencyMs: 1,
              },
              lexical: {
                status: "passed",
                startedAt: null,
                completedAt: null,
                latencyMs: 1,
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
              code: "vector_unavailable",
              command: "gno doctor",
            },
            remediation: null,
          },
        ],
        connectors: [],
        connectorProjection: { total: 0, projected: 0, truncated: false },
      },
      checks: [],
    };

    expect(assertInvalid(doctor, schema)).toBe(true);
  });

  test("rejects corpus-bearing fields at the doctor root", () => {
    const doctor = {
      healthy: true,
      activation: {
        schemaVersion: "1.0",
        usable: false,
        healthy: false,
        collections: [],
        connectors: [],
        connectorProjection: { total: 0, projected: 0, truncated: false },
      },
      checks: [],
      rawCorpus: "must not cross the diagnostic boundary",
    };

    expect(assertInvalid(doctor, schema)).toBe(true);
  });
});
