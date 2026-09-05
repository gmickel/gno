import { expect, test } from "bun:test";
// node:fs/promises/os/path: Bun has no temp-directory or symlink creation/path APIs.
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPackedNativeWorker } from "../../scripts/package-smoke-native-worker";

const root = new URL("../../", import.meta.url).pathname;

test("packed native entry and client preserve lifecycle, fault, framing and request identity contracts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "gno-native-package-"));
  const archive = join(temp, "package.tgz");
  const pack = Bun.spawn(
    [
      process.execPath,
      "pm",
      "pack",
      "--ignore-scripts",
      "--filename",
      archive,
      "--quiet",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" }
  );
  const packError = new Response(pack.stderr).text();
  expect(await pack.exited, await packError).toBe(0);
  const extract = Bun.spawn(["tar", "-xzf", archive, "-C", temp], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await extract.exited, await new Response(extract.stderr).text()).toBe(
    0
  );
  const packageRoot = join(temp, "package");
  // Installed dependency reuse is explicit: this is package-layout proof, not a fresh install.
  await symlink(
    join(root, "node_modules"),
    join(packageRoot, "node_modules"),
    "dir"
  );
  await verifyPackedNativeWorker({ packageRoot, cwd: temp });
}, 40_000);
