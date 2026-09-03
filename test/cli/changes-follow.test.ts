/**
 * `gno changes --follow --jsonl` against a real temp index.
 *
 * Spawns the CLI as a child process (the stream is a long-running stdout
 * contract, SIGINT handling included) while the scripted edit sequence is
 * applied in-process through `update()`. Every test that spawns a follower
 * kills it in cleanup so a failed assertion never leaks a child.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { changes } from "../../src/cli/commands/changes";
import { initStore } from "../../src/cli/commands/shared";
import { update } from "../../src/cli/commands/update";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const IS_WIN = process.platform === "win32";
const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const LINE_TIMEOUT_MS = 15_000;
const QUIET_WINDOW_MS = 1_500;
const TEST_TIMEOUT_MS = 60_000;

interface FollowEventLine {
  event: { id: string; kind: string; current: { relPath: string } | null };
  postCursor: string;
}
interface FollowExpiredLine {
  error: string;
  earliestCursor: string;
  latestCursor: string;
}
type FollowLine = FollowEventLine | FollowExpiredLine;

interface Follower {
  lines: FollowLine[];
  waitForLines(count: number): Promise<FollowLine[]>;
  stop(signal?: NodeJS.Signals): Promise<number>;
  exited: Promise<number>;
  stderr(): Promise<string>;
}

let testDir = "";
let docsDir = "";
let env: Record<string, string | undefined> = {};
let followSchema: object;
const children = new Set<Follower>();

const spawnCli = (args: string[]): Follower => {
  const child = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: FollowLine[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const stderrText = new Response(child.stderr).text();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (raw.trim()) lines.push(JSON.parse(raw) as FollowLine);
        newline = buffer.indexOf("\n");
      }
      const ready = waiters.filter((waiter) => lines.length >= waiter.count);
      for (const waiter of ready) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  })();
  const follower: Follower = {
    lines,
    exited: child.exited,
    stderr: () => stderrText,
    waitForLines: (count) =>
      new Promise((resolvePromise, reject) => {
        if (lines.length >= count) {
          resolvePromise(lines.slice(0, count));
          return;
        }
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for ${count} lines, got ${lines.length}`
              )
            ),
          LINE_TIMEOUT_MS
        );
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolvePromise(lines.slice(0, count));
          },
        });
      }),
    stop: async (signal = "SIGINT") => {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
      const code = await child.exited;
      children.delete(follower);
      return code;
    },
  };
  children.add(follower);
  return follower;
};

const runOnce = async (
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

const sync = async (): Promise<void> => {
  const result = await update({});
  if (!result.success) throw new Error(result.error);
};

/** Create a fixture file (never overwrites; 0600 like the other CLI fixtures). */
const createDoc = (relPath: string, body: string): Promise<void> =>
  writeFile(join(docsDir, relPath), body, { flag: "wx", mode: 0o600 });

/** Create or overwrite a fixture inside the mkdtemp-owned docs dir, then reindex. */
const edit = async (relPath: string, body: string): Promise<void> => {
  await writeFile(join(docsDir, relPath), body, { mode: 0o600 });
  await sync();
};

const journalIdsSince = async (cursor: string): Promise<string[]> => {
  const result = await changes({ since: cursor, limit: 1000 });
  if (!result.success) throw new Error(result.error);
  return result.data.changes.map((change) => change.id);
};

const latestCursor = async (): Promise<string> => {
  const result = await changes({ limit: 1 });
  if (!result.success) throw new Error(result.error);
  return result.data.page.latestCursor;
};

const isEvent = (line: FollowLine): line is FollowEventLine => "event" in line;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-changes-follow-"));
  docsDir = join(testDir, "docs");
  await mkdir(docsDir, { recursive: true });
  env = {
    ...process.env,
    GNO_CONFIG_DIR: join(testDir, "config"),
    GNO_DATA_DIR: join(testDir, "data"),
    GNO_CACHE_DIR: join(testDir, "cache"),
    GNO_OFFLINE: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  process.env.GNO_CONFIG_DIR = env.GNO_CONFIG_DIR;
  process.env.GNO_DATA_DIR = env.GNO_DATA_DIR;
  process.env.GNO_CACHE_DIR = env.GNO_CACHE_DIR;
  followSchema = await loadSchema("changes-follow-event");
  await createDoc("seed.md", "# Seed\nbefore the stream");
  const init = await runOnce(["init", docsDir, "--name", "docs"]);
  expect(init.code).toBe(0);
  await sync();
});

afterAll(async () => {
  for (const child of children) await child.stop("SIGKILL");
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  await safeRm(testDir);
});

