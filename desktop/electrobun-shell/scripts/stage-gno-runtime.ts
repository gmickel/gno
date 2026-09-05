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

/** Electrobun executes hooks with its own Bun, independently of build.bunVersion. */
export async function getStagingBun(sourceRoot: string): Promise<string> {
  const pkg = await Bun.file(join(sourceRoot, "package.json")).json();
  const expected = pkg.devDependencies?.bun;
  if (typeof expected !== "string" || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error(
      "Desktop staging requires an exact root Bun development pin"
    );
  }
  const binary = join(sourceRoot, "node_modules", "bun", "bin", "bun.exe");
  const result = Bun.spawnSync([binary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const actual = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0 || actual !== expected) {
    throw new Error(
      `Desktop staging Bun mismatch: expected ${expected}, got ${actual || result.exitCode}`
    );
  }
  return binary;
}

export async function stageRuntime(
  sourceRoot = repoRoot,
  targetRoot = stagingRoot
): Promise<void> {
  const bun = await getStagingBun(sourceRoot);

  await rm(targetRoot, { force: true, recursive: true });
  await mkdir(targetRoot, { recursive: true });

  for (const relPath of runtimeFiles) {
    await cp(join(sourceRoot, relPath), join(targetRoot, relPath), {
      dereference: true,
      force: true,
      recursive: true,
    });
  }

  const install = Bun.spawnSync(
    [bun, "install", "--production", "--frozen-lockfile", "--ignore-scripts"],
    {
      cwd: targetRoot,
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
    join(targetRoot, "desktop-runtime-manifest.json"),
    JSON.stringify(
      {
        bunVersion: (await Bun.file(join(sourceRoot, "package.json")).json())
          .devDependencies.bun,
        generatedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        runtimeFiles,
      },
      null,
      2
    )
  );

  console.log(`[gno-electrobun] staged runtime at ${targetRoot}`);
}

if (import.meta.main) await stageRuntime();
