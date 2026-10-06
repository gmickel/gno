/**
 * fn-207 R3: a collection's updateCmd never outlives gno. It stops when the
 * CLI is killed (SIGKILL or SIGTERM) and after `updateCmdTimeoutMs`.
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
const IS_WIN = process.platform === "win32";
const roots: string[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const root of roots.splice(0)) await safeRm(root);
});

/** Pids of processes whose command line contains `marker`. */
function pidsMatching(marker: string): number[] {
  const ps = Bun.spawnSync({ cmd: ["ps", "-A", "-o", "pid=,args="] });
  return ps.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("ps -A"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

async function fixture(
  options: { updateCmdTimeoutMs?: number; ignoreTerm?: boolean } = {}
) {
  const { updateCmdTimeoutMs, ignoreTerm = false } = options;
  const root = await mkdtemp(join(tmpdir(), "gno-update-cmd-"));
  roots.push(root);
  const notes = join(root, "notes");
  await mkdir(notes, { recursive: true });
  await Bun.write(join(notes, "a.md"), "# A\n");
  // A unique duration identifies this test's command in the process table.
  const marker = `600.${Math.floor(Math.random() * 1e6)}`;
  await mkdir(join(root, "config"), { recursive: true });
  await Bun.write(
    join(root, "config", "index.yml"),
    JSON.stringify({
      version: "1.0",
      ftsTokenizer: "porter",
      collections: [
        {
          name: "notes",
          path: notes,
          pattern: "**/*.md",
          include: [],
          exclude: [],
          // updateCmd counts as remote egress; the collection must opt in.
          egressPolicy: "remote",
          // Ignoring TERM is inherited by sleep: only SIGKILL stops it.
          updateCmd: `${ignoreTerm ? "trap '' TERM; " : ""}sleep ${marker}`,
          ...(updateCmdTimeoutMs ? { updateCmdTimeoutMs } : {}),
        },
      ],
      contexts: [],
    })
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: root,
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data"),
    GNO_CACHE_DIR: join(root, "cache"),
    GNO_OFFLINE: "1",
  };
  return { env, marker };
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(100);
  return predicate();
}

const cases = [
  { signal: "SIGKILL", ignoreTerm: false },
  { signal: "SIGTERM", ignoreTerm: false },
  { signal: "SIGKILL", ignoreTerm: true },
] as const;

for (const { signal, ignoreTerm } of cases) {
  test.skipIf(IS_WIN)(
    `a CLI killed with ${signal} during updateCmd leaves no command running${ignoreTerm ? " (command ignores SIGTERM)" : ""}`,
    async () => {
      const { env, marker } = await fixture({ ignoreTerm });
      const cli = Bun.spawn({
        cmd: [process.execPath, "src/index.ts", "index", "notes", "--no-embed"],
        cwd: REPO_ROOT,
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      const started = await waitFor(
        () => pidsMatching(`sleep ${marker}`).length > 0,
        15_000
      );
      expect(started).toBe(true);
      cli.kill(signal);
      await cli.exited;
      // A command that ignores SIGTERM gets SIGKILL after a 5 s grace.
      const gone = await waitFor(
        () => pidsMatching(marker).length === 0,
        ignoreTerm ? 9_000 : 3_000
      );
      strays.push(...pidsMatching(marker));
      expect(gone).toBe(true);
    },
    40_000
  );
}

for (const ignoreTerm of [false, true]) {
  test.skipIf(IS_WIN)(
    `an updateCmd that overruns updateCmdTimeoutMs is stopped${ignoreTerm ? " (command ignores SIGTERM)" : ""}`,
    async () => {
      const { env, marker } = await fixture({
        updateCmdTimeoutMs: 500,
        ignoreTerm,
      });
      const started = Date.now();
      const cli = Bun.spawnSync({
        cmd: [process.execPath, "src/index.ts", "index", "notes", "--no-embed"],
        cwd: REPO_ROOT,
        env,
        timeout: 30_000,
      });
      expect(cli.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      const gone = await waitFor(
        () => pidsMatching(marker).length === 0,
        ignoreTerm ? 9_000 : 1_000
      );
      strays.push(...pidsMatching(marker));
      expect(gone).toBe(true);
    },
    40_000
  );
}
