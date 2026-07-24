/** Packed setup validation failures that must precede every side effect. */

// node:fs/promises creates an empty failure fixture; Bun has no directory API.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { PackedSetupSmokeOptions } from "./package-smoke-setup";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";

interface SetupFailureProjection {
  schemaVersion: "1.0";
  status: "failed";
  setup: {
    status: "failed";
    lexical: {
      receipt: unknown;
      error: { code: string } | null;
    };
    semantic: null;
  };
  connectors: unknown[];
}

function runFailure(
  options: PackedSetupSmokeOptions,
  command: string[]
): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
  };
}

function parseFailure(stdout: string, label: string): SetupFailureProjection {
  try {
    return JSON.parse(stdout) as SetupFailureProjection;
  } catch {
    throw new Error(`${label} did not return JSON:\n${stdout}`);
  }
}

export async function verifyPackedSetupFailures(
  options: PackedSetupSmokeOptions
): Promise<void> {
  const configPath = join(options.env.GNO_CONFIG_DIR ?? "", "index.yml");
  const invalid = runFailure(options, [
    options.gnoBin,
    "setup",
    options.fixtureDir,
    "--connector",
    "invalid-connector",
    "--no-semantic",
    "--json",
  ]);
  const invalidResult = parseFailure(invalid.stdout, "invalid packed setup");
  assertValid(invalidResult, await loadSchema("setup-activation-result"));
  if (
    invalid.exitCode !== 1 ||
    invalidResult.status !== "failed" ||
    invalidResult.setup.lexical.error?.code !== "invalid_connector" ||
    invalidResult.setup.semantic !== null ||
    invalidResult.connectors.length !== 0 ||
    (await Bun.file(configPath).exists())
  ) {
    throw new Error(
      `Invalid packed connector caused setup side effects:\n${invalid.stdout}`
    );
  }

  const emptyDir = join(options.cwd, "empty-setup");
  const skillPath = join(
    options.env.HOME ?? "",
    ".codex",
    "skills",
    "gno",
    "SKILL.md"
  );
  await mkdir(emptyDir, { recursive: true });
  const empty = runFailure(options, [
    options.gnoBin,
    "setup",
    emptyDir,
    "--name",
    "empty-package-smoke",
    "--connector",
    "codex-skill",
    "--no-semantic",
    "--json",
  ]);
  const emptyResult = parseFailure(empty.stdout, "empty packed setup");
  assertValid(emptyResult, await loadSchema("setup-activation-result"));
  if (
    empty.exitCode !== 1 ||
    emptyResult.status !== "failed" ||
    emptyResult.setup.lexical.error?.code !== "empty_folder" ||
    emptyResult.setup.semantic !== null ||
    emptyResult.connectors.length !== 0 ||
    (await Bun.file(skillPath).exists())
  ) {
    throw new Error(
      `Lexical failure ran a packed connector action:\n${empty.stdout}`
    );
  }
}
