import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("activation verification schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("activation-verification");
  });

  const validReceipt = {
    schemaVersion: "1.0",
    collection: "notes",
    fingerprint: "a".repeat(64),
    ready: true,
    generatedAt: "2026-07-22T10:00:00.000Z",
    stages: {
      index: {
        status: "passed",
        startedAt: "2026-07-22T09:59:59.000Z",
        completedAt: "2026-07-22T10:00:00.000Z",
        latencyMs: 1,
      },
      lexical: {
        status: "passed",
        startedAt: "2026-07-22T10:00:00.000Z",
        completedAt: "2026-07-22T10:00:00.000Z",
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
    evidence: {
      probeHash: "b".repeat(64),
      resultUri: "gno://notes/proof.md",
      resultSourceHash: "c".repeat(64),
    },
  };

  test("accepts a bounded redacted receipt", () => {
    expect(assertValid(validReceipt, schema)).toBe(true);
  });

  test("accepts connector-specific success and stable failure receipts", () => {
    expect(
      assertValid(
        {
          ...validReceipt,
          fingerprint: "d".repeat(64),
          stages: {
            ...validReceipt.stages,
            connector: {
              status: "passed",
              startedAt: "2026-07-22T10:00:00.000Z",
              completedAt: "2026-07-22T10:00:00.000Z",
              latencyMs: 4,
            },
          },
          evidence: {
            ...validReceipt.evidence,
            connectorTarget: `mcp:cursor:user:${"e".repeat(64)}`,
          },
        },
        schema
      )
    ).toBe(true);
    expect(
      assertValid(
        {
          ...validReceipt,
          stages: {
            ...validReceipt.stages,
            connector: {
              status: "failed",
              startedAt: "2026-07-22T10:00:00.000Z",
              completedAt: "2026-07-22T10:00:00.000Z",
              latencyMs: 4,
              code: "connector_timeout",
            },
          },
          evidence: {
            ...validReceipt.evidence,
            connectorTarget: `mcp:cursor:user:${"e".repeat(64)}`,
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects connector proof without target identity", () => {
    expect(
      assertInvalid(
        {
          ...validReceipt,
          stages: {
            ...validReceipt.stages,
            connector: {
              status: "failed",
              startedAt: "2026-07-22T10:00:00.000Z",
              completedAt: "2026-07-22T10:00:00.000Z",
              latencyMs: 4,
              code: "connector_timeout",
            },
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects connector target identities that can leak raw paths", () => {
    expect(
      assertInvalid(
        {
          ...validReceipt,
          stages: {
            ...validReceipt.stages,
            connector: {
              status: "failed",
              startedAt: "2026-07-22T10:00:00.000Z",
              completedAt: "2026-07-22T10:00:00.000Z",
              latencyMs: 4,
              code: "connector_unsupported_config",
            },
          },
          evidence: {
            ...validReceipt.evidence,
            connectorTarget: "mcp:cursor:user:/Users/private/.cursor/mcp.json",
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects raw query and snippet fields", () => {
    expect(assertInvalid({ ...validReceipt, query: "secret" }, schema)).toBe(
      true
    );
    expect(
      assertInvalid(
        {
          ...validReceipt,
          evidence: { ...validReceipt.evidence, snippet: "secret passage" },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects contradictory green readiness", () => {
    const contradictory = {
      ...validReceipt,
      stages: {
        ...validReceipt.stages,
        lexical: {
          status: "failed",
          startedAt: "2026-07-22T10:00:00.000Z",
          completedAt: "2026-07-22T10:00:00.000Z",
          latencyMs: 1,
          code: "retrieval_mismatch",
        },
      },
      evidence: {},
    };

    expect(assertInvalid(contradictory, schema)).toBe(true);
  });
});
