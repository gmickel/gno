import { afterAll } from "bun:test";
// node:fs: the directory must exist before any test file loads, and the sweep
// is a recursive removal; Bun has no sync temp-dir or rm API.
import { mkdtempSync, rmSync } from "node:fs";
// node:os/node:path: no Bun os/path utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Give the whole `bun test` run its own temp directory and remove it when the
 * run ends. Tests create several hundred `mkdtemp` folders and many never
 * remove them; where /tmp is tmpfs that is RAM. `os.tmpdir()` reads TMPDIR
 * (TEMP/TMP on Windows) on every call, and subprocesses inherit it, so
 * everything a test or its children put under tmpdir() goes with the run.
 *
 * macOS's per-user temp dir is long enough that nesting under it can push
 * Unix socket paths past the 104-byte limit, so there the run dir sits under
 * the short /tmp instead.
 *
 * Set GNO_TEST_KEEP_TMP=1 to keep the directory for leak hunting; its path is
 * printed when the run ends.
 */
const runTempDir = mkdtempSync(
  join(process.platform === "darwin" ? "/tmp" : tmpdir(), "gno-test-")
);
process.env.TMPDIR = runTempDir;
if (process.platform === "win32") {
  process.env.TEMP = runTempDir;
  process.env.TMP = runTempDir;
}

// A preload's afterAll runs once after every file; bun test does not emit
// process "exit" (bun#8434), so this is the hook that actually fires.
afterAll(() => {
  if (process.env.GNO_TEST_KEEP_TMP === "1") {
    console.error(`GNO_TEST_KEEP_TMP: kept ${runTempDir}`);
    return;
  }
  try {
    rmSync(runTempDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A file still held open (Windows) must not fail the run; the leak check
    // in scripts/test-tmp-check.ts reports whatever survives.
  }
});
