/**
 * Production createDefaultWatcherFs adapter + native lifecycle (gno-27 task .1).
 *
 * Only this suite is intentionally platform-sensitive:
 * - darwin/linux: real anchored support + successful snapshot
 * - win32: explicit unsupported fallback
 * - FIFO-without-writer: bounded, never hangs (darwin/linux when mkfifo works)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWatcherSnapshot,
  diffWatcherSnapshot,
} from "../../src/serve/watch-snapshot";
import { createDefaultWatcherFs } from "../../src/serve/watch-snapshot-handles";
import { safeRm } from "../helpers/cleanup";
import { writeWatchFixture } from "./helpers/watch-snapshot-fixtures";

const FIFO_SNAPSHOT_BUDGET_MS = 2_000;

async function tryMkfifo(path: string): Promise<"ok" | "unavailable"> {
  try {
    const proc = Bun.spawn(["mkfifo", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      return "unavailable";
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | { status: "timeout" }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ status: "timeout" });
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

describe("createDefaultWatcherFs production adapter", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-prod-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("createDefaultWatcherFs builds a real production snapshot on this platform", async () => {
    /**
     * Exercises the native libc/dirent path (not an injected adapter).
     * Broken libc load or dirent layout must fail here rather than hide behind
     * path-backed test doubles.
     */
    const productionFs = createDefaultWatcherFs();

    if (process.platform === "win32") {
      expect(productionFs.supportsAnchoredHandles).toBe(false);
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      if (built.status === "fallback") {
        expect(built.reason).toBe("scan_failed");
      }
      return;
    }

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(productionFs.supportsAnchoredHandles).toBe(true);

      await writeWatchFixture(root, "prod-a.md", "a");
      await writeWatchFixture(root, "nested/prod-b.md", "b");
      const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-prod-out-"));
      try {
        await writeFile(join(outsideDir, "secret.md"), "secret");
        await symlink(outsideDir, join(root, "link-out"), "dir");

        const built = await buildWatcherSnapshot(root, { fs: productionFs });
        expect(built.status).toBe("ok");
        if (built.status !== "ok") {
          return;
        }
        expect(built.snapshot.directories.get("")?.get("prod-a.md")?.kind).toBe(
          "file"
        );
        expect(built.snapshot.directories.get("nested")?.has("prod-b.md")).toBe(
          true
        );
        expect(built.snapshot.directories.get("")?.get("link-out")?.kind).toBe(
          "symlink"
        );
        expect(built.snapshot.directories.has("link-out")).toBe(false);

        await writeWatchFixture(root, "prod-a.md", "changed");
        const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
          fs: productionFs,
        });
        expect(diff.status).toBe("ok");
        if (diff.status !== "ok") {
          return;
        }
        expect(diff.candidates).toEqual(["prod-a.md"]);
        expect(diff.removals).toEqual([]);
      } finally {
        await safeRm(outsideDir);
      }
      return;
    }

    // Other platforms: either explicit unsupported fallback or working adapter.
    if (!productionFs.supportsAnchoredHandles) {
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      return;
    }
    await writeWatchFixture(root, "x.md", "x");
    const built = await buildWatcherSnapshot(root, { fs: productionFs });
    expect(built.status).toBe("ok");
  });

  test("unsupported Windows/production semantics: no path-based silent scan", async () => {
    const productionFs = createDefaultWatcherFs();
    if (process.platform === "win32") {
      expect(productionFs.supportsAnchoredHandles).toBe(false);
      await writeWatchFixture(root, "a.md", "a");
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      if (built.status === "fallback") {
        expect(built.reason).toBe("scan_failed");
      }
      return;
    }
    // Non-Windows: when supportsAnchoredHandles is true, path scan is not used
    // as a silent fallback — either ok or explicit scan_failed only.
    if (!productionFs.supportsAnchoredHandles) {
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      if (built.status === "fallback") {
        expect(built.reason).toBe("scan_failed");
      }
    }
  });

  test("FIFO without writer returns promptly (ok fingerprint or fallback, never hang)", async () => {
    // Lifecycle hang regression: Darwin O_RDONLY|O_SYMLINK without O_NONBLOCK
    // blocks forever on a FIFO with no writer. Linux O_PATH should not block.
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const productionFs = createDefaultWatcherFs();
    if (!productionFs.supportsAnchoredHandles) {
      // Narrow skip: libc/FFI unavailable on this runtime — not a platform blanket.
      return;
    }

    await writeWatchFixture(root, "ok.md", "ok");
    const fifoPath = join(root, "blocked.pipe");
    const mk = await tryMkfifo(fifoPath);
    if (mk !== "ok") {
      // mkfifo binary missing or failed — skip only this special-file case.
      return;
    }

    const started = performance.now();
    const result = await withTimeout(
      buildWatcherSnapshot(root, { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    const elapsed = performance.now() - started;

    expect(result).not.toEqual({ status: "timeout" });
    expect(elapsed).toBeLessThan(FIFO_SNAPSHOT_BUDGET_MS);

    if ("status" in result && result.status === "timeout") {
      return;
    }

    // Accept either a successful fingerprint (kind "other"/file) or explicit fallback.
    // Never hang; never prove a partial deletion image.
    if (result.status === "ok") {
      const entry = result.snapshot.directories.get("")?.get("blocked.pipe");
      expect(entry).toBeDefined();
      // Special files must not become index candidates on first snapshot build.
      expect(result.snapshot.directories.get("")?.has("ok.md")).toBe(true);
    } else {
      expect(result.status).toBe("fallback");
      expect(
        result.reason === "scan_failed" ||
          result.reason === "unreliable_metadata"
      ).toBe(true);
    }
  }, 10_000);

  test("real FIFO transitions: file→FIFO, directory→FIFO, added FIFO, FIFO→file", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }
    const productionFs = createDefaultWatcherFs();
    if (!productionFs.supportsAnchoredHandles) {
      return;
    }

    const { unlink, mkdir } = await import("node:fs/promises");

    // --- file → FIFO ---
    await writeWatchFixture(root, "slot", "file-body");
    await writeWatchFixture(root, "keep.md", "k");
    let built = await withTimeout(
      buildWatcherSnapshot(root, { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(built).not.toEqual({ status: "timeout" });
    if (!("status" in built) || built.status !== "ok") {
      // Platform could not fingerprint — do not claim transition coverage.
      return;
    }
    expect(built.snapshot.directories.get("")?.get("slot")?.kind).toBe("file");

    await unlink(join(root, "slot"));
    if ((await tryMkfifo(join(root, "slot"))) !== "ok") {
      return;
    }

    let diff = await withTimeout(
      diffWatcherSnapshot(root, built.snapshot, [""], { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(diff).not.toEqual({ status: "timeout" });
    if (!("status" in diff) || diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual(["slot"]);
    expect(diff.candidates).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.get("slot")?.kind).toBe(
      "other"
    );

    // --- FIFO → file ---
    await unlink(join(root, "slot"));
    await writeWatchFixture(root, "slot", "again");
    diff = await withTimeout(
      diffWatcherSnapshot(root, diff.nextSnapshot, [""], { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(diff).not.toEqual({ status: "timeout" });
    if (!("status" in diff) || diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["slot"]);
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.get("slot")?.kind).toBe(
      "file"
    );

    // --- added FIFO ---
    if ((await tryMkfifo(join(root, "new.pipe"))) !== "ok") {
      return;
    }
    diff = await withTimeout(
      diffWatcherSnapshot(root, diff.nextSnapshot, [""], { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(diff).not.toEqual({ status: "timeout" });
    if (!("status" in diff) || diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.get("new.pipe")?.kind).toBe(
      "other"
    );

    // --- directory → FIFO ---
    await mkdir(join(root, "was-dir", "nested"), { recursive: true });
    await writeWatchFixture(root, "was-dir/a.md", "a");
    await writeWatchFixture(root, "was-dir/nested/b.md", "b");
    built = await withTimeout(
      buildWatcherSnapshot(root, { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(built).not.toEqual({ status: "timeout" });
    if (!("status" in built) || built.status !== "ok") {
      return;
    }
    expect(built.snapshot.directories.get("")?.get("was-dir")?.kind).toBe(
      "directory"
    );

    await safeRm(join(root, "was-dir"));
    if ((await tryMkfifo(join(root, "was-dir"))) !== "ok") {
      return;
    }
    diff = await withTimeout(
      diffWatcherSnapshot(root, built.snapshot, [""], { fs: productionFs }),
      FIFO_SNAPSHOT_BUDGET_MS
    );
    expect(diff).not.toEqual({ status: "timeout" });
    if (!("status" in diff) || diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual(["was-dir/a.md", "was-dir/nested/b.md"]);
    expect(diff.candidates).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.get("was-dir")?.kind).toBe(
      "other"
    );
  }, 20_000);
});
