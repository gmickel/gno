/**
 * Bun used by MCP registrations and running residents (fn-213 R5, R8).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises chmod/mkdir and node:path join: filesystem structure
// helpers with no Bun equivalent.
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { VERSION } from "../../src/app/constants";
import {
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "../../src/cli/commands/mcp/paths";
import { writePidFile } from "../../src/cli/detach";
import {
  checkRegistrationRuntimes,
  checkResidentRuntimes,
} from "../../src/cli/runtime-health";
import { getCurrentGnoEntrypoint } from "../../src/core/runtime-entrypoint";
import { safeRm } from "../helpers/cleanup";

const TEST_DIR = join(import.meta.dir, ".temp-runtime-health-tests");
const HOME = join(TEST_DIR, "home");
const CWD = join(TEST_DIR, "project");
const ENTRY = getCurrentGnoEntrypoint();
const ORIGINAL = {
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  GNO_DATA_DIR: process.env.GNO_DATA_DIR,
};

beforeEach(async () => {
  process.env.APPDATA = join(TEST_DIR, "appdata");
  process.env.XDG_CONFIG_HOME = join(TEST_DIR, "xdg");
  process.env.GNO_DATA_DIR = join(TEST_DIR, "data");
  await safeRm(TEST_DIR);
  await mkdir(HOME, { recursive: true });
  await mkdir(CWD, { recursive: true });
});

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await safeRm(TEST_DIR);
});

/** A stand-in interpreter that prints `version` for `--version`. */
const fakeBun = async (dir: string, script: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "bun");
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
};

const register = async (
  target: McpTarget,
  scope: McpScope,
  command: string,
  entrypoint = ENTRY
): Promise<void> => {
  const { configPath, configFormat } = resolveMcpConfigPath({
    target,
    scope,
    homeDir: HOME,
    cwd: CWD,
  });
  const args = ["run", entrypoint, "mcp"];
  await mkdir(join(configPath, ".."), { recursive: true });
  if (configFormat === "codex_toml") {
    await Bun.write(
      configPath,
      `[mcp_servers.gno]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`
    );
  } else if (configFormat === "yaml_standard") {
    await Bun.write(
      configPath,
      `mcpServers:\n  gno: ${JSON.stringify({ command, args })}\n`
    );
  } else if (configFormat === "mcp") {
    await Bun.write(
      configPath,
      JSON.stringify({
        mcp: { gno: { type: "local", command: [command, ...args] } },
      })
    );
  } else {
    await Bun.write(
      configPath,
      JSON.stringify({ mcpServers: { gno: { command, args } } })
    );
  }
};

const check = () => checkRegistrationRuntimes({ homeDir: HOME, cwd: CWD });

describe("registrations", () => {
  test("a registration on this Bun is healthy", async () => {
    await register("claude-code", "user", process.execPath);
    expect(await check()).toEqual([]);
  });

  test("a missing interpreter or entrypoint is an error, in every format", async () => {
    await register("claude-code", "user", join(TEST_DIR, "gone", "bun"));
    await register(
      "codex",
      "user",
      process.execPath,
      join(TEST_DIR, "gone.ts")
    );
    await register("librechat", "project", join(TEST_DIR, "gone", "bun"));
    await register("opencode", "user", join(TEST_DIR, "gone", "bun"));
    const issues = await check();
    expect(
      issues.map((issue) => [issue.severity, issue.subject.split(" ")[0]])
    ).toEqual([
      ["error", "Claude"],
      ["error", "Codex"],
      ["error", "OpenCode"],
      ["error", "LibreChat"],
    ]);
    for (const issue of issues) {
      expect(issue.message).toContain("no longer exists");
      expect(issue.repair).toMatch(
        /^gno mcp install --target \S+ --scope \S+ --force$/
      );
    }
  });

  test("a versioned install path below the floor is an error without running it", async () => {
    const old = await fakeBun(
      join(TEST_DIR, "mise", "installs", "bun", "1.3.11", "bin"),
      "exit 1"
    );
    await register("claude-code", "user", old);
    const [issue] = await check();
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("Bun 1.3.11");
    expect(issue?.message).toContain("supported minimum 1.4.1");
  });

  test.skipIf(process.platform === "win32")(
    "--version is asked when the path names no version; an old answer is an error, a newer one information",
    async () => {
      await register(
        "claude-code",
        "user",
        await fakeBun(join(TEST_DIR, "old"), 'echo "1.3.14"')
      );
      await register(
        "cursor",
        "user",
        await fakeBun(join(TEST_DIR, "other"), 'echo "1.9.0"')
      );
      const issues = await check();
      expect(
        issues.map(({ severity, message }) => [
          severity,
          message.split(" (")[0],
        ])
      ).toEqual([
        ["error", "runs Bun 1.3.14"],
        ["info", "runs Bun 1.9.0"],
      ]);
    }
  );

  test.skipIf(process.platform === "win32")(
    "an interpreter that hangs on --version is reported as unknown within the timeout",
    async () => {
      await register(
        "claude-code",
        "user",
        await fakeBun(join(TEST_DIR, "hang"), "exec sleep 30")
      );
      const started = performance.now();
      const [issue] = await check();
      expect(performance.now() - started).toBeLessThan(5000);
      expect(issue?.severity).toBe("info");
      expect(issue?.message).toContain("unknown version");
    },
    10_000
  );
});

