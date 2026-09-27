/**
 * Compiled-executable smoke for the per-file budget (fn-198).
 *
 * A standalone `bun build --compile` CLI cannot start the TypeScript file
 * worker, so it prepares files in a child process of itself. This builds the
 * real CLI, indexes a small note plus one slow Markdown file under a 1 s
 * budget, and checks the slow file is stopped mid-step near the deadline
 * while the note indexes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/mkdir have no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeRm } from "../helpers/cleanup";

const REPO = join(import.meta.dir, "../..");
const BUDGET_MS = 1000;
/** Rows of a Markdown table whose code-region parse takes seconds. */
const SLOW_TABLE_ROWS = 80_000;

let root: string;
let binary: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-compiled-processor-"));
  binary = join(root, process.platform === "win32" ? "gno.exe" : "gno");
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "--compile",
      join(REPO, "src/index.ts"),
      // Optional packages the CLI never loads without local inference.
      "--external",
      "youtube-transcript",
      "--external",
      "@node-llama-cpp/linux-*",
      "--external",
      "@node-llama-cpp/mac-*",
      "--external",
      "@node-llama-cpp/win-*",
      "--outfile",
      binary,
    ],
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) {
    throw new Error(`bun build --compile failed: ${built.stderr.toString()}`);
  }
}, 180_000);

afterAll(async () => {
  await safeRm(root);
});

const run = async (args: string[], env: Record<string, string>) => {
  const child = Bun.spawn([binary, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

test("compiled CLI stops a slow file mid-step in its child processor and indexes the rest", async () => {
  const collection = join(root, "notes");
  await mkdir(collection, { recursive: true });
  const rows = Array.from(
    { length: SLOW_TABLE_ROWS },
    (_, row) => `| row ${row} | \`code ${row}\` | [[n${row}]] | 1.5 |`
  );
  await Bun.write(
    join(collection, "big-table.md"),
    [
      "# Big",
      "",
      "| a | b | c | d |",
      "| --- | --- | --- | --- |",
      ...rows,
    ].join("\n")
  );
  await Bun.write(join(collection, "note.md"), "# Note\n\nPlain note.\n");
  const env = {
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data"),
    GNO_CACHE_DIR: join(root, "cache"),
    HOME: join(root, "home"),
  };

  // unicode61: the default snowball tokenizer is a native SQLite extension
  // that a compiled executable does not embed.
  const init = await run(
    ["init", collection, "--name", "notes", "--tokenizer", "unicode61"],
    env
  );
  expect(init.exitCode).toBe(0);
  const configPath = join(env.GNO_CONFIG_DIR, "index.yml");
  const config = Bun.YAML.parse(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >;
  // YAML is a superset of JSON.
  await Bun.write(
    configPath,
    JSON.stringify({ ...config, conversion: { timeoutMs: BUDGET_MS } })
  );

  const started = performance.now();
  const update = await run(["--verbose", "update"], env);
  const elapsedMs = performance.now() - started;

  const stopped =
    /\[TIMEOUT\] big-table\.md: Indexing stopped during [a-z -]+: (\d+)ms exceeded/.exec(
      update.stdout
    );
  expect(stopped).not.toBeNull();
  // Stopped at the deadline, not after the whole step (several seconds).
  expect(Number(stopped?.[1])).toBeLessThan(2 * BUDGET_MS);
  expect(update.stdout).toContain("1 added");
  expect(update.stderr).toContain("Still converting notes/big-table.md");
  expect(elapsedMs).toBeLessThan(30_000);
}, 120_000);

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
};

/**
 * The file processor child of a CLI process: the direct child running the
 * same executable (the CLI has other short-lived helpers). pgrep and ps work
 * on Linux and macOS.
 */
const processorChild = async (parent: number): Promise<number> => {
  const read = async (cmd: string[]): Promise<string> =>
    new Response(
      Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" }).stdout
    ).text();
  const pids = (await read(["pgrep", "-P", String(parent)]))
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0);
  for (const pid of pids) {
    const command = await read(["ps", "-o", "command=", "-p", String(pid)]);
    if (command.includes(binary)) return pid;
  }
  return 0;
};

test
  .skipIf(process.platform === "win32")
  .each(["SIGTERM", "SIGINT", "SIGKILL"] as const)(
  "%s to the compiled CLI during a long child step leaves no child running",
  async (signal) => {
    // SIGKILL cannot be handled; only the Linux parent-death signal covers it.
    if (signal === "SIGKILL" && process.platform !== "linux") return;
    const collection = join(root, `signal-${signal}`);
    await mkdir(collection, { recursive: true });
    const rows = Array.from(
      { length: SLOW_TABLE_ROWS },
      (_, row) => `| row ${row} | \`code ${row}\` | [[n${row}]] | 1.5 |`
    );
    await Bun.write(
      join(collection, "big-table.md"),
      ["| a | b | c | d |", "| --- | --- | --- | --- |", ...rows].join("\n")
    );
    const env = {
      GNO_CONFIG_DIR: join(root, `config-${signal}`),
      GNO_DATA_DIR: join(root, `data-${signal}`),
      GNO_CACHE_DIR: join(root, `cache-${signal}`),
      HOME: join(root, `home-${signal}`),
    };
    const init = await run(
      ["init", collection, "--name", "notes", "--tokenizer", "unicode61"],
      env
    );
    expect(init.exitCode).toBe(0);
    const parent = Bun.spawn([binary, "update"], {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let child = 0;
      expect(
        await waitFor(async () => {
          child = await processorChild(parent.pid);
          return child > 0;
        }, 10_000)
      ).toBe(true);
      // Let the child load and enter the long code-region step.
      await Bun.sleep(1500);
      expect(pidAlive(child)).toBe(true);

      parent.kill(signal);

      const stopped = await waitFor(() => !pidAlive(child), 1000);
      await parent.exited;
      if (!stopped) process.kill(child, 9);
      expect(stopped).toBe(true);
    } finally {
      parent.kill(9);
    }
  },
  60_000
);
