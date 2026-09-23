import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isBunfsPath,
  isStandaloneExecutable,
} from "../../src/serve/spa-production-build";

const PROBE = join(import.meta.dir, "fixtures", "spa-compile-probe.ts");
const CROSS_TARGETS = ["bun-windows-x64", "bun-darwin-x64"] as const;

const compileProbe = (
  outfile: string,
  extraArgs: string[] = []
): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      "--compile",
      "--splitting",
      ...extraArgs,
      PROBE,
      "--outfile",
      outfile,
    ],
    cwd: join(import.meta.dir, "../.."),
    stderr: "pipe",
    stdout: "pipe",
  });

test("compiled production SPA source serves the mount entry without bunfs Bun.build", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-spa-compile-"));
  const outfile = join(root, "spa-compile-probe");
  try {
    const compiled = compileProbe(outfile);
    expect(compiled.exitCode).toBe(0);
    const ran = Bun.spawnSync({
      cmd: [outfile],
      cwd: join(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = ran.stdout.toString();
    const stderr = ran.stderr.toString();
    expect(ran.exitCode).toBe(0);
    expect(stderr).not.toContain("failed to open root directory");
    expect(stderr).not.toContain("/$bunfs/root");
    const report = JSON.parse(stdout) as {
      assetStatus: Record<string, number>;
      bundleIndex: string;
      entryHasMount: boolean;
      firstJsPath: string;
      htmlHasRoot: boolean;
      standalone: boolean;
    };
    expect(report.standalone).toBe(true);
    expect(report.bundleIndex.replaceAll("\\", "/")).toContain(
      process.platform === "win32" ? "B:/~BUN/" : "/$bunfs/"
    );
    expect(report.htmlHasRoot).toBe(true);
    expect(report.entryHasMount).toBe(true);
    expect(
      Object.values(report.assetStatus).every((status) => status === 200)
    ).toBe(true);

    for (const target of CROSS_TARGETS) {
      const crossOut = join(root, `spa-compile-probe-${target}`);
      const cross = compileProbe(crossOut, ["--target", target]);
      expect(cross.exitCode).toBe(0);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 180_000);

test("virtual Bun roots are detected without classifying source paths as compiled", () => {
  for (const path of [
    "/$bunfs/root/app",
    "B:/~BUN/root/app.exe",
    "B:\\~BUN\\root\\app.exe",
  ])
    expect(isBunfsPath(path)).toBe(true);
  for (const path of [
    "/work/gno/src/serve/server.ts",
    "C:\\work\\gno\\server.ts",
    "B:/~BUN-backup/app.exe",
  ])
    expect(isBunfsPath(path)).toBe(false);
  expect(isStandaloneExecutable()).toBe(false);
});