describe("residents", () => {
  let sleeper: ReturnType<typeof Bun.spawn> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    sleeper?.kill(9);
    sleeper = null;
    void server?.stop(true);
    server = null;
  });

  const liveResident = async (
    payload: { version: string; bun_version?: string },
    statusBody: unknown
  ): Promise<number> => {
    sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
    server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/api/status"
          ? Response.json(statusBody)
          : new Response("not found", { status: 404 }),
    });
    await writePidFile(join(TEST_DIR, "data", "serve.pid"), {
      pid: sleeper.pid,
      cmd: "serve",
      started_at: new Date().toISOString(),
      port: server.port ?? null,
      ...payload,
    });
    return sleeper.pid;
  };

  const gnoStatus = (bun: string) => ({
    indexName: "default",
    bootstrap: { runtime: { kind: "bun", currentVersion: bun } },
  });

  test.skipIf(process.platform === "win32")(
    "a resident from another GNO version is read over HTTP and never signalled",
    async () => {
      const pid = await liveResident({ version: "2.9.0" }, gnoStatus("1.3.11"));
      const [issue] = await checkResidentRuntimes();
      expect(issue?.severity).toBe("error");
      expect(issue?.subject).toBe(`gno serve (pid ${pid}, GNO 2.9.0)`);
      expect(issue?.message).toContain("runs Bun 1.3.11");
      expect(issue?.repair).toContain(`kill ${pid}`);
      expect(issue?.repair).toContain("gno serve --stop leaves it alone");
      expect(sleeper?.exitCode).toBeNull();
    }
  );

  test.skipIf(process.platform === "win32")(
    "a port that does not answer as GNO leaves the runtime unknown",
    async () => {
      await liveResident({ version: "2.9.0" }, { hello: "world" });
      const [issue] = await checkResidentRuntimes();
      expect(issue?.severity).toBe("info");
      expect(issue?.message).toContain("Bun version is unknown");
    }
  );

  test.skipIf(process.platform === "win32")(
    "a current resident's recorded Bun is used; older than this Bun is a warning",
    async () => {
      await liveResident(
        { version: VERSION, bun_version: "1.4.1" },
        gnoStatus("9.9.9")
      );
      const issues = await checkResidentRuntimes();
      if (Bun.semver.order("1.4.1", Bun.version) < 0) {
        expect(issues).toHaveLength(1);
        expect(issues[0]?.severity).toBe("warn");
        expect(issues[0]?.message).toContain("runs Bun 1.4.1");
        expect(issues[0]?.repair).toContain("gno serve --stop");
      } else {
        expect(issues).toEqual([]);
      }
    }
  );

  test("a dead pid is not reported", async () => {
    await writePidFile(join(TEST_DIR, "data", "serve.pid"), {
      pid: 2_147_483_000,
      cmd: "serve",
      version: "2.9.0",
      started_at: new Date().toISOString(),
      port: null,
    });
    expect(await checkResidentRuntimes()).toEqual([]);
  });
});
