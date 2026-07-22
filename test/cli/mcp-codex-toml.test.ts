import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installMcp } from "../../src/cli/commands/mcp/install";
import { checkMcpTargetStatus } from "../../src/cli/commands/mcp/status";
import { uninstallMcp } from "../../src/cli/commands/mcp/uninstall";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-codex-toml");
const HOME_DIR = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");
const USER_CONFIG = join(HOME_DIR, ".codex", "config.toml");

beforeEach(async () => {
  await safeRm(TEST_DIR);
  await Promise.all([
    mkdir(join(HOME_DIR, ".codex"), { recursive: true }),
    mkdir(PROJECT_DIR, { recursive: true }),
  ]);
});

afterEach(async () => {
  await safeRm(TEST_DIR);
});

describe("Codex native TOML MCP config", () => {
  test("ignores table-looking text inside TOML multiline strings and preserves CRLF", async () => {
    const content = [
      '# comment with a harmless triple token """',
      'single = "quoted \\\"\\\"\\\" text"',
      'one_line_basic = """[mcp_servers.gno]"""',
      "one_line_literal = '''[mcp_servers.gno.env]'''",
      'basic = """',
      "[mcp_servers.gno]",
      'command = "not-a-table"',
      '"""',
      "literal = '''",
      "[mcp_servers.gno.env]",
      "GNO_DATA_DIR = '/not/a/table'",
      "'''",
      "[features]",
      "web_search = true",
      "",
    ].join("\r\n");
    await Bun.write(USER_CONFIG, content);

    await installMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    let updated = await Bun.file(USER_CONFIG).text();
    expect(() => Bun.TOML.parse(updated)).not.toThrow();
    expect(updated).toContain("[mcp_servers.gno]\r\n");
    expect(updated.replace(/\r\n/gu, "")).not.toContain("\n");
    expect((Bun.TOML.parse(updated) as { basic: string }).basic).toContain(
      "[mcp_servers.gno]"
    );

    await installMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      force: true,
      quiet: true,
    });
    updated = await Bun.file(USER_CONFIG).text();
    expect(() => Bun.TOML.parse(updated)).not.toThrow();
    await uninstallMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    const removed = await Bun.file(USER_CONFIG).text();
    expect(() => Bun.TOML.parse(removed)).not.toThrow();
    expect((Bun.TOML.parse(removed) as { literal: string }).literal).toContain(
      "[mcp_servers.gno.env]"
    );
    expect(removed.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  test("install, update, status, and uninstall preserve unrelated TOML and comments", async () => {
    const unrelated = [
      "# user-selected model",
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "# keep this comment exactly",
      "web_search = true",
      "",
      "[mcp_servers.other]",
      'command = "/usr/bin/other"',
      'args = ["serve"]',
      "",
    ].join("\n");
    await Bun.write(USER_CONFIG, unrelated);

    await installMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      indexName: "research",
      configPath: join(PROJECT_DIR, "gno.yml"),
      quiet: true,
    });
    const installed = await Bun.file(USER_CONFIG).text();
    expect(installed).toStartWith(unrelated.trimEnd());
    expect(installed).toContain("[mcp_servers.gno]");
    expect(installed).toContain("[mcp_servers.gno.env]");
    expect(Bun.TOML.parse(installed)).toMatchObject({
      model: "gpt-5.6-sol",
      features: { web_search: true },
      mcp_servers: {
        other: { command: "/usr/bin/other", args: ["serve"] },
        gno: {
          command: process.execPath,
          args: expect.arrayContaining(["--index", "research", "mcp"]),
        },
      },
    });
    expect(
      await checkMcpTargetStatus("codex", "user", {
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
      })
    ).toMatchObject({ configured: true });

    await installMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      indexName: "updated",
      configPath: join(PROJECT_DIR, "updated.yml"),
      force: true,
      quiet: true,
    });
    const updated = await Bun.file(USER_CONFIG).text();
    expect(updated.match(/\[mcp_servers\.gno]/g)).toHaveLength(1);
    expect(updated).toContain('"updated"');
    expect(updated).toContain("# keep this comment exactly");

    await uninstallMcp({
      target: "codex",
      scope: "user",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    const removed = await Bun.file(USER_CONFIG).text();
    expect(removed).toBe(unrelated);
  });

  test("project scope uses .codex/config.toml", async () => {
    await installMcp({
      target: "codex",
      scope: "project",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    expect(
      await Bun.file(join(PROJECT_DIR, ".codex", "config.toml")).exists()
    ).toBe(true);
  });

  test("malformed and unsupported inline TOML fail without writing", async () => {
    for (const content of [
      "[mcp_servers.gno\ncommand = 'broken'\n",
      'mcp_servers.gno = { command = "gno", args = ["mcp"] }\n',
      '[mcp_servers.gno]\ncommand = "gno"\nargs = ["mcp"]\n\n[mcp_servers.gno.headers]\nAuthorization = "secret"\n',
    ]) {
      await Bun.write(USER_CONFIG, content);
      for (const dryRun of [true, false]) {
        let installError: unknown;
        try {
          await installMcp({
            target: "codex",
            scope: "user",
            homeDir: HOME_DIR,
            cwd: PROJECT_DIR,
            force: true,
            dryRun,
            quiet: true,
          });
        } catch (error) {
          installError = error;
        }
        expect(installError).toBeInstanceOf(Error);
        expect(await Bun.file(USER_CONFIG).text()).toBe(content);
      }
    }
  });
});
