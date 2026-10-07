/**
 * Version-independent launch paths and `--force` repairs (fn-213).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdir/symlink and node:path join: filesystem structure
// helpers with no Bun equivalent.
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { installMcp } from "../../src/cli/commands/mcp/install";
import {
  stableLaunchPath,
  versionIndependentCandidates,
} from "../../src/cli/commands/mcp/launch-path";
import {
  buildMcpServerEntry,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "../../src/cli/commands/mcp/paths";
import { resetGlobals } from "../../src/cli/program";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-install-repair-tests");
const HOME = join(TEST_DIR, "home");
const CWD = join(TEST_DIR, "project");

describe("version-independent launch paths", () => {
  test.each([
    [
      "/home/u/.local/share/mise/installs/bun/1.3.14/bin/bun",
      "/home/u/.local/share/mise/installs/bun/latest/bin/bun",
    ],
    [
      "/home/u/.asdf/installs/bun/1.4.2/bin/bun",
      "/home/u/.asdf/installs/bun/latest/bin/bun",
    ],
    [
      "/home/u/.proto/tools/bun/1.4.2/bin/bun",
      "/home/u/.proto/tools/bun/latest/bin/bun",
    ],
    ["/opt/homebrew/Cellar/bun/1.4.2/bin/bun", "/opt/homebrew/opt/bun/bin/bun"],
    ["/usr/local/Cellar/bun/1.4.2/bin/bun", "/usr/local/opt/bun/bin/bun"],
    [
      String.raw`C:\Users\u\AppData\Local\mise\installs\bun\1.4.2\bin\bun.exe`,
      String.raw`C:\Users\u\AppData\Local\mise\installs\bun\latest\bin\bun.exe`,
    ],
    [
      "/home/u/.local/share/mise/installs/bun/1.4.2/install/global/node_modules/@gmickel/gno/src/index.ts",
      "/home/u/.local/share/mise/installs/bun/latest/install/global/node_modules/@gmickel/gno/src/index.ts",
    ],
  ])("%s -> %s", (path, candidate) => {
    expect(versionIndependentCandidates(path)).toEqual([candidate]);
  });

  test.each([
    "/home/u/.bun/bin/bun",
    "/home/u/.local/share/mise/installs/bun/latest/bin/bun",
    "/usr/bin/bun",
    "/home/u/.bun/install/global/node_modules/@gmickel/gno/src/index.ts",
  ])("%s is not versioned", (path) => {
    expect(versionIndependentCandidates(path)).toBeNull();
    expect(stableLaunchPath(path)).toEqual({ path, pinned: false });
  });

  describe("on disk", () => {
    beforeEach(async () => {
      await safeRm(TEST_DIR);
    });
    afterEach(async () => {
      await safeRm(TEST_DIR);
    });

    const bunAt = async (dir: string): Promise<string> => {
      await mkdir(join(dir, "bin"), { recursive: true });
      const path = join(dir, "bin", "bun");
      await Bun.write(path, "#!/bin/sh\n");
      return path;
    };

    test("mise: the latest link to the running Bun is written", async () => {
      const installs = join(TEST_DIR, "mise", "installs", "bun");
      const running = await bunAt(join(installs, "1.4.2"));
      await symlink("./1.4.2", join(installs, "latest"));
      expect(stableLaunchPath(running)).toEqual({
        path: join(installs, "latest", "bin", "bun"),
        pinned: false,
      });
    });

    test("a link that resolves to another version is not used", async () => {
      const installs = join(TEST_DIR, "mise", "installs", "bun");
      const running = await bunAt(join(installs, "1.3.14"));
      await bunAt(join(installs, "1.4.2"));
      await symlink("./1.4.2", join(installs, "latest"));
      expect(stableLaunchPath(running)).toEqual({
        path: running,
        pinned: true,
      });
    });

    test("asdf without a version-independent link stays pinned", async () => {
      const running = await bunAt(
        join(TEST_DIR, "asdf", "installs", "bun", "1.4.2")
      );
      expect(stableLaunchPath(running)).toEqual({
        path: running,
        pinned: true,
      });
    });

    test("Homebrew: the opt link is written", async () => {
      const prefix = join(TEST_DIR, "homebrew");
      const running = await bunAt(join(prefix, "Cellar", "bun", "1.4.2"));
      await mkdir(join(prefix, "opt"), { recursive: true });
      await symlink("../Cellar/bun/1.4.2", join(prefix, "opt", "bun"));
      expect(stableLaunchPath(running)).toEqual({
        path: join(prefix, "opt", "bun", "bin", "bun"),
        pinned: false,
      });
    });
  });
});

describe("gno mcp install --force keeps the existing registration", () => {
  let output: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const ORIGINAL_APPDATA = process.env.APPDATA;
  const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    process.env.APPDATA = join(TEST_DIR, "appdata");
    process.env.XDG_CONFIG_HOME = join(TEST_DIR, "xdg");
    output = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    resetGlobals();
    await safeRm(TEST_DIR);
    await mkdir(HOME, { recursive: true });
    await mkdir(CWD, { recursive: true });
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    for (const [key, value] of [
      ["APPDATA", ORIGINAL_APPDATA],
      ["XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await safeRm(TEST_DIR);
  });

  const OLD_BUN = "/home/u/.local/share/mise/installs/bun/1.3.14/bin/bun";
  const OLD_ENTRY = "/home/u/old/gno/src/index.ts";
  const OLD_ARGS = [
    "run",
    OLD_ENTRY,
    "--index",
    "work",
    "--config",
    "/home/u/work.yml",
    "mcp",
    "--tool-profile",
    "core",
    "--enable-write",
  ];
  const OLD_ENV = {
    GNO_DATA_DIR: "/home/u/gno-data",
    GNO_CACHE_DIR: "/home/u/gno-cache",
    EXTRA_VAR: "kept",
  };

  const seed: Record<
    "claude-code" | "opencode" | "librechat" | "codex",
    [McpScope, string]
  > = {
    "claude-code": [
      "user",
      `${JSON.stringify(
        {
          mcpServers: {
            gno: {
              type: "stdio",
              command: OLD_BUN,
              args: OLD_ARGS,
              env: OLD_ENV,
              timeout: 30_000,
            },
          },
        },
        null,
        2
      )}\n`,
    ],
    opencode: [
      "user",
      `${JSON.stringify(
        {
          mcp: {
            gno: {
              type: "local",
              command: [OLD_BUN, ...OLD_ARGS],
              enabled: false,
              environment: OLD_ENV,
              timeout: 30_000,
            },
          },
        },
        null,
        2
      )}\n`,
    ],
    librechat: [
      "project",
      `mcpServers:\n  gno: ${JSON.stringify({ command: OLD_BUN, args: OLD_ARGS, env: OLD_ENV, timeout: 30_000 })}\n`,
    ],
    codex: [
      "user",
      [
        "[mcp_servers.gno]",
        `command = ${JSON.stringify(OLD_BUN)}`,
        `args = [${OLD_ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`,
        "timeout = 30000",
        "",
        "[mcp_servers.gno.env]",
        ...Object.entries(OLD_ENV).map(
          ([key, value]) => `${key} = ${JSON.stringify(value)}`
        ),
        "",
      ].join("\n"),
    ],
  };

  const readEntry = async (target: McpTarget, scope: McpScope) => {
    const { configPath, configFormat } = resolveMcpConfigPath({
      target,
      scope,
      homeDir: HOME,
      cwd: CWD,
    });
    const text = await Bun.file(configPath).text();
    if (configFormat === "codex_toml") {
      return (Bun.TOML.parse(text) as { mcp_servers: { gno: unknown } })
        .mcp_servers.gno as Record<string, unknown>;
    }
    const root = (
      configFormat === "yaml_standard" ? Bun.YAML.parse(text) : JSON.parse(text)
    ) as Record<string, Record<string, Record<string, unknown>>>;
    const servers = root.mcpServers ?? root.mcp;
    return servers?.gno as Record<string, unknown>;
  };

  const launch = (target: McpTarget, entry: Record<string, unknown>) => {
    if (target === "opencode") {
      const [command, ...args] = entry.command as string[];
      return { command, args, env: entry.environment };
    }
    return { command: entry.command, args: entry.args, env: entry.env };
  };

  for (const target of Object.keys(seed) as Array<keyof typeof seed>) {
    test(`${target}: launch path repaired, settings and unknown keys kept`, async () => {
      const [scope, content] = seed[target];
      const { configPath } = resolveMcpConfigPath({
        target,
        scope,
        homeDir: HOME,
        cwd: CWD,
      });
      await mkdir(join(configPath, ".."), { recursive: true });
      await Bun.write(configPath, content);
      const fresh = buildMcpServerEntry();

      await installMcp({ target, scope, force: true, homeDir: HOME, cwd: CWD });

      const entry = await readEntry(target, scope);
      const written = launch(target, entry);
      expect(written.command).toBe(fresh.command);
      expect(written.args).toEqual([
        "run",
        fresh.args[1],
        ...OLD_ARGS.slice(2),
      ]);
      expect(written.env).toEqual(OLD_ENV);
      expect(entry.timeout).toBe(30_000);
      if (target === "opencode") expect(entry.enabled).toBe(false);
      if (target === "claude-code") expect(entry.type).toBe("stdio");
      expect(output.join("")).toContain("Kept the existing settings");

      // An explicit option still overrides its value; nothing else changes.
      await installMcp({
        target,
        scope,
        force: true,
        toolProfile: "full",
        indexName: "notes",
        homeDir: HOME,
        cwd: CWD,
      });
      const overridden = launch(target, await readEntry(target, scope));
      expect(overridden.args).toEqual([
        "run",
        fresh.args[1],
        "--index",
        "notes",
        "--config",
        "/home/u/work.yml",
        "mcp",
        "--tool-profile",
        "full",
        "--enable-write",
      ]);
      expect(overridden.env).toEqual(OLD_ENV);
    });
  }

  test("an entry that is not a GNO launch is replaced as before", async () => {
    const { configPath } = resolveMcpConfigPath({
      target: "claude-code",
      scope: "user",
      homeDir: HOME,
      cwd: CWD,
    });
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: { gno: { command: "/usr/bin/npx", args: ["something"] } },
      })
    );
    await installMcp({
      target: "claude-code",
      scope: "user",
      force: true,
      homeDir: HOME,
      cwd: CWD,
    });
    const entry = await readEntry("claude-code", "user");
    const fresh = buildMcpServerEntry();
    expect(entry.command).toBe(fresh.command);
    expect((entry.args as string[]).slice(0, 2)).toEqual(
      fresh.args.slice(0, 2)
    );
    expect(entry.args).toContain("mcp");
    expect(entry.args).not.toContain("something");
    expect(output.join("")).not.toContain("Kept the existing settings");
  });

  test("codex: a key TOML cannot express stops the repair before writing", async () => {
    const { configPath } = resolveMcpConfigPath({
      target: "codex",
      scope: "user",
      homeDir: HOME,
      cwd: CWD,
    });
    const content = [
      "[mcp_servers.gno]",
      `command = ${JSON.stringify(OLD_BUN)}`,
      `args = [${OLD_ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      'tools = { allow = ["gno_search"] }',
      "",
    ].join("\n");
    await mkdir(join(configPath, ".."), { recursive: true });
    await Bun.write(configPath, content);
    let error: unknown;
    try {
      await installMcp({
        target: "codex",
        scope: "user",
        force: true,
        homeDir: HOME,
        cwd: CWD,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('Cannot keep "tools"');
    expect(await Bun.file(configPath).text()).toBe(content);
  });

  test("without --force an existing entry is still refused", async () => {
    const [scope, content] = seed["claude-code"];
    const { configPath } = resolveMcpConfigPath({
      target: "claude-code",
      scope,
      homeDir: HOME,
      cwd: CWD,
    });
    await Bun.write(configPath, content);
    let error: unknown;
    try {
      await installMcp({
        target: "claude-code",
        scope,
        homeDir: HOME,
        cwd: CWD,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("already has gno");
    expect(await Bun.file(configPath).text()).toBe(content);
  });
});
