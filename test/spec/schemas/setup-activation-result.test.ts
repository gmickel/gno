import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories and fixture creation without Bun equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { SetupConnectorCompositionDeps } from "../../../src/core/setup-activation";
import type { ActivationVerificationReceipt } from "../../../src/store/types";

import { setupWithActivation } from "../../../src/cli/commands/setup-activation";
import { safeRm } from "../../helpers/cleanup";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const ORIGINAL_DIRS = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

function passedReceipt(): ActivationVerificationReceipt {
  const generatedAt = "2026-07-24T12:00:00.000Z";
  return {
    schemaVersion: "1.0",
    collection: "docs",
    fingerprint: "a".repeat(64),
    ready: true,
    generatedAt,
    stages: {
      index: {
        status: "passed",
        startedAt: generatedAt,
        completedAt: generatedAt,
        latencyMs: 1,
      },
      lexical: {
        status: "passed",
        startedAt: generatedAt,
        completedAt: generatedAt,
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
        status: "passed",
        startedAt: generatedAt,
        completedAt: generatedAt,
        latencyMs: 1,
      },
    },
    evidence: {
      probeHash: "b".repeat(64),
      resultUri: "gno://docs/notes.md",
      resultSourceHash: "c".repeat(64),
      connectorTarget: `mcp:cursor:user:${"d".repeat(64)}`,
    },
  };
}

describe("setup activation result schema", () => {
  let root = "";
  let schema: object;
  let validResult: Record<string, unknown>;
  let failedResult: Record<string, unknown>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-setup-activation-schema-"));
    const folder = join(root, "docs");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "notes.md"),
      "# Notes\n\nThe Atlas launch window opens on Friday."
    );
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    const connectorDeps: SetupConnectorCompositionDeps = {
      getStates: async () => [
        {
          id: "cursor-mcp",
          kind: "mcp",
          target: "cursor",
          scope: "user",
          installed: true,
          configurationError: false,
        },
      ],
      install: async () => {
        throw new Error("installed connector must be reused");
      },
      verify: async () => ({ ok: true, value: passedReceipt() }),
    };
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      connectorDeps,
      semantic: false,
      json: true,
    });
    if (!("connectors" in outcome.result)) {
      throw new Error("Expected composed setup activation result");
    }
    validResult = outcome.result as unknown as Record<string, unknown>;
    const failed = await setupWithActivation({
      folder,
      connectorIds: ["unknown"],
      semantic: false,
      json: true,
    });
    failedResult = failed.result as unknown as Record<string, unknown>;
    schema = await loadSchema("setup-activation-result");
  });

  afterAll(async () => {
    process.env.GNO_CONFIG_DIR = ORIGINAL_DIRS.config;
    process.env.GNO_DATA_DIR = ORIGINAL_DIRS.data;
    process.env.GNO_CACHE_DIR = ORIGINAL_DIRS.cache;
    if (root) {
      await safeRm(root);
    }
  });

  test("accepts the closed outer composition with referenced shipped receipts", () => {
    expect(assertValid(validResult, schema)).toBe(true);
    expect(assertValid(failedResult, schema)).toBe(true);
  });

  test("rejects status contradictions and privacy-leaking connector fields", () => {
    const connectors = validResult.connectors as Record<string, unknown>[];
    expect(
      assertInvalid(
        {
          ...validResult,
          status: "completed_with_actions",
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...failedResult,
          connectors: validResult.connectors,
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...validResult,
          connectors: [
            {
              ...connectors[0],
              configPath: "/Users/private/.cursor/mcp.json",
              rawOutput: "TOKEN=secret",
            },
          ],
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects mismatched fixed connector identity and duplicate schema fields", () => {
    const connectors = validResult.connectors as Record<string, unknown>[];
    expect(
      assertInvalid(
        {
          ...validResult,
          connectors: [
            {
              ...connectors[0],
              kind: "skill",
              target: "codex",
            },
          ],
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...validResult,
          connectors: [{ ...connectors[0], setupReceipt: validResult.setup }],
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects contradictory per-target lifecycle combinations", () => {
    const [connector] = validResult.connectors as Record<string, unknown>[];
    const contradictions = [
      {
        ...connector,
        installation: "failed",
      },
      {
        ...connector,
        verification: "skipped",
      },
      {
        ...connector,
        verification: "failed",
        code: "target_runtime_unverifiable",
      },
      {
        ...connector,
        verification: "not_run",
      },
    ];

    for (const contradictory of contradictions) {
      expect(
        assertInvalid(
          {
            ...validResult,
            status: "completed_with_actions",
            connectors: [contradictory],
          },
          schema
        )
      ).toBe(true);
    }
  });
});
