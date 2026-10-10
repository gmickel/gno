#!/usr/bin/env bun
/**
 * Run `bun test` under a fresh, empty TMPDIR and fail when anything is left in
 * it afterwards. The test preload (test/preload/temp-dir.ts) gives the run its
 * own directory inside TMPDIR and removes it at the end, so a survivor means a
 * file escaped that sweep: a child process that outlived the run, a test that
 * recreated the directory after the sweep, or a broken preload.
 *
 * Usage: bun scripts/test-tmp-check.ts [bun test arguments...]
 * Exit code: bun test's own code when it fails, 1 for leftovers, else 0.
 */
// node:fs/promises: temp-dir creation, recursive listing and removal have no
// Bun equivalent.
import { mkdtemp, readdir, rm } from "node:fs/promises";
// node:os/node:path: no Bun os/path utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

const BYTES_PER_MB = 1024 * 1024;

async function sizeOf(path: string): Promise<number> {
  const entries = await readdir(path, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => null);
  if (entries === null) {
    // Not a directory (or already gone): a top-level file or socket.
    return Bun.file(path).size;
  }
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      bytes += Bun.file(join(entry.parentPath, entry.name)).size;
    }
  }
  return bytes;
}

const checkDir = await mkdtemp(join(tmpdir(), "gno-tc-"));
const env: Record<string, string | undefined> = {
  ...process.env,
  TMPDIR: checkDir,
};
if (process.platform === "win32") {
  env.TEMP = checkDir;
  env.TMP = checkDir;
}

const proc = Bun.spawn([process.execPath, "test", ...Bun.argv.slice(2)], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
const testExitCode = await proc.exited;

const leftovers = (await readdir(checkDir)).sort();
if (leftovers.length > 0) {
  let totalBytes = 0;
  const lines: string[] = [];
  for (const name of leftovers) {
    const bytes = await sizeOf(join(checkDir, name));
    totalBytes += bytes;
    lines.push(`  ${name} (${(bytes / BYTES_PER_MB).toFixed(1)} MB)`);
  }
  console.error(
    `\ntest-tmp-check: ${leftovers.length} entries (${(
      totalBytes / BYTES_PER_MB
    ).toFixed(1)} MB) left in the run's TMPDIR:\n${lines.join("\n")}`
  );
} else {
  console.error("\ntest-tmp-check: TMPDIR is empty after the run.");
}
await rm(checkDir, { recursive: true, force: true, maxRetries: 3 });

if (testExitCode !== 0) {
  process.exit(testExitCode);
}
process.exit(leftovers.length > 0 ? 1 : 0);
