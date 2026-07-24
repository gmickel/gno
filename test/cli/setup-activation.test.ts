import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories and fixture creation without Bun equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { SetupConnectorCompositionDeps } from "../../src/core/setup-activation";
import type { ActivationVerificationReceipt } from "../../src/store/types";

import {
  formatSetupOutputResult,
  setupWithActivation,
} from "../../src/cli/commands/setup-activation";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];
const ORIGINAL_DIRS = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

async function harness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `gno-setup-activation-${label}-`));
  tempRoots.push(root);
  const folder = join(root, "docs");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "notes.md"),
    "# Notes\n\nThe Atlas launch window opens on Friday."
  );
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  return { root, folder };
}

function verificationReceipt(
  kind: "skill" | "mcp",
  target: string,
  status: "passed" | "failed" | "skipped",
  code?: "target_runtime_unverifiable" | "connector_timeout"
): ActivationVerificationReceipt {
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
        status,
        startedAt: generatedAt,
        completedAt: generatedAt,
        latencyMs: 1,
        ...(code ? { code } : {}),
      },
    },
    evidence: {
      probeHash: "b".repeat(64),
      resultUri: "gno://docs/notes.md",
      resultSourceHash: "c".repeat(64),
      connectorTarget: `${kind}:${target}:user:${"d".repeat(64)}`,
    },
  };
}

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = ORIGINAL_DIRS.config;
  process.env.GNO_DATA_DIR = ORIGINAL_DIRS.data;
  process.env.GNO_CACHE_DIR = ORIGINAL_DIRS.cache;
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("setup connector activation", () => {
  test("no selection preserves setup-command-result and advisory failure is inert", async () => {
    const { folder } = await harness("none");
    let advisoryCalls = 0;
    const outcome = await setupWithActivation({
      folder,
      semantic: false,
      json: true,
      discoverProfileAdvisory: async () => {
        advisoryCalls += 1;
        throw new Error("invalid profile");
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect("setup" in outcome.result).toBe(false);
    expect(outcome.result.status).toBe("completed");
    expect(advisoryCalls).toBe(1);
    assertValid(outcome.result, await loadSchema("setup-command-result"));
  });

  test("rejects unknown IDs before setup or connector side effects", async () => {
    const { folder } = await harness("unknown");
    let connectorCalls = 0;
    const connectorDeps: SetupConnectorCompositionDeps = {
      getStates: async () => {
        connectorCalls += 1;
        return [];
      },
      install: async () => {
        connectorCalls += 1;
        throw new Error("unexpected");
      },
      verify: async () => {
        connectorCalls += 1;
        throw new Error("unexpected");
      },
    };
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["unknown"],
      connectorDeps,
      semantic: false,
    });

    expect(outcome.exitCode).toBe(1);
    expect(connectorCalls).toBe(0);
    expect(
      await Bun.file(join(process.env.GNO_CONFIG_DIR!, "index.yml")).exists()
    ).toBe(false);
    expect(outcome.result).toMatchObject({
      status: "failed",
      setup: {
        status: "failed",
        lexical: { error: { code: "invalid_connector" } },
      },
      connectors: [],
    });
    assertValid(outcome.result, await loadSchema("setup-activation-result"));
  });

  test("dedupes first-seen IDs, installs once, and reports skill execution as unverifiable", async () => {
    const { folder } = await harness("skill");
    let installs = 0;
    let verifications = 0;
    const connectorDeps: SetupConnectorCompositionDeps = {
      getStates: async () => [
        {
          id: "codex-skill",
          kind: "skill",
          target: "codex",
          scope: "user",
          installed: false,
          configurationError: false,
        },
      ],
      install: async () => {
        installs += 1;
        return {
          id: "codex-skill",
          kind: "skill",
          target: "codex",
          scope: "user",
          installed: true,
          configurationError: false,
        };
      },
      verify: async () => {
        verifications += 1;
        return {
          ok: true,
          value: verificationReceipt(
            "skill",
            "codex",
            "skipped",
            "target_runtime_unverifiable"
          ),
        };
      },
    };
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["codex-skill", "codex-skill"],
      connectorDeps,
      semantic: false,
      json: true,
    });

    expect(outcome.exitCode).toBe(0);
    expect(installs).toBe(1);
    expect(verifications).toBe(1);
    expect(outcome.result).toMatchObject({
      status: "completed_with_actions",
      connectors: [
        {
          connectorId: "codex-skill",
          installation: "installed",
          verification: "skipped",
          code: "target_runtime_unverifiable",
        },
      ],
    });
    assertValid(outcome.result, await loadSchema("setup-activation-result"));
  });

  test("reuses installed MCP config and delegates reruns to the shipped receipt cache", async () => {
    const { folder } = await harness("reuse");
    let installs = 0;
    let verifications = 0;
    const cachedReceipt = verificationReceipt("mcp", "cursor", "passed");
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
        installs += 1;
        throw new Error("must not overwrite");
      },
      verify: async () => {
        verifications += 1;
        return { ok: true, value: cachedReceipt };
      },
    };
    const options = {
      folder,
      connectorIds: ["cursor-mcp"],
      connectorDeps,
      semantic: false,
      json: true,
    };

    const first = await setupWithActivation(options);
    const second = await setupWithActivation(options);

    expect(installs).toBe(0);
    expect(verifications).toBe(2);
    expect(first.result).toMatchObject({
      status: "completed",
      connectors: [
        {
          installation: "reused",
          verification: "passed",
          receipt: { fingerprint: cachedReceipt.fingerprint },
        },
      ],
    });
    if (!("connectors" in first.result) || !("connectors" in second.result)) {
      throw new Error("Expected composed setup activation results");
    }
    expect(second.result.connectors).toEqual(first.result.connectors);
  });

  test("bounds install failures without relabeling lexical success", async () => {
    const { folder } = await harness("install-failure");
    const connectorDeps: SetupConnectorCompositionDeps = {
      getStates: async () => [
        {
          id: "cursor-mcp",
          kind: "mcp",
          target: "cursor",
          scope: "user",
          installed: false,
          configurationError: false,
        },
      ],
      install: async () => {
        throw new Error(
          "raw child output /Users/private/config.json TOKEN=secret"
        );
      },
      verify: async () => {
        throw new Error("must not verify");
      },
    };
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      connectorDeps,
      semantic: false,
      json: true,
    });
    const serialized = formatSetupOutputResult(outcome.result, { json: true });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({
      status: "completed_with_actions",
      setup: { status: "completed" },
      connectors: [
        {
          installation: "failed",
          verification: "not_run",
          code: "connector_install_failed",
          receipt: null,
        },
      ],
    });
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("TOKEN=secret");
  });

  test("bounds verifier transport failure with a nullable shipped receipt", async () => {
    const { folder } = await harness("verification-failure");
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
        throw new Error("must reuse");
      },
      verify: async () => ({
        ok: false,
        error: {
          code: "IO_ERROR",
          message: "raw child output TOKEN=secret",
        },
      }),
    };
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      connectorDeps,
      semantic: false,
      json: true,
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "completed_with_actions",
        connectors: [
          {
            installation: "reused",
            verification: "failed",
            code: "connector_verification_failed",
            receipt: null,
          },
        ],
      },
    });
    assertValid(outcome.result, await loadSchema("setup-activation-result"));
    expect(JSON.stringify(outcome.result)).not.toContain("TOKEN=secret");
  });

  test("lexical failure preserves the original result and performs no connector work", async () => {
    const { root } = await harness("lexical-failure");
    let connectorCalls = 0;
    const connectorDeps: SetupConnectorCompositionDeps = {
      getStates: async () => {
        connectorCalls += 1;
        return [];
      },
      install: async () => {
        connectorCalls += 1;
        throw new Error("unexpected");
      },
      verify: async () => {
        connectorCalls += 1;
        throw new Error("unexpected");
      },
    };
    const outcome = await setupWithActivation({
      folder: join(root, "missing"),
      connectorIds: ["cursor-mcp"],
      connectorDeps,
      semantic: false,
      json: true,
    });

    expect(outcome.exitCode).toBe(1);
    expect(connectorCalls).toBe(0);
    expect(outcome.result).toMatchObject({
      status: "failed",
      setup: {
        status: "failed",
        lexical: { error: { code: "folder_not_found" } },
      },
      connectors: [],
    });
    assertValid(outcome.result, await loadSchema("setup-activation-result"));
  });

  test("uses existing skill install and verification APIs end to end", async () => {
    const { root, folder } = await harness("real-skill");
    const homeDir = join(root, "home");
    await mkdir(homeDir, { recursive: true });
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["codex-skill"],
      connectorWorkspace: { cwd: root, homeDir },
      semantic: false,
      json: true,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({
      status: "completed_with_actions",
      connectors: [
        {
          connectorId: "codex-skill",
          installation: "installed",
          verification: "skipped",
          code: "target_runtime_unverifiable",
        },
      ],
    });
    expect(
      await Bun.file(
        join(homeDir, ".codex", "skills", "gno", "SKILL.md")
      ).exists()
    ).toBe(true);
  });
});
