import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories and fixture creation without Bun equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import { ENV_SKILLS_HOME_OVERRIDE } from "../../src/cli/commands/skill/paths";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];
const ORIGINAL_DIRS = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
  skillsHome: process.env[ENV_SKILLS_HOME_OVERRIDE],
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function harness(label: string) {
  const root = await mkdtemp(
    join(tmpdir(), `gno-setup-activation-command-${label}-`)
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
  return { root, folder };
}

afterEach(async () => {
  process.env.GNO_CONFIG_DIR = ORIGINAL_DIRS.config;
  process.env.GNO_DATA_DIR = ORIGINAL_DIRS.data;
  process.env.GNO_CACHE_DIR = ORIGINAL_DIRS.cache;
  if (ORIGINAL_DIRS.skillsHome === undefined) {
    delete process.env[ENV_SKILLS_HOME_OVERRIDE];
  } else {
    process.env[ENV_SKILLS_HOME_OVERRIDE] = ORIGINAL_DIRS.skillsHome;
  }
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("setup activation Commander surface", () => {
  test("accepts repeatable connectors and emits one outer JSON object", async () => {
    const { root, folder } = await harness("success");
    process.env[ENV_SKILLS_HOME_OVERRIDE] = join(root, "home");
    const result = await cli(
      "setup",
      folder,
      "--connector",
      "codex-skill",
      "--connector",
      "codex-skill",
      "--no-semantic",
      "--json"
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: "1.0",
      status: "completed_with_actions",
      connectors: [
        {
          connectorId: "codex-skill",
          installation: "installed",
          verification: "skipped",
        },
      ],
    });
    expect(
      result.stdout
        .trim()
        .split("\n")
        .filter((line) => line === "{")
    ).toHaveLength(1);
  });

  test("wraps unknown connector failure before setup side effects", async () => {
    const { folder } = await harness("unknown");
    const result = await cli(
      "setup",
      folder,
      "--connector",
      "unknown",
      "--no-semantic",
      "--json"
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: "1.0",
      status: "failed",
      setup: {
        status: "failed",
        lexical: { error: { code: "invalid_connector" } },
      },
      connectors: [],
    });
    assertValid(parsed, await loadSchema("setup-activation-result"));
    expect(
      await Bun.file(join(process.env.GNO_CONFIG_DIR!, "index.yml")).exists()
    ).toBe(false);
  });
});
