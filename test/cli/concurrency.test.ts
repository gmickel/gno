import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE_TRACE_ENV } from "../../src/core/phase-trace";
import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONCURRENCY_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 15_000;
/** The watchdog fires this long before bun's timeout, to report and clean up. */
const WATCHDOG_MARGIN_MS = 3000;
/** Longest wait for a killed child's captured output. */
const OUTPUT_DRAIN_MS = 1000;
/** Characters of each stream kept in a hang report. */
const OUTPUT_TAIL_CHARS = 2000;

/** A CLI child whose output is captured from the start and whose exit is timed. */
interface Child {
  name: string;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  startedAt: number;
  exitedAt: number | null;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

const startChild = (
  name: string,
  args: string[],
  env: Record<string, string | undefined>,
  testStart: number
): Child => {
  const proc = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const child: Child = {
    name,
    proc,
    startedAt: Math.round(performance.now() - testStart),
    exitedAt: null,
    // Read both pipes from the start so a full pipe never blocks the child.
    stdout: new Response(proc.stdout).text(),
    stderr: new Response(proc.stderr).text(),
  };
  void proc.exited.then(() => {
    child.exitedAt = Math.round(performance.now() - testStart);
  });
  return child;
};

const tail = (text: string): string =>
  text.length > OUTPUT_TAIL_CHARS
    ? `...${text.slice(-OUTPUT_TAIL_CHARS)}`
    : text;

/** Output read within `OUTPUT_DRAIN_MS`, or a note that it never closed. */
const drained = (output: Promise<string>): Promise<string> =>
  Promise.race([
    output.catch((error: unknown) => `<read failed: ${String(error)}>`),
    Bun.sleep(OUTPUT_DRAIN_MS).then(() => "<pipe still open>"),
  ]);

const describeChild = async (child: Child, hung = false): Promise<string> =>
  [
    `${child.name}: started at ${child.startedAt} ms, ${
      hung
        ? "had NOT exited (killed)"
        : `exited ${child.proc.exitCode} at ${child.exitedAt} ms`
    }`,
    `  stdout: ${tail(await drained(child.stdout)) || "<empty>"}`,
    `  stderr: ${tail(await drained(child.stderr)) || "<empty>"}`,
  ].join("\n");

/**
 * Wait for every child, or stop at `deadline` and fail naming the children
 * still running, with each child's timing and output. Hung children are
 * killed first, which also closes their pipes.
 */
const awaitChildren = async (
  children: Child[],
  deadline: number
): Promise<void> => {
  const finished = await Promise.race([
    Promise.all(children.map(({ proc }) => proc.exited)).then(() => true),
    Bun.sleep(Math.max(0, deadline - performance.now())).then(() => false),
  ]);
  if (finished) return;
  const hung = children.filter(({ proc }) => proc.exitCode === null);
  for (const { proc } of hung) proc.kill(9);
  const reports = await Promise.all(
    children.map((child) => describeChild(child, hung.includes(child)))
  );
  throw new Error(
    `Hung: ${hung.map(({ name }) => name).join(", ") || "none"}\n${reports.join("\n")}`
  );
};

/** A finished child's stdout, failing with its full report on a non-zero exit. */
const successfulOutput = async (child: Child): Promise<string> => {
  if (child.proc.exitCode !== 0) {
    throw new Error(`Child failed\n${await describeChild(child)}`);
  }
  return child.stdout;
};

describe("CLI concurrent read/write access", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir =
      await Bun.$`mktemp -d ${join(tmpdir(), "gno-cli-concurrency.XXXXXX")}`
        .text()
        .then((value) => value.trim());
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "a.md"), "# A\n\nalpha bravo charlie\n");
  });

  afterEach(async () => {
    await safeRm(testDir);
  });

  test(
    "ls can open while update is running in another process",
    async () => {
      const testStart = performance.now();
      const deadline = testStart + CONCURRENCY_TIMEOUT_MS - WATCHDOG_MARGIN_MS;
      const env = {
        ...process.env,
        GNO_CONFIG_DIR: join(testDir, "config"),
        GNO_DATA_DIR: join(testDir, "data"),
        GNO_CACHE_DIR: join(testDir, "cache"),
        // A hang report then shows the last phase each child reached.
        [PHASE_TRACE_ENV]: "1",
      };

      const init = startChild(
        "init",
        ["init", join(testDir, "notes"), "--name", "notes"],
        env,
        testStart
      );
      await awaitChildren([init], deadline);
      await successfulOutput(init);

      const update = startChild("update", ["update", "--yes"], env, testStart);
      await Bun.sleep(50);
      const lsDuring = startChild(
        "ls (during update)",
        ["ls", "--json"],
        env,
        testStart
      );
      await awaitChildren([update, lsDuring], deadline);
      await successfulOutput(update);

      const parsedDuringUpdate = JSON.parse(
        await successfulOutput(lsDuring)
      ) as {
        documents: Array<{ uri: string }>;
        meta: { total: number };
      };
      expect(parsedDuringUpdate.meta.total).toBeGreaterThanOrEqual(0);

      const lsAfter = startChild(
        "ls (after update)",
        ["ls", "--json"],
        env,
        testStart
      );
      await awaitChildren([lsAfter], deadline);
      // FN201-TEMP: report slow passing runs too (removed before merge).
      if (performance.now() - testStart > 7000) {
        const slow = await Promise.all(
          [init, update, lsDuring, lsAfter].map((child) => describeChild(child))
        );
        console.error(`FN201_SLOW\n${slow.join("\n")}`);
      }
      const parsed = JSON.parse(await successfulOutput(lsAfter)) as {
        documents: Array<{ uri: string }>;
        meta: { total: number };
      };
      expect(parsed.meta.total).toBe(1);
      expect(parsed.documents[0]?.uri).toBe("gno://notes/a.md");
    },
    CONCURRENCY_TIMEOUT_MS
  );
});
