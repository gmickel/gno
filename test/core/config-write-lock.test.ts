import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temp-directory and symlink lifecycle without Bun equivalents.
import { lstat, mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
// node:os provides the temporary root.
import { homedir, tmpdir } from "node:os";
// node:path provides fixture paths; Bun has no path utilities.
import { basename, join } from "node:path";

import { loadConfigFromPath } from "../../src/config/loader";
import {
  canonicalOperationalPath,
  resolveConfigWriteTarget,
} from "../../src/core/config-write-lock";
import { safeRm } from "../helpers/cleanup";

const roots: string[] = [];
const childScript = join(
  import.meta.dir,
  "..",
  "fixtures",
  "config-mutation-child.ts"
);

async function runWriter(
  configPath: string,
  name: string,
  collectionPath: string
): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, childScript, configPath, name, collectionPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await safeRm(root);
});

describe("canonical config writer lock", () => {
  test("canonicalizes existing paths and expands home-relative paths", async () => {
    const root = await mkdtemp(join(homedir(), ".gno-config-lock-home-"));
    roots.push(root);
    const configPath = join(root, "index.yml");
    await Bun.write(
      configPath,
      'version: "1.0"\ncollections: []\ncontexts: []\n'
    );

    expect(await canonicalOperationalPath(configPath)).toBe(
      await realpath(configPath)
    );
    expect(
      await canonicalOperationalPath(`~/${basename(root)}/future/index.yml`)
    ).toBe(await canonicalOperationalPath(join(root, "future", "index.yml")));
  });

  test("serializes missing-config creators across Bun processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-config-lock-create-"));
    roots.push(root);
    const configPath = join(root, "runtime", "index.yml");
    await mkdir(join(root, "runtime"), { recursive: true });

    await Promise.all([
      runWriter(configPath, "alpha", join(root, "alpha")),
      runWriter(configPath, "beta", join(root, "beta")),
    ]);

    const loaded = await loadConfigFromPath(configPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.collections.map((item) => item.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes config-file aliases without replacing the symlink",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-config-lock-alias-"));
      roots.push(root);
      const target = join(root, "target", "index.yml");
      const alias = join(root, "alias.yml");
      await mkdir(join(root, "target"), { recursive: true });
      await Bun.write(
        target,
        'version: "1.0"\ncollections: []\ncontexts: []\n'
      );
      await symlink(target, alias);

      expect((await resolveConfigWriteTarget(alias)).configPath).toBe(
        await realpath(target)
      );
      await Promise.all([
        runWriter(alias, "alias-write", join(root, "alias-collection")),
        runWriter(target, "target-write", join(root, "target-collection")),
      ]);

      const loaded = await loadConfigFromPath(target);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.collections.map((item) => item.name).sort()).toEqual([
        "alias-write",
        "target-write",
      ]);
      expect(await Bun.file(alias).exists()).toBe(true);
    }
  );

  test.skipIf(process.platform === "win32")(
    "canonicalizes dangling aliases to the prospective target without replacing the symlink",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "gno-config-lock-dangling-alias-")
      );
      roots.push(root);
      const targetDir = join(root, "target");
      const target = join(targetDir, "index.yml");
      const alias = join(root, "alias.yml");
      await mkdir(targetDir, { recursive: true });
      await symlink(join("target", "index.yml"), alias);

      const aliasTarget = await resolveConfigWriteTarget(alias);
      const directTarget = await resolveConfigWriteTarget(target);
      expect(aliasTarget).toEqual(directTarget);

      await Promise.all([
        runWriter(alias, "alias-write", join(root, "alias-collection")),
        runWriter(target, "target-write", join(root, "target-collection")),
      ]);

      const loaded = await loadConfigFromPath(target);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.collections.map((item) => item.name).sort()).toEqual([
        "alias-write",
        "target-write",
      ]);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    }
  );

  test.skipIf(process.platform === "win32")(
    "reports symlink loops instead of treating them as missing paths",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-config-lock-loop-"));
      roots.push(root);
      const first = join(root, "first.yml");
      const second = join(root, "second.yml");
      await symlink("second.yml", first);
      await symlink("first.yml", second);

      expect(canonicalOperationalPath(first)).rejects.toThrow("symlink loop");
    }
  );
});
