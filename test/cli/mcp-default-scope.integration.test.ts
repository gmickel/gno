import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { safeRm } from "../helpers/cleanup";

const createdRoots: string[] = [];
const cliEntrypoint = resolve(import.meta.dir, "../../src/index.ts");

async function runCli(
  cwd: string,
  env: Record<string, string>,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [globalThis.process.execPath, "run", cliEntrypoint, ...args],
    {
      cwd,
      env: { ...globalThis.process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("MCP target-aware CLI scope defaults", () => {
  test("bare LibreChat install and uninstall use project scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-mcp-default-scope-"));
    createdRoots.push(root);
    const canonicalRoot = await realpath(root);
    const env = {
      GNO_CONFIG_DIR: join(root, "config"),
      GNO_DATA_DIR: join(root, "data"),
      GNO_CACHE_DIR: join(root, "cache"),
      HOME: join(root, "home"),
    };

    const help = await runCli(root, env, ["mcp", "install", "--help"]);
    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(help.stdout).toContain("defaults to project for");
    expect(help.stdout).toContain("LibreChat and user otherwise");

    const installed = await runCli(root, env, [
      "mcp",
      "install",
      "--target",
      "librechat",
      "--json",
    ]);
    expect(installed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(installed.stdout)).toMatchObject({
      installed: {
        target: "librechat",
        scope: "project",
        configPath: join(canonicalRoot, "librechat.yaml"),
      },
    });
    expect(await Bun.file(join(root, "librechat.yaml")).exists()).toBe(true);

    const allScopes = await runCli(root, env, [
      "mcp",
      "status",
      "--target",
      "librechat",
      "--scope",
      "all",
      "--json",
    ]);
    expect(allScopes).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(allScopes.stdout)).toMatchObject({
      targets: [
        {
          target: "librechat",
          scope: "project",
          configured: true,
        },
      ],
      summary: { configured: 1, total: 1 },
    });

    const invalidScope = await runCli(root, env, [
      "mcp",
      "status",
      "--target",
      "librechat",
      "--scope",
      "user",
      "--json",
    ]);
    expect(invalidScope.exitCode).toBe(1);
    expect(`${invalidScope.stdout}\n${invalidScope.stderr}`).toContain(
      "LibreChat does not support user scope"
    );

    const uninstalled = await runCli(root, env, [
      "mcp",
      "uninstall",
      "--target",
      "librechat",
      "--json",
    ]);
    expect(uninstalled).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(uninstalled.stdout)).toMatchObject({
      uninstalled: {
        target: "librechat",
        scope: "project",
        configPath: join(canonicalRoot, "librechat.yaml"),
        action: "removed",
      },
    });
  });
});
