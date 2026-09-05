import { expect, test } from "bun:test";
// Bun has no temporary-directory, symlink or recursive cleanup API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pkg from "../../../package.json";
import config from "../electrobun.config";
import { getStagingBun, stageRuntime } from "./stage-gno-runtime";

test("staging uses the pinned binary and rejects drift before clearing artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-desktop-bun-"));
  const binary = join(root, "node_modules/bun/bin/bun.exe");
  const target = join(root, "staged");
  try {
    await mkdir(join(root, "node_modules/bun/bin"), { recursive: true });
    await mkdir(target);
    await symlink(
      resolve(import.meta.dir, "../../../node_modules/bun/bin/bun.exe"),
      binary
    );
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { bun: pkg.devDependencies.bun } })
    );
    expect(await getStagingBun(root)).toBe(binary);
    expect(config.build.bunVersion).toBe(pkg.devDependencies.bun);
    await Bun.write(join(target, "sentinel"), "preserve previous staging");
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { bun: "0.0.0" } })
    );
    const failure = await stageRuntime(root, target).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Desktop staging Bun mismatch"
    );
    expect(await Bun.file(join(target, "sentinel")).text()).toBe(
      "preserve previous staging"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
