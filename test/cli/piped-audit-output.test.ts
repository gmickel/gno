/**
 * Piped JSON completeness for a multi-megabyte audit report. Runs the real
 * entry point as a subprocess: the exit path in src/index.ts is what drops
 * unflushed pipe writes, and in-process runCli tests bypass it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises mkdir/mkdtemp: filesystem structure ops, no Bun equivalent
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCUMENTS = 120;
const BROKEN_LINKS_PER_DOCUMENT = 50;
const MIN_OUTPUT_BYTES = 2 * 1024 * 1024;
// Read only after the child has had time to fill the pipe and reach exit.
const CONSUMER_DELAY_MS = 500;
const TEST_TIMEOUT_MS = 120_000;
const STACK_FRAME = /^\s+at\s/m;

let testDir: string;
let env: Record<string, string | undefined>;

const spawnCli = (...args: string[]) =>
  Bun.spawn({
    cmd: [process.execPath, "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-piped-audit-"));
  const docsDir = join(testDir, "docs");
  await mkdir(docsDir, { recursive: true });
  for (let doc = 0; doc < DOCUMENTS; doc += 1) {
    const links = Array.from(
      { length: BROKEN_LINKS_PER_DOCUMENT },
      (_, link) => `- [[Missing target ${doc}-${link}]]`
    ).join("\n");
    await writeFile(
      join(docsDir, `note-${doc}.md`),
      `# Note ${doc}\n\n${links}\n`
    );
  }
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
  "piped multi-megabyte audit JSON is complete and equals the --output rendering",
  async () => {
    const outputPath = join(testDir, "audit.json");
    const proc = spawnCli(
      "audit",
      "links",
      "--max-findings",
      "all",
      "--json",
      "--output",
      outputPath
    );
    await Bun.sleep(CONSUMER_DELAY_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      proc.exited,
    ]);

    // Exit 4: complete report with findings.
    expect(exitCode).toBe(4);
    expect(stdout.byteLength).toBeGreaterThan(MIN_OUTPUT_BYTES);
    const fileBytes = await Bun.file(outputPath).bytes();
    expect(stdout.byteLength).toBe(fileBytes.byteLength);
    expect(Buffer.from(stdout).equals(Buffer.from(fileBytes))).toBe(true);
    const report = JSON.parse(new TextDecoder().decode(stdout)) as {
      findings: unknown[];
      counts: { findings: { total: number } };
    };
    expect(report.findings.length).toBeGreaterThanOrEqual(
      DOCUMENTS * BROKEN_LINKS_PER_DOCUMENT
    );
    expect(report.findings).toHaveLength(report.counts.findings.total);
  },
  TEST_TIMEOUT_MS
);

test(
  "reader closing the pipe early ends the CLI without a stack trace",
  async () => {
    const proc = spawnCli("audit", "links", "--max-findings", "all", "--json");
    const reader = proc.stdout.getReader();
    await reader.read();
    await reader.cancel();
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect([0, 4]).toContain(exitCode);
    expect(stderr).not.toMatch(STACK_FRAME);
  },
  TEST_TIMEOUT_MS
);

test(
  "SIGINT during a piped audit exits bounded with complete or no JSON",
  async () => {
    const proc = spawnCli("audit", "links", "--max-findings", "all", "--json");
    await Bun.sleep(200);
    proc.kill("SIGINT");
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Interrupted before or after the audit's own handler: bootstrap exit
    // 130, a partial report (5), or an already finished report (4).
    expect([4, 5, 130]).toContain(exitCode);
    expect(stderr).not.toMatch(STACK_FRAME);
    if (stdout.trim().length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  },
  TEST_TIMEOUT_MS
);

test(
  "model-backed command tears down and delivers parseable piped JSON",
  async () => {
    const proc = spawnCli("query", "note", "--offline", "--json");
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  },
  TEST_TIMEOUT_MS
);
