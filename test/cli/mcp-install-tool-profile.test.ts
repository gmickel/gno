import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir and node:path for join: filesystem structure
// helpers with no Bun equivalent (see AGENTS.md "Acceptable node:*").
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installMcp } from "../../src/cli/commands/mcp/install";
import {
  buildMcpServerEntry,
  MCP_SERVER_NAME,
  MCP_TARGETS,
  readMcpToolProfileFromArgs,
} from "../../src/cli/commands/mcp/paths";
import { checkMcpTargetStatus } from "../../src/cli/commands/mcp/status";
import { CliError } from "../../src/cli/errors";
import { resetGlobals } from "../../src/cli/program";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-mcp-tool-profile-tests");
const FAKE_HOME = join(TEST_DIR, "home");
const FAKE_CWD = join(TEST_DIR, "project");

let stdoutOutput: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
const mockWrite = (chunk: string | Uint8Array): boolean => {
  stdoutOutput.push(String(chunk));
  return true;
};

const profileArgs = (args: ReadonlyArray<string>) => {
  const mcpIndex = args.indexOf("mcp");
  return args.slice(mcpIndex + 1);
};

describe("gno mcp install --tool-profile", () => {
  beforeEach(async () => {
    process.stdout.write = mockWrite as typeof process.stdout.write;
    stdoutOutput = [];
    resetGlobals();
    await safeRm(TEST_DIR);
    await mkdir(FAKE_HOME, { recursive: true });
    await mkdir(FAKE_CWD, { recursive: true });
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await safeRm(TEST_DIR);
  });

  test("entry builder appends the profile after mcp, before --enable-write", () => {
    const readOnly = buildMcpServerEntry({ toolProfile: "core" });
    expect(profileArgs(readOnly.args)).toEqual(["--tool-profile", "core"]);

    const withWrite = buildMcpServerEntry({
      toolProfile: "core",
      enableWrite: true,
    });
    expect(profileArgs(withWrite.args)).toEqual([
      "--tool-profile",
      "core",
      "--enable-write",
    ]);

    const explicitFull = buildMcpServerEntry({ toolProfile: "full" });
    expect(profileArgs(explicitFull.args)).toEqual(["--tool-profile", "full"]);
  });

  test("omitting the profile keeps the registration byte-identical", () => {
    const entry = buildMcpServerEntry({ enableWrite: true });
    expect(profileArgs(entry.args)).toEqual(["--enable-write"]);
    expect(entry.args).not.toContain("--tool-profile");
  });

  test("reads the profile back from args, defaulting to full", () => {
    expect(readMcpToolProfileFromArgs(["mcp"])).toBe("full");
    expect(readMcpToolProfileFromArgs(["mcp", "--tool-profile", "core"])).toBe(
      "core"
    );
    expect(readMcpToolProfileFromArgs(["mcp", "--tool-profile", "bogus"])).toBe(
      "full"
    );
  });

  test("dry-run JSON carries the profile for every target", async () => {
    for (const target of MCP_TARGETS) {
      stdoutOutput = [];
      await installMcp({
        target,
        toolProfile: "core",
        enableWrite: true,
        dryRun: true,
        json: true,
        homeDir: FAKE_HOME,
        cwd: FAKE_CWD,
      });
      const output = stdoutOutput.join("");
      expect(output).toContain('"--tool-profile"');
      expect(output).toContain('"core"');
      expect(output).toContain('"--enable-write"');
    }
  });

  test("installed registration carries the profile and status reads it back", async () => {
    await installMcp({
      target: "claude-code",
      scope: "user",
      toolProfile: "core",
      homeDir: FAKE_HOME,
      cwd: FAKE_CWD,
    });

    const configPath = join(FAKE_HOME, ".claude.json");
    const config = await Bun.file(configPath).json();
    const args: string[] = config.mcpServers[MCP_SERVER_NAME].args;
    expect(profileArgs(args)).toEqual(["--tool-profile", "core"]);

    const status = await checkMcpTargetStatus("claude-code", "user", {
      homeDir: FAKE_HOME,
      cwd: FAKE_CWD,
    });
    expect(status.configured).toBe(true);
    expect(status.toolProfile).toBe("core");
  });

  test("a registration without the flag reports the full profile", async () => {
    await installMcp({
      target: "claude-code",
      scope: "user",
      homeDir: FAKE_HOME,
      cwd: FAKE_CWD,
    });
    const status = await checkMcpTargetStatus("claude-code", "user", {
      homeDir: FAKE_HOME,
      cwd: FAKE_CWD,
    });
    expect(status.toolProfile).toBe("full");
  });

  test("--force rewrites an existing registration to the new profile", async () => {
    const opts = {
      target: "claude-code" as const,
      scope: "user" as const,
      homeDir: FAKE_HOME,
      cwd: FAKE_CWD,
    };
    await installMcp(opts);
    await installMcp({ ...opts, toolProfile: "core", force: true });
    const status = await checkMcpTargetStatus("claude-code", "user", opts);
    expect(status.toolProfile).toBe("core");
  });

  test("an invalid profile fails validation before any file is written", async () => {
    const configPath = join(FAKE_HOME, ".claude.json");
    for (const dryRun of [true, false]) {
      let thrown: unknown;
      try {
        await installMcp({
          target: "claude-code",
          scope: "user",
          toolProfile: "fast" as never,
          dryRun,
          homeDir: FAKE_HOME,
          cwd: FAKE_CWD,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe("VALIDATION");
      expect(await Bun.file(configPath).exists()).toBe(false);
    }
  });
});
