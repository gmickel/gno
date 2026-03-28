// node:fs/promises: recursive copy/remove for build staging (no Bun equivalent).
import { cp, mkdir, rm } from "node:fs/promises";
// node:path: cross-platform staging paths.
import { join, resolve } from "node:path";

const shellRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(shellRoot, "..", "..");
const stagingRoot = join(shellRoot, ".generated", "gno-runtime");
const runtimeFiles = [
  "assets",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "src",
  "THIRD_PARTY_NOTICES.md",
  "vendor",
] as const;

async function stageRuntime(): Promise<void> {
  await rm(stagingRoot, { force: true, recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  for (const relPath of runtimeFiles) {
    await cp(join(repoRoot, relPath), join(stagingRoot, relPath), {
      dereference: true,
      force: true,
      recursive: true,
    });
  }

  const install = Bun.spawnSync(
    [
      process.execPath,
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    {
      cwd: stagingRoot,
      stderr: "inherit",
      stdout: "inherit",
    }
  );

  if (install.exitCode !== 0) {
    throw new Error(
      `bun install failed in staged runtime (exit ${install.exitCode})`
    );
  }

  await Bun.write(
    join(stagingRoot, "desktop-runtime-manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        runtimeFiles,
      },
      null,
      2
    )
  );

  console.log(`[gno-electrobun] staged runtime at ${stagingRoot}`);
}

await stageRuntime();
