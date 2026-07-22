import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { installMcpToTarget } from "../../src/cli/commands/mcp/install";
import {
  buildMcpServerEntry,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "../../src/cli/commands/mcp/paths";
import { checkMcpTargetStatus } from "../../src/cli/commands/mcp/status";
import { uninstallMcp } from "../../src/cli/commands/mcp/uninstall";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-config-validation");
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  await safeRm(TEST_DIR);
  await Promise.all([
    mkdir(HOME_DIR, { recursive: true }),
    mkdir(PROJECT_DIR, { recursive: true }),
  ]);
  process.env.XDG_CONFIG_HOME = join(TEST_DIR, "xdg");
});

afterEach(async () => {
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
  }
  await safeRm(TEST_DIR);
});

describe("MCP config structural validation", () => {
  test.each([
    ["claude-code", "user", "mcpServers"],
    ["zed", "user", "context_servers"],
    ["opencode", "user", "mcp"],
    ["amp", "user", "amp.mcpServers"],
  ] as Array<[McpTarget, McpScope, string]>)(
    "%s %s rejects duplicate JSONC server-map and gno keys everywhere",
    async (target, scope, serversKey) => {
      const { configPath } = resolveMcpConfigPath({
        target,
        scope,
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
      });
      await mkdir(join(configPath, ".."), { recursive: true });
      const fixtures = [
        `{
  // a later duplicate must never win
  "${serversKey}": { "gno": { "command": "/bin/first", "args": [] } },
  "${serversKey}": { "other": { "command": "/bin/other", "args": [] } },
}
`,
        `{
  "${serversKey}": {
    // neither duplicate gno entry is authoritative
    "gno": { "command": "/bin/first", "args": [] },
    "gno": { "command": "/bin/second", "args": [] },
  },
}
`,
      ];

      for (const content of fixtures) {
        await Bun.write(configPath, content);

        const status = await checkMcpTargetStatus(target, scope, {
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
        });
        expect(status.configured).toBe(false);
        expect(status.error).toContain("Ambiguous MCP JSONC config");

        for (const dryRun of [true, false]) {
          let installError: unknown;
          try {
            await installMcpToTarget(target, scope, buildMcpServerEntry(), {
              homeDir: HOME_DIR,
              cwd: PROJECT_DIR,
              dryRun,
              force: true,
            });
          } catch (caught) {
            installError = caught;
          }
          expect((installError as Error).message).toContain(
            "Ambiguous MCP JSONC config"
          );
          expect(await Bun.file(configPath).text()).toBe(content);
        }

        let uninstallError: unknown;
        try {
          await uninstallMcp({
            target,
            scope,
            homeDir: HOME_DIR,
            cwd: PROJECT_DIR,
            quiet: true,
          });
        } catch (caught) {
          uninstallError = caught;
        }
        expect((uninstallError as Error).message).toContain(
          "Ambiguous MCP JSONC config"
        );
        expect(await Bun.file(configPath).text()).toBe(content);
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "dangling config symlinks fail closed for dry-run and install",
    async () => {
      const { configPath } = resolveMcpConfigPath({
        target: "claude-code",
        scope: "user",
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
      });
      const missingTarget = join(TEST_DIR, "missing", "config.json");
      await symlink(missingTarget, configPath);
      for (const dryRun of [true, false]) {
        let error: unknown;
        try {
          await installMcpToTarget(
            "claude-code",
            "user",
            buildMcpServerEntry(),
            { homeDir: HOME_DIR, cwd: PROJECT_DIR, dryRun }
          );
        } catch (caught) {
          error = caught;
        }
        expect((error as Error).message).toContain("dangling symbolic link");
        expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
        expect(await Bun.file(missingTarget).exists()).toBe(false);
      }
    }
  );

  test.each([
    ["claude-code", "user", "[]"],
    ["claude-code", "user", "null"],
    ["claude-code", "user", '{"mcpServers":[]}'],
    ["librechat", "project", "[]\n"],
    ["librechat", "project", "mcpServers: []\n"],
    ["codex", "user", "mcp_servers = []\n"],
  ] as Array<[McpTarget, McpScope, string]>)(
    "%s %s rejects a valid but wrong root/server-map without writing",
    async (target, scope, content) => {
      const { configPath } = resolveMcpConfigPath({
        target,
        scope,
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
      });
      await mkdir(join(configPath, ".."), { recursive: true });
      await Bun.write(configPath, content);
      let error: unknown;
      try {
        await installMcpToTarget(target, scope, buildMcpServerEntry(), {
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
          force: true,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(await Bun.file(configPath).text()).toBe(content);
    }
  );

  test.each([
    ["claude-code", "user", '{"mcpServers":{"gno":null}}'],
    ["librechat", "project", "mcpServers:\n  gno: null\n"],
  ] as Array<[McpTarget, McpScope, string]>)(
    "%s own null gno entry requires force and remains unchanged",
    async (target, scope, content) => {
      const { configPath } = resolveMcpConfigPath({
        target,
        scope,
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
      });
      await mkdir(join(configPath, ".."), { recursive: true });
      await Bun.write(configPath, content);
      let error: unknown;
      try {
        await installMcpToTarget(target, scope, buildMcpServerEntry(), {
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
        });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toContain("already has gno");
      expect(await Bun.file(configPath).text()).toBe(content);
    }
  );

  test.each([
    { command: "relative/gno", args: ["mcp"] },
    { command: process.execPath, args: [] },
    { command: `${process.execPath}\nspoof`, args: ["mcp"] },
    { command: process.execPath, args: ["mcp\0spoof"] },
    { command: process.execPath, args: ["mcp"], env: { PATH: "/evil" } },
    {
      command: process.execPath,
      args: ["mcp"],
      env: { GNO_DATA_DIR: "relative/data" },
    },
  ] as Array<Record<string, unknown>>)(
    "invalid low-level server entries fail before every format and dry-run write",
    async (entry) => {
      for (const [target, scope] of [
        ["claude-code", "user"],
        ["zed", "user"],
        ["opencode", "user"],
        ["amp", "user"],
        ["librechat", "project"],
        ["codex", "user"],
      ] as Array<[McpTarget, McpScope]>) {
        const { configPath } = resolveMcpConfigPath({
          target,
          scope,
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
        });
        for (const dryRun of [false, true]) {
          let error: unknown;
          try {
            await installMcpToTarget(target, scope, entry as never, {
              homeDir: HOME_DIR,
              cwd: PROJECT_DIR,
              dryRun,
            });
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(Error);
          expect(await Bun.file(configPath).exists()).toBe(false);
        }
      }
    }
  );
});
