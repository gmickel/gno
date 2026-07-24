import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temp-directory and symlink lifecycle without Bun equivalents.
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path provides fixture paths; Bun has no path utilities.
import { join } from "node:path";

import { loadConfigFromPath } from "../../src/config/loader";
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
});
