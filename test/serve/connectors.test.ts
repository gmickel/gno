import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getConnectorStatuses,
  installConnector,
} from "../../src/serve/connectors";

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
});
