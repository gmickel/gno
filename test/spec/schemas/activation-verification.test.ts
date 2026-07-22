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
});
