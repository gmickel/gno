import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENV_CODEX_SKILLS_DIR } from "../../src/cli/commands/skill/paths";
import {
  getConnectorStatuses,
  getConnectorVerificationTargets,
  installConnector,
  verifyInstalledConnector,
} from "../../src/serve/connectors";
import { SqliteAdapter } from "../../src/store";

async function createTempWorkspace(): Promise<{
  homeDir: string;
  cwd: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "gno-connectors-"));
  return {
    homeDir: join(base, "home"),
    cwd: join(base, "project"),
  };
}

describe("connector service", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) {
        await rm(path, { force: true, recursive: true });
      }
    }
  });

  test("reports missing connectors before install", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));

    const statuses = await getConnectorStatuses(workspace);

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status.installed === false)).toBe(true);
  });

  test("bounds invalid skill path overrides in passive target projection", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));
    const originalOverride = process.env[ENV_CODEX_SKILLS_DIR];
    process.env[ENV_CODEX_SKILLS_DIR] = "relative/codex/skills";

    try {
      const statuses = await getConnectorStatuses(workspace);
      const targets = await getConnectorVerificationTargets(workspace);
      const expectedIds = [
        "claude-code-skill",
        "claude-desktop-mcp",
        "cursor-mcp",
        "codex-skill",
        "opencode-skill",
        "openclaw-skill",
        "hermes-skill",
      ];

      expect(statuses).toHaveLength(7);
      expect(statuses.map(({ id }) => id)).toEqual(expectedIds);
      expect(statuses.find(({ id }) => id === "codex-skill")).toMatchObject({
        installed: false,
        path: "unresolved-skill-path/codex",
        summary: "Codex skill path is unavailable.",
        nextAction: "Fix the skill path configuration, then reload status.",
        error: "Skill path configuration is invalid or unavailable.",
      });
      expect(targets).toHaveLength(7);
      expect(targets.map(({ id }) => id)).toEqual(expectedIds);
      expect(targets.find(({ id }) => id === "codex-skill")).toEqual({
        kind: "skill",
        id: "codex-skill",
        target: "codex",
        scope: "user",
        configPath: "unresolved-skill-path/codex",
        installed: false,
        configError: true,
      });
    } finally {
      if (originalOverride === undefined) {
        delete process.env[ENV_CODEX_SKILLS_DIR];
      } else {
        process.env[ENV_CODEX_SKILLS_DIR] = originalOverride;
      }
    }
  });

  test("returns a structured verification failure for an invalid skill path", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));
    const originalOverride = process.env[ENV_CODEX_SKILLS_DIR];

    const adapter = new SqliteAdapter();
    expect(
      (
        await adapter.open(
          join(workspace.homeDir, "..", "index.sqlite"),
          "unicode61"
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: "notes",
            path: workspace.cwd,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    process.env[ENV_CODEX_SKILLS_DIR] = "relative/codex/skills";

    try {
      const result = await verifyInstalledConnector(
        "codex-skill",
        adapter,
        "notes",
        { force: true },
        workspace
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stages.connector).toMatchObject({
          status: "failed",
          code: "connector_unsupported_config",
        });
      }
    } finally {
      await adapter.close();
      if (originalOverride === undefined) {
        delete process.env[ENV_CODEX_SKILLS_DIR];
      } else {
        process.env[ENV_CODEX_SKILLS_DIR] = originalOverride;
      }
    }
  });

  test("installs skill connector using existing installer logic", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));

    const status = await installConnector(
      "claude-code-skill",
      { reinstall: false },
      workspace
    );

    expect(status.installed).toBe(true);
    expect(await Bun.file(join(status.path, "SKILL.md")).exists()).toBe(true);
  });

  test("installs MCP connector using existing installer logic", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));

    const status = await installConnector(
      "claude-desktop-mcp",
      { reinstall: false },
      workspace
    );

    expect(status.installed).toBe(true);
    expect(await Bun.file(status.path).exists()).toBe(true);
    const content = await Bun.file(status.path).text();
    expect(content).toContain('"gno"');
  });

  test("preserves the active serve index and config in installed MCP argv", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));
    const configPath = join(workspace.cwd, "custom-config.yml");

    const status = await installConnector(
      "claude-desktop-mcp",
      { reinstall: false },
      {
        ...workspace,
        indexName: "client-work",
        configPath,
      }
    );

    const config = JSON.parse(await Bun.file(status.path).text()) as {
      mcpServers: { gno: { args: string[] } };
    };
    const args = config.mcpServers.gno.args;
    expect(args.slice(-5)).toEqual([
      "--index",
      "client-work",
      "--config",
      configPath,
      "mcp",
    ]);
    expect(args.indexOf("--index")).toBeLessThan(args.indexOf("mcp"));
    expect(args.indexOf("--config")).toBeLessThan(args.indexOf("mcp"));
    expect(args).not.toContain("--enable-write");
  });

  test("refuses to overwrite installed connector without explicit reinstall", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));

    await installConnector(
      "claude-code-skill",
      { reinstall: false },
      workspace
    );

    let message = "";
    try {
      await installConnector(
        "claude-code-skill",
        { reinstall: false },
        workspace
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("already installed");
  });

  test("reports installed skill execution as explicitly unverifiable", async () => {
    const workspace = await createTempWorkspace();
    cleanupPaths.push(join(workspace.homeDir, ".."));
    await installConnector("codex-skill", { reinstall: false }, workspace);

    const adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(workspace.homeDir, "index.sqlite"), "unicode61"))
        .ok
    ).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: "notes",
            path: workspace.cwd,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    try {
      const result = await verifyInstalledConnector(
        "codex-skill",
        adapter,
        "notes",
        { force: true },
        workspace
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stages.connector).toMatchObject({
          status: "skipped",
          code: "target_runtime_unverifiable",
        });
      }
    } finally {
      await adapter.close();
    }
  });
});
