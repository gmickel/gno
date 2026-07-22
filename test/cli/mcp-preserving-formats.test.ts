import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installMcp } from "../../src/cli/commands/mcp/install";
import { checkMcpTargetStatus } from "../../src/cli/commands/mcp/status";
import { uninstallMcp } from "../../src/cli/commands/mcp/uninstall";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-preserving-formats");
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

describe("comment-preserving MCP config formats", () => {
  test("Zed JSONC comments and trailing commas survive install, update, and uninstall", async () => {
    const configPath = join(TEST_DIR, "xdg", "zed", "settings.json");
    await mkdir(join(TEST_DIR, "xdg", "zed"), { recursive: true });
    const original = `{
  // keep this Zed setting
  "theme": "Ayu Dark",
  "context_servers": {
    "other": { "command": "/bin/other", "args": ["serve"], },
  },
}
`;
    await Bun.write(configPath, original);
    for (const force of [false, true]) {
      await installMcp({
        target: "zed",
        scope: "user",
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
        force,
        quiet: true,
      });
      const content = await Bun.file(configPath).text();
      expect(content).toContain("// keep this Zed setting");
      expect(content).toContain('"theme": "Ayu Dark"');
      expect(content).toContain('"other"');
    }
    await uninstallMcp({
      target: "zed",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    const removed = await Bun.file(configPath).text();
    expect(removed).toContain("// keep this Zed setting");
    expect(removed).toContain('"other"');
    expect(removed).not.toContain('"gno"');
  });

  test.each(["opencode", "amp"] as const)(
    "%s discovers its sole JSONC file and rejects ambiguous dual files",
    async (target) => {
      const jsonPath =
        target === "opencode"
          ? join(HOME_DIR, ".config", "opencode", "opencode.json")
          : join(HOME_DIR, ".config", "amp", "settings.json");
      const jsoncPath = jsonPath.replace(/\.json$/u, ".jsonc");
      await mkdir(join(jsonPath, ".."), { recursive: true });
      const original = '{\n  // retained\n  "unrelated": true,\n}\n';
      await Bun.write(jsoncPath, original);
      await installMcp({
        target,
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
        quiet: true,
      });
      expect(await Bun.file(jsonPath).exists()).toBe(false);
      expect(await Bun.file(jsoncPath).text()).toContain("// retained");
      expect(
        await checkMcpTargetStatus(target, "user", {
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
        })
      ).toMatchObject({ configured: true, configPath: jsoncPath });

      const beforeAmbiguity = await Bun.file(jsoncPath).text();
      await Bun.write(jsonPath, '{"unrelated": "second"}\n');
      let error: unknown;
      try {
        await installMcp({
          target,
          homeDir: HOME_DIR,
          cwd: PROJECT_DIR,
          force: true,
          quiet: true,
        });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toContain("Ambiguous MCP config files");
      expect(await Bun.file(jsoncPath).text()).toBe(beforeAmbiguity);
      expect(await Bun.file(jsonPath).text()).toBe('{"unrelated": "second"}\n');
    }
  );

  test("LibreChat block YAML preserves exact CRLF layout through install, update, and uninstall", async () => {
    const configPath = join(PROJECT_DIR, "librechat.yaml");
    const original = [
      "# central LibreChat config",
      "shared: &shared",
      "    timeout: 30000 # keep inline comment",
      "mcpServers:",
      "    other: { command: /bin/other, args: [serve,  test], defaults: *shared } # keep flow spacing",
      "tail: { enabled: true,  mode: strict }",
      "",
    ].join("\r\n");
    await Bun.write(configPath, original);
    for (const force of [false, true]) {
      await installMcp({
        target: "librechat",
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
        force,
        quiet: true,
      });
      const content = await Bun.file(configPath).text();
      expect(content).toContain("# central LibreChat config");
      expect(content).toContain("&shared");
      expect(content).toContain("*shared");
      expect(content).toContain("# keep inline comment");
      expect(content).toContain(
        "    other: { command: /bin/other, args: [serve,  test], defaults: *shared } # keep flow spacing\r\n"
      );
      expect(content).toContain("tail: { enabled: true,  mode: strict }\r\n");
      expect(content.replaceAll("\r\n", "")).not.toContain("\n");
    }
    await uninstallMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  test("LibreChat flow YAML restores every original byte after uninstall", async () => {
    const configPath = join(PROJECT_DIR, "librechat.yaml");
    const original =
      "mcpServers: { other: { command: /bin/other, args: [serve,  test] } } # untouched\r\n" +
      "features: { alpha: true,  beta: false }\r\n";
    await Bun.write(configPath, original);

    await installMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    const installed = await Bun.file(configPath).text();
    expect(installed).toContain(
      "other: { command: /bin/other, args: [serve,  test] }"
    );
    expect(installed).toContain("# untouched\r\n");

    await installMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      force: true,
      quiet: true,
    });
    await uninstallMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  test("LibreChat absent server map restores the original document exactly", async () => {
    const configPath = join(PROJECT_DIR, "librechat.yaml");
    const original =
      "# header stays first\r\n# second header line\r\nsettings: { theme: dark,  density: compact }";
    await Bun.write(configPath, original);

    await installMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    const installed = await Bun.file(configPath).text();
    expect(installed.startsWith("# header stays first\r\n")).toBe(true);
    expect(installed).toContain("settings: { theme: dark,  density: compact }");
    await uninstallMcp({
      target: "librechat",
      homeDir: HOME_DIR,
      cwd: PROJECT_DIR,
      quiet: true,
    });
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  test("LibreChat ambiguous YAML fails closed without changing bytes", async () => {
    const configPath = join(PROJECT_DIR, "librechat.yaml");
    const original = `mcpServers:
  gno: { command: /bin/one, args: [] }
  gno: { command: /bin/two, args: [] }
`;
    await Bun.write(configPath, original);

    let error: unknown;
    try {
      await installMcp({
        target: "librechat",
        homeDir: HOME_DIR,
        cwd: PROJECT_DIR,
        force: true,
        quiet: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("Malformed YAML");
    expect(await Bun.file(configPath).text()).toBe(original);
  });
});
