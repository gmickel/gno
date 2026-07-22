import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installMcpToTarget } from "../../src/cli/commands/mcp/install";
import {
  buildMcpServerEntry,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "../../src/cli/commands/mcp/paths";
import { checkMcpTargetStatus } from "../../src/cli/commands/mcp/status";
import { toMcpConnectorVerificationTarget } from "../../src/cli/commands/mcp/status";
import { isSafeLocalGnoMcpCommand } from "../../src/core/connector-verifier";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-workspace-environment");
const DATA_DIR = join(TEST_DIR, "workspace", "data");
const CACHE_DIR = join(TEST_DIR, "workspace", "cache");
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

interface TargetCase {
  target: McpTarget;
  scope: McpScope;
  environmentKey: "env" | "environment";
}

const TARGET_CASES: TargetCase[] = [
  { target: "claude-desktop", scope: "user", environmentKey: "env" },
  { target: "claude-code", scope: "user", environmentKey: "env" },
  { target: "cursor", scope: "user", environmentKey: "env" },
  { target: "zed", scope: "user", environmentKey: "env" },
  { target: "windsurf", scope: "user", environmentKey: "env" },
  { target: "opencode", scope: "user", environmentKey: "environment" },
  { target: "amp", scope: "user", environmentKey: "env" },
  { target: "lmstudio", scope: "user", environmentKey: "env" },
  { target: "librechat", scope: "project", environmentKey: "env" },
  { target: "codex", scope: "user", environmentKey: "env" },
];

beforeEach(async () => {
  await safeRm(TEST_DIR);
  await mkdir(TEST_DIR, { recursive: true });
  process.env.XDG_CONFIG_HOME = join(TEST_DIR, "xdg-config");
});

afterEach(async () => {
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = ORIGINAL_XDG_CONFIG_HOME;
  }
  await safeRm(TEST_DIR);
});

describe("MCP workspace environment projection", () => {
  for (const targetCase of TARGET_CASES) {
    test(`${targetCase.target} pins data and cache roots in its native format`, async () => {
      const homeDir = join(TEST_DIR, targetCase.target, "home");
      const cwd = join(TEST_DIR, targetCase.target, "project");
      await Promise.all([
        mkdir(homeDir, { recursive: true }),
        mkdir(cwd, { recursive: true }),
      ]);
      const entry = buildMcpServerEntry({
        indexName: "default",
        configPath: join(TEST_DIR, "gno", "index.yml"),
        dataDir: DATA_DIR,
        cacheDir: CACHE_DIR,
      });
      await installMcpToTarget(targetCase.target, targetCase.scope, entry, {
        homeDir,
        cwd,
      });

      const status = await checkMcpTargetStatus(
        targetCase.target,
        targetCase.scope,
        { homeDir, cwd }
      );
      expect(status).toMatchObject({
        configured: true,
        serverEntry: {
          env: {
            GNO_DATA_DIR: DATA_DIR,
            GNO_CACHE_DIR: CACHE_DIR,
          },
        },
      });
      const projected = toMcpConnectorVerificationTarget(
        targetCase.target,
        status
      );
      expect(projected.configured).toBe(true);
      expect(projected.serverEntry).toBeDefined();
      expect(
        projected.serverEntry &&
          (await isSafeLocalGnoMcpCommand(projected.serverEntry))
      ).toBe(true);

      const { configPath, configFormat } = resolveMcpConfigPath({
        target: targetCase.target,
        scope: targetCase.scope,
        homeDir,
        cwd,
      });
      const content = await Bun.file(configPath).text();
      const parsed =
        configFormat === "codex_toml"
          ? Bun.TOML.parse(content)
          : configFormat === "yaml_standard"
            ? Bun.YAML.parse(content)
            : JSON.parse(content);
      const server =
        configFormat === "context_servers"
          ? parsed.context_servers.gno
          : configFormat === "mcp"
            ? parsed.mcp.gno
            : configFormat === "amp_mcp"
              ? parsed["amp.mcpServers"].gno
              : configFormat === "codex_toml"
                ? parsed.mcp_servers.gno
                : parsed.mcpServers.gno;
      expect(server[targetCase.environmentKey]).toEqual({
        GNO_DATA_DIR: DATA_DIR,
        GNO_CACHE_DIR: CACHE_DIR,
      });
    });
  }

  test("status rejects extra, relative, and control-valued environment fields without writing", async () => {
    const cases: Array<{
      target: McpTarget;
      scope: McpScope;
      content: string;
    }> = [
      {
        target: "claude-code",
        scope: "user",
        content: JSON.stringify({
          mcpServers: {
            gno: { command: "gno", args: ["mcp"], env: { PATH: "/tmp" } },
          },
        }),
      },
      {
        target: "opencode",
        scope: "user",
        content: JSON.stringify({
          mcp: {
            gno: {
              type: "local",
              command: ["gno", "mcp"],
              enabled: true,
              environment: { GNO_DATA_DIR: "relative/data" },
            },
          },
        }),
      },
      {
        target: "codex",
        scope: "project",
        content:
          '[mcp_servers.gno]\ncommand = "gno"\nargs = ["mcp"]\n\n[mcp_servers.gno.env]\nGNO_CACHE_DIR = "/tmp/cache\\nspoof"\n',
      },
    ];

    for (const targetCase of cases) {
      const homeDir = join(TEST_DIR, "invalid", targetCase.target, "home");
      const cwd = join(TEST_DIR, "invalid", targetCase.target, "project");
      const { configPath } = resolveMcpConfigPath({
        target: targetCase.target,
        scope: targetCase.scope,
        homeDir,
        cwd,
      });
      await mkdir(join(configPath, ".."), { recursive: true });
      await Bun.write(configPath, targetCase.content);
      const status = await checkMcpTargetStatus(
        targetCase.target,
        targetCase.scope,
        { homeDir, cwd }
      );
      expect(status).toMatchObject({
        configured: false,
        error: "Malformed MCP server entry",
      });
      expect(await Bun.file(configPath).text()).toBe(targetCase.content);
    }
  });
});