describe("gno changes --follow --jsonl flag validation", () => {
  test.each([
    ["--follow without --jsonl", ["changes", "--follow"]],
    ["--jsonl without --follow", ["changes", "--jsonl"]],
    [
      "--cursor without --follow",
      ["changes", "--cursor", "gno-change-v1.eyJzZXF1ZW5jZSI6MX0="],
    ],
    [
      "--follow with --since",
      ["changes", "--follow", "--jsonl", "--since", "2026-01-01T00:00:00Z"],
    ],
    ["--follow with --json", ["changes", "--follow", "--jsonl", "--json"]],
    ["--follow with --limit", ["changes", "--follow", "--jsonl", "-n", "5"]],
    [
      "malformed --cursor",
      ["changes", "--follow", "--jsonl", "--cursor", "not-a-cursor"],
    ],
  ])(
    "rejects %s with exit 1",
    async (_label, args) => {
      const result = await runOnce(args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    },
    TEST_TIMEOUT_MS
  );
});

describe.skipIf(IS_WIN)("gno changes --follow --jsonl stream", () => {
  test(
    "restart with the persisted postCursor leaves no gap and no duplicate",
    async () => {
      const start = await latestCursor();

      const first = spawnCli([
        "changes",
        "--follow",
        "--jsonl",
        "--cursor",
        start,
      ]);
      await createDoc("a.md", "# A\none");
      await edit("b.md", "# B\ntwo");
      await edit("a.md", "# A\none, edited");
      const delivered = (await first.waitForLines(3)).filter(isEvent);
      expect(delivered).toHaveLength(3);
      for (const line of delivered) assertValid(line, followSchema);
      const consumed = delivered.slice(0, 2);
      // The consumer checkpoints only the second line; the third was delivered
      // but never persisted, so it must be redelivered (at-least-once).
      const checkpoint = consumed[1]!.postCursor;
      expect(await first.stop("SIGINT")).toBe(0);

      await rm(join(docsDir, "b.md"));
      await sync();
      await edit("c.md", "# C\nthree");

      const resumed = spawnCli([
        "changes",
        "--follow",
        "--jsonl",
        "--cursor",
        checkpoint,
      ]);
      const replayed = (await resumed.waitForLines(3)).filter(isEvent);
      for (const line of replayed) assertValid(line, followSchema);
      expect(await resumed.stop("SIGINT")).toBe(0);
      expect(resumed.lines).toHaveLength(3);
      expect(await resumed.stderr()).toBe("");

      const expected = await journalIdsSince(start);
      expect(expected).toHaveLength(5);
      const seen = [...consumed, ...replayed].map((line) => line.event.id);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      for (const line of [...consumed, ...replayed]) {
        expect(line.postCursor).toBe(line.event.id);
      }
      expect(replayed[0]!.event.id).toBe(delivered[2]!.event.id);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "starts at the journal tail and stays quiet until an edit lands",
    async () => {
      const follower = spawnCli(["changes", "--follow", "--jsonl"]);
      await sleep(QUIET_WINDOW_MS);
      expect(follower.lines).toHaveLength(0);
      await edit("tail.md", "# Tail\nonly this one");
      const [line] = await follower.waitForLines(1);
      expect(isEvent(line!) && line.event.current?.relPath).toBe("tail.md");
      expect(await follower.stop("SIGINT")).toBe(0);
      expect(follower.lines).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  test(
    "expired resume cursor ends the stream with one error record and exit 2",
    async () => {
      const checkpoint = await latestCursor();
      await edit("after-checkpoint.md", "# Later\nretained past the cursor");
      const opened = await initStore({
        syncConfig: false,
        allowEmptyCollections: true,
      });
      if (!opened.ok) throw new Error(opened.error);
      try {
        const purged = await opened.store.purgeDocumentChanges();
        expect(purged.ok).toBe(true);
      } finally {
        await opened.store.close();
      }

      const follower = spawnCli([
        "changes",
        "--follow",
        "--jsonl",
        "--cursor",
        checkpoint,
      ]);
      const [line] = await follower.waitForLines(1);
      assertValid(line, followSchema);
      expect(line).toMatchObject({ error: "cursor_expired" });
      expect(await follower.exited).toBe(2);
      children.delete(follower);
      expect(follower.lines).toHaveLength(1);
      expect(await follower.stderr()).toBe("");
      expect((line as FollowExpiredLine).earliestCursor).toBe(
        await latestCursor()
      );
    },
    TEST_TIMEOUT_MS
  );
});
