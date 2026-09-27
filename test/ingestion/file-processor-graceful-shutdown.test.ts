/**
 * An owner's graceful SIGTERM shutdown survives the file processor's
 * child-kill handler (fn-198): the busy child is killed at once, and the
 * owner's async cleanup completes with its own exit code.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/mkdir have no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeRm } from "../helpers/cleanup";

const FIXTURE = join(import.meta.dir, "fixtures/graceful-sigterm-parent.ts");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gno-graceful-sigterm-"));
});

afterEach(async () => {
  await safeRm(tmpDir);
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "a once(SIGTERM) graceful shutdown completes with its exit code while the busy child is killed",
  async () => {
    const root = join(tmpDir, "docs");
    await mkdir(root, { recursive: true });
    const rows = Array.from(
      { length: 80_000 },
      (_, row) => `| row ${row} | \`code ${row}\` | [[n${row}]] | 1.5 |`
    );
    await Bun.write(
      join(root, "big-table.md"),
      ["| a | b | c | d |", "| --- | --- | --- | --- |", ...rows].join("\n")
    );
    const parent = Bun.spawn(
      [process.execPath, FIXTURE, root, join(tmpDir, "index.db")],
      { stdout: "pipe", stderr: "ignore" }
    );
    const reader = parent.stdout.getReader();
    let output = "";
    let child = 0;
    try {
      while (!child) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
        child = Number(/CHILD (\d+)/.exec(output)?.[1] ?? 0);
      }
      expect(child).toBeGreaterThan(0);
      // Let the child load and enter the long code-region step.
      await Bun.sleep(1500);
      expect(pidAlive(child)).toBe(true);

      parent.kill("SIGTERM");
      const stoppedAt = performance.now();
      while (pidAlive(child) && performance.now() - stoppedAt < 1000) {
        await Bun.sleep(10);
      }
      const childGone = !pidAlive(child);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      await parent.exited;
      if (!childGone) process.kill(child, 9);

      expect(childGone).toBe(true);
      expect(output).toContain("GRACEFUL_STARTED");
      expect(output).toContain("GRACEFUL_FINISHED");
      expect(parent.signalCode).toBeNull();
      expect(parent.exitCode).toBe(7);
    } finally {
      parent.kill(9);
    }
  },
  30_000
);
