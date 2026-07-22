import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DEFAULT_INDEX_NAME,
  ENV_CACHE_DIR,
  ENV_CONFIG_DIR,
  ENV_DATA_DIR,
} from "../../src/app/constants";
import { installMcp } from "../../src/cli/commands/mcp/install";
import {
  buildMcpServerEntry,
  MCP_SERVER_NAME,
} from "../../src/cli/commands/mcp/paths";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-install-globals");
const CLI_ENTRY = resolve(import.meta.dir, "../../src/index.ts");

async function runInstall(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      CLI_ENTRY,
      ...args,
      "mcp",
      "install",
      "--target",
      "claude-code",
      "--scope",
      "project",
      "--json",
    ],
    { cwd, env, stderr: "pipe", stdout: "pipe" }
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr };
}

async function installedArgs(cwd: string): Promise<string[]> {
  const clientConfig = await Bun.file(join(cwd, ".mcp.json")).json();
  return clientConfig.mcpServers[MCP_SERVER_NAME].args as string[];
}

async function installedEnvironment(
  cwd: string
): Promise<Record<string, string>> {
  const clientConfig = await Bun.file(join(cwd, ".mcp.json")).json();
  return clientConfig.mcpServers[MCP_SERVER_NAME].env as Record<string, string>;
}

beforeEach(async () => {
  await safeRm(TEST_DIR);
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await safeRm(TEST_DIR);
});

test("CLI persists global workspace identity with an absolute config path", async () => {
  const relativeConfigPath = "config/work.yml";
  const result = await runInstall(TEST_DIR, [
    "--index",
    "work",
    "--config",
    relativeConfigPath,
  ]);

  expect(result).toEqual({ exitCode: 0, stderr: "" });
  expect((await installedArgs(TEST_DIR)).slice(-5)).toEqual([
    "--index",
    "work",
    "--config",
    join(TEST_DIR, relativeConfigPath),
    "mcp",
  ]);
});

test("CLI pins the default index and environment-selected config", async () => {
  const envConfigDir = join(TEST_DIR, "env-config");
  const envDataDir = join(TEST_DIR, "env-data");
  const envCacheDir = join(TEST_DIR, "env-cache");
  const result = await runInstall(TEST_DIR, [], {
    ...process.env,
    [ENV_CONFIG_DIR]: envConfigDir,
    [ENV_DATA_DIR]: envDataDir,
    [ENV_CACHE_DIR]: envCacheDir,
  });

  expect(result).toEqual({ exitCode: 0, stderr: "" });
  expect((await installedArgs(TEST_DIR)).slice(-5)).toEqual([
    "--index",
    DEFAULT_INDEX_NAME,
    "--config",
    join(envConfigDir, "index.yml"),
    "mcp",
  ]);
  expect(await installedEnvironment(TEST_DIR)).toEqual({
    GNO_DATA_DIR: envDataDir,
    GNO_CACHE_DIR: envCacheDir,
  });
});

test("direct MCP installs reject unsafe or empty index names before writing", async () => {
  const clientConfigPath = join(TEST_DIR, ".mcp.json");

  for (const indexName of ["", "../escape"]) {
    expect(() => buildMcpServerEntry({ indexName })).toThrow(
      "Invalid index name"
    );
    let installError: unknown;
    try {
      await installMcp({
        target: "claude-code",
        scope: "project",
        indexName,
        cwd: TEST_DIR,
        homeDir: TEST_DIR,
        quiet: true,
      });
    } catch (error) {
      installError = error;
    }
    expect(installError).toBeInstanceOf(TypeError);
    expect((installError as Error).message).toContain("Invalid index name");
    expect(await Bun.file(clientConfigPath).exists()).toBe(false);
  }
});
