/**
 * Piped CLI output must reach the consumer in full before the process exits
 * (fn-189). Runs the real entry point as a subprocess, because the truncation
 * lives in src/index.ts's exit path, which in-process runCli tests bypass.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises mkdir/mkdtemp: filesystem structure ops, no Bun equivalent
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LINE = "lorem ipsum dolor sit amet, the quick brown fox jumps over it\n";
const BODY = `# Big\n\n${LINE.repeat(20_000)}`;
const MIN_OUTPUT_BYTES = 1024 * 1024;
// Read only after the child has had time to fill the pipe and reach exit;
// a premature process.exit() would drop everything past the pipe buffer.
const CONSUMER_DELAY_MS = 500;
const TEST_TIMEOUT_MS = 60_000;

let testDir: string;
let env: Record<string, string | undefined>;

function spawnCli(...args: string[]) {
  return Bun.spawn({
    cmd: [process.execPath, "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-piped-output-"));
  const docsDir = join(testDir, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "big.md"), BODY);
  env = {
    ...process.env,
    GNO_CONFIG_DIR: join(testDir, "config"),
    GNO_DATA_DIR: join(testDir, "data"),
    GNO_CACHE_DIR: join(testDir, "cache"),
  };
  for (const args of [["init", docsDir, "--name", "docs"], ["update"]]) {
    const proc = spawnCli(...args);
    expect(await proc.exited).toBe(0);
  }
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await safeRm(testDir);
});

test(
  "slow pipe consumer receives complete >1MB JSON and the exit code",
  async () => {
    const filePath = join(testDir, "redirected.json");
    const redirected = Bun.spawn({
      cmd: [
        process.execPath,
        "src/index.ts",
        "get",
        "gno://docs/big.md",
        "--json",
      ],
      cwd: PROJECT_ROOT,
      env,
      stdout: Bun.file(filePath),
    });
    expect(await redirected.exited).toBe(0);

    const proc = spawnCli("get", "gno://docs/big.md", "--json");
    await Bun.sleep(CONSUMER_DELAY_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.byteLength).toBeGreaterThan(MIN_OUTPUT_BYTES);
    expect(stdout.byteLength).toBe(Bun.file(filePath).size);
    const doc = JSON.parse(new TextDecoder().decode(stdout)) as {
      content: string;
    };
    expect(doc.content).toBe(BODY);
  },
  TEST_TIMEOUT_MS
);

test(
  "consumer that closes the pipe early does not hang the CLI",
  async () => {
    const proc = spawnCli("get", "gno://docs/big.md", "--json");
    const reader = proc.stdout.getReader();
    await reader.read();
    await reader.cancel();

    expect(await proc.exited).toBe(0);
  },
  TEST_TIMEOUT_MS
);

test(
  "piped failure keeps its nonzero exit code",
  async () => {
    const proc = spawnCli("get", "gno://docs/missing.md", "--json");
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({
      error: { message: "Document not found" },
    });
  },
  TEST_TIMEOUT_MS
);
