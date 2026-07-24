import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides test-only temporary directories and symlinks.
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// node:url creates a portable module URL for the child-process probe.
import { pathToFileURL } from "node:url";

import { snapshotInstalledConnectorBytes } from "../../scripts/package-smoke-connector-snapshot";
import {
  assertInstalledSetupIsolation,
  assertPackageSmokeEnvironment,
  assertPackageSmokePathContained,
  buildInstalledSetupChildEnv,
  buildPackageSmokeProcessEnv,
  packageSmokeConnectorPaths,
  type InstalledSetupIsolationOptions,
} from "../../scripts/package-smoke-isolation";
import { safeRm } from "../helpers/cleanup";

const roots: string[] = [];

async function expectRejection(
  operation: () => Promise<unknown>,
  message: string
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

async function fixture(): Promise<InstalledSetupIsolationOptions> {
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-smoke-isolation-"));
  roots.push(tempRoot);
  const home = join(tempRoot, "home");
  const config = join(tempRoot, "config");
  const data = join(tempRoot, "data");
  const cache = join(tempRoot, "cache");
  const fixtureDir = join(tempRoot, "fixture");
  const npmPrefix = join(tempRoot, "prefix");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(cache, { recursive: true }),
    mkdir(fixtureDir, { recursive: true }),
  ]);
  return {
    tempRoot,
    packageRoot: resolve(import.meta.dir, "../.."),
    fixtureDir,
    configPath: join(config, "index.yml"),
    dataDir: data,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
      XDG_DATA_HOME: join(tempRoot, "xdg-data"),
      XDG_CACHE_HOME: join(tempRoot, "xdg-cache"),
      GNO_CONFIG_DIR: config,
      GNO_DATA_DIR: data,
      GNO_CACHE_DIR: cache,
      GNO_NO_AUTO_DOWNLOAD: "1",
      GNO_SKILLS_HOME_OVERRIDE: home,
      CLAUDE_SKILLS_DIR: join(home, ".claude", "skills"),
      CODEX_SKILLS_DIR: join(home, ".codex", "skills"),
      OPENCODE_SKILLS_DIR: join(home, ".config", "opencode", "skills"),
      OPENCLAW_SKILLS_DIR: join(home, ".openclaw", "skills"),
      HERMES_SKILLS_DIR: join(home, ".hermes", "skills"),
      APPDATA: join(tempRoot, "appdata"),
      LOCALAPPDATA: join(tempRoot, "local-appdata"),
      USERPROFILE: home,
      TEMP: tempRoot,
      TMP: tempRoot,
      TMPDIR: tempRoot,
      npm_config_cache: join(tempRoot, "npm-cache"),
      npm_config_prefix: npmPrefix,
      npm_config_userconfig: join(tempRoot, "npmrc"),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => safeRm(root)));
});

