/**
 * fn-210: a resident treats SIGHUP (closed terminal, logout) like SIGTERM: a
 * graceful shutdown that releases its files, not an immediate kill.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises — mkdir/mkdtemp are directory-structure ops
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join, resolve } from "node:path";

import { safeRm } from "../helpers/cleanup";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const pids: number[] = [];

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const root of roots.splice(0)) await safeRm(root);
});

for (const mode of ["serve", "daemon"] as const) {
  test.skipIf(process.platform === "win32")(
    `${mode} shuts down gracefully on SIGHUP`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-sighup-"));
      roots.push(root);
      await mkdir(join(root, "notes"), { recursive: true });
      await Bun.write(join(root, "notes", "a.md"), "# A\n");
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HOME: root,
        GNO_CONFIG_DIR: join(root, "config"),
        GNO_DATA_DIR: join(root, "data"),
        GNO_CACHE_DIR: join(root, "cache"),
        GNO_OFFLINE: "1",
      };
      const init = Bun.spawnSync({
        cmd: [process.execPath, "src/index.ts", "init", join(root, "notes")],
        cwd: REPO_ROOT,
        env,
      });
      expect(init.exitCode).toBe(0);
      const port = 45_000 + Math.floor(Math.random() * 2_000);
      const resident = Bun.spawn({
        cmd: [
          process.execPath,
          "src/index.ts",
          mode,
          "--port",
          String(port),
          ...(mode === "daemon" ? ["--no-sync-on-start"] : []),
        ],
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      pids.push(resident.pid);
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        ready = await fetch(`http://127.0.0.1:${port}/api/status`)
          .then((res) => res.ok)
          .catch(() => false);
        if (!ready) await Bun.sleep(200);
      }
      expect(ready).toBe(true);

      const started = Date.now();
      resident.kill("SIGHUP");
      await resident.exited;
      expect(resident.signalCode).toBeNull();
      expect(resident.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(12_000);
      // The owner lock is free again: a new resident can start right away.
      const lock = Bun.spawnSync({
        cmd: [process.execPath, "src/index.ts", "status", "--json"],
        cwd: REPO_ROOT,
        env,
      });
      expect(lock.exitCode).toBe(0);
    },
    60_000
  );
}
