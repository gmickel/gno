import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides test-only temporary directories and symlinks.
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertInstalledSetupIsolation,
  assertPackageSmokePathContained,
  buildInstalledSetupChildEnv,
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
      PATH: "/usr/bin",
    });

    expect(env.HOME).toBe(options.env.HOME);
    expect(env.GNO_DATA_DIR).toBe(options.env.GNO_DATA_DIR);
    expect(env.PATH).toBe("/usr/bin");
    expect(JSON.stringify(env)).not.toContain("/private/user");
    expect(env.GNO_NO_AUTO_DOWNLOAD).toBe("1");
    expect(env.GNO_PACKAGE_SMOKE_TEMP_ROOT).toBe(options.tempRoot);
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