describe("package smoke isolation", () => {
  test("child env ignores hostile process defaults", async () => {
    const options = await fixture();
    const env = await buildInstalledSetupChildEnv(options, {
      HOME: "/private/user-home",
      GNO_DATA_DIR: "/private/user-data",
      CODEX_SKILLS_DIR: "/private/user-codex-skills",
      APPDATA: "C:\\Users\\real\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\real\\AppData\\Local",
      PATH: "/usr/bin",
    });

    expect(env.HOME).toBe(options.env.HOME);
    expect(env.GNO_DATA_DIR).toBe(options.env.GNO_DATA_DIR);
    expect(env.PATH).toBe("/usr/bin");
    expect(JSON.stringify(env)).not.toContain("/private/user");
    expect(JSON.stringify(env)).not.toContain("C:\\Users\\real");
    expect(env.GNO_NO_AUTO_DOWNLOAD).toBe("1");
    expect(env.GNO_PACKAGE_SMOKE_TEMP_ROOT).toBe(options.tempRoot);
  });

  test("strict child connector resolution ignores hostile host overrides", async () => {
    const options = await fixture();
    const env = await buildPackageSmokeProcessEnv(
      options.tempRoot,
      options.env,
      {
        PATH: process.env.PATH,
        CODEX_SKILLS_DIR: "/private/host-codex-skills",
        APPDATA: "C:\\Users\\host\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\host\\AppData\\Local",
      }
    );
    await assertPackageSmokeEnvironment(options.tempRoot, env);
    const pathsModule = pathToFileURL(
      resolve(import.meta.dir, "../../src/cli/commands/skill/paths.ts")
    ).href;
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { resolveSkillPaths } from ${JSON.stringify(pathsModule)}; process.stdout.write(resolveSkillPaths({ scope: "user", target: "codex" }).gnoDir);`,
      ],
      { cwd: options.tempRoot, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(probe.exitCode).toBe(0);
    expect(probe.stderr?.toString() ?? "").toBe("");
    const resolvedCodexSkill = probe.stdout?.toString() ?? "";
    expect(resolvedCodexSkill).toBe(join(env.CODEX_SKILLS_DIR ?? "", "gno"));
    await assertPackageSmokePathContained(
      options.tempRoot,
      resolvedCodexSkill,
      "child Codex skill"
    );

    const windowsPaths = packageSmokeConnectorPaths(env, "win32");
    expect(windowsPaths["claude-desktop-mcp"]).toBe(
      join(env.APPDATA ?? "", "Claude", "claude_desktop_config.json")
    );
    for (const [id, path] of Object.entries(windowsPaths)) {
      await assertPackageSmokePathContained(
        options.tempRoot,
        path,
        `Windows ${id}`
      );
    }
    expect(JSON.stringify(windowsPaths)).not.toContain("C:\\Users\\host");
  });

  test("connector snapshot child cannot observe hostile connector roots", async () => {
    const options = await fixture();
    const packageRoot = join(options.tempRoot, "fake-package");
    const connectorModule = join(packageRoot, "src", "serve", "connectors.ts");
    await mkdir(join(packageRoot, "src", "serve"), { recursive: true });
    await Bun.write(
      connectorModule,
      `export async function getConnectorStatuses() {
        return [
          {
            id: "codex-skill",
            installKind: "skill",
            installed: false,
            path: process.env.CODEX_SKILLS_DIR + "/gno"
          },
          {
            id: "claude-desktop-mcp",
            installKind: "mcp",
            installed: false,
            path: process.env.APPDATA + "/Claude/claude_desktop_config.json"
          }
        ];
      }`
    );
    const env = await buildPackageSmokeProcessEnv(
      options.tempRoot,
      options.env,
      {
        PATH: process.env.PATH,
        CODEX_SKILLS_DIR: "/private/host-codex-skills",
        APPDATA: "C:\\Users\\host\\AppData\\Roaming",
      }
    );

    const snapshot = await snapshotInstalledConnectorBytes({
      tempRoot: options.tempRoot,
      packageRoot,
      cwd: options.tempRoot,
      homeDir: env.HOME ?? "",
      env,
    });
    expect(snapshot).toEqual({});
  });

  test("outside and symlink-escaped paths fail closed", async () => {
    const options = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "gno-smoke-outside-"));
    roots.push(outside);
    const escape = join(options.tempRoot, "escape");
    await symlink(outside, escape);

    await expectRejection(
      () =>
        assertPackageSmokePathContained(
          options.tempRoot,
          join(outside, "index.sqlite"),
          "outside store"
        ),
      "refused outside"
    );
    await expectRejection(
      () =>
        assertPackageSmokePathContained(
          options.tempRoot,
          join(escape, "index.sqlite"),
          "symlink store"
        ),
      "refused outside"
    );
  });

  test("installed path resolution rejects host package roots before store use", async () => {
    const options = await fixture();
    const inputPath = join(options.dataDir, "input.json");
    await Bun.write(inputPath, "{}");
    const childEnv = await buildInstalledSetupChildEnv(options, {
      PATH: "/usr/bin",
    });

    await expectRejection(
      () => assertInstalledSetupIsolation(options, inputPath, childEnv),
      "refused outside packageRoot"
    );
  });

  test("empty or disabled isolation settings fail before child execution", async () => {
    const options = await fixture();
    await expectRejection(
      () =>
        buildInstalledSetupChildEnv({
          ...options,
          env: { ...options.env, GNO_DATA_DIR: "" },
        }),
      "refused empty GNO_DATA_DIR"
    );
    await expectRejection(
      () =>
        buildInstalledSetupChildEnv({
          ...options,
          env: { ...options.env, GNO_NO_AUTO_DOWNLOAD: "0" },
        }),
      "requires GNO_NO_AUTO_DOWNLOAD=1"
    );
  });
});
