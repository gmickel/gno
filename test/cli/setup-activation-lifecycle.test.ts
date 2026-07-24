import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories and fixture creation without Bun equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { SetupConnectorCompositionDeps } from "../../src/core/setup-activation";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { setupWithActivation } from "../../src/cli/commands/setup-activation";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];
const ORIGINAL_DIRS = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

async function harness(label: string): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), `gno-setup-activation-lifecycle-${label}-`)
  );
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
  return folder;
}

function connectorDeps(): SetupConnectorCompositionDeps {
  return {
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
}

function fakeStore(input: {
  open: () => Promise<unknown>;
  close: () => Promise<void>;
}): SqliteAdapter {
  return {
    setConfigPath: () => undefined,
    open: input.open,
    close: input.close,
  } as unknown as SqliteAdapter;
}

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = ORIGINAL_DIRS.config;
  process.env.GNO_DATA_DIR = ORIGINAL_DIRS.data;
  process.env.GNO_CACHE_DIR = ORIGINAL_DIRS.cache;
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("setup activation store lifecycle", () => {
  test("bounds a throwing store factory after proven lexical setup", async () => {
    const folder = await harness("factory");
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      semantic: false,
      createActivationStore: () => {
        throw new Error("raw factory TOKEN=secret");
      },
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "completed_with_actions",
        setup: { status: "completed" },
        connectors: [
          {
            verification: "not_run",
            code: "connector_verification_failed",
          },
        ],
      },
    });
    expect(JSON.stringify(outcome.result)).not.toContain("TOKEN=secret");
    assertValid(outcome.result, await loadSchema("setup-activation-result"));
  });

  test("bounds throwing open and best-effort close", async () => {
    const folder = await harness("open");
    let closeCalls = 0;
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      semantic: false,
      createActivationStore: () =>
        fakeStore({
          open: async () => {
            throw new Error("raw open TOKEN=secret");
          },
          close: async () => {
            closeCalls += 1;
            throw new Error("raw close TOKEN=secret");
          },
        }),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toMatchObject({
      status: "completed_with_actions",
      setup: { status: "completed" },
      connectors: [{ verification: "not_run" }],
    });
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(outcome.result)).not.toContain("TOKEN=secret");
  });

  test("does not let cleanup failure replace a connector result", async () => {
    const folder = await harness("close");
    let closeCalls = 0;
    const outcome = await setupWithActivation({
      folder,
      connectorIds: ["cursor-mcp"],
      connectorDeps: connectorDeps(),
      semantic: false,
      createActivationStore: () =>
        fakeStore({
          open: async () => ({ ok: true, value: undefined }),
          close: async () => {
            closeCalls += 1;
            throw new Error("raw close TOKEN=secret");
          },
        }),
    });

    expect(outcome).toMatchObject({
      exitCode: 0,
      result: {
        status: "completed_with_actions",
        connectors: [
          {
            verification: "failed",
            code: "connector_verification_failed",
          },
        ],
      },
    });
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(outcome.result)).not.toContain("TOKEN=secret");
  });
});
