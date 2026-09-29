/**
 * GNO_PHASE_TRACE stderr contract (docs/TROUBLESHOOTING.md): unset, a CLI run
 * prints no phase lines; set to 1, every phase line goes to stderr as
 * `gno-phase <ms> <pid> <label>` and stdout stays the command's own output.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/mkdir have no Bun equivalent
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os: tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path: path utils have no Bun equivalent
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PHASE_TRACE_ENV } from "../../src/core/phase-trace";
import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 15_000;
const TRACE_LINE = /^gno-phase (\d+) (\d+) (\S.*)$/;
const TRACE_MARKER = "gno-phase";

interface RunResult {
  exitCode: number;
  pid: number;
  stdout: string;
  stderr: string;
}

let rootDir: string;
let baseEnv: Record<string, string | undefined>;

const run = async (
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env: { ...baseEnv, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, pid: proc.pid, stdout, stderr };
};

const expectSuccess = (result: RunResult): void => {
  if (result.exitCode !== 0) {
    throw new Error(
      `exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
};

describe("GNO_PHASE_TRACE stderr contract", () => {
  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "gno-phase-trace-"));
    const notesDir = join(rootDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "a.md"), "# A\n\nalpha bravo\n");
    baseEnv = {
      ...process.env,
      GNO_CONFIG_DIR: join(rootDir, "config"),
      GNO_DATA_DIR: join(rootDir, "data"),
      GNO_CACHE_DIR: join(rootDir, "cache"),
    };
    // The parent's own setting must not leak into the "unset" run.
    delete baseEnv[PHASE_TRACE_ENV];
    expectSuccess(await run(["init", notesDir, "--name", "notes"]));
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await safeRm(rootDir);
  });

  test(
    "unset: no phase lines on stdout or stderr",
    async () => {
      const result = await run(["ls", "--json"]);
      expectSuccess(result);
      expect(result.stdout).not.toContain(TRACE_MARKER);
      expect(result.stderr).not.toContain(TRACE_MARKER);
      expect(JSON.parse(result.stdout)).toHaveProperty("meta");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "set to 1: documented lines on stderr only, stdout stays clean JSON",
    async () => {
      const result = await run(["ls", "--json"], { [PHASE_TRACE_ENV]: "1" });
      expectSuccess(result);
      expect(result.stdout).not.toContain(TRACE_MARKER);
      expect(JSON.parse(result.stdout)).toHaveProperty("meta");

      const traceLines = result.stderr
        .split("\n")
        .filter((line) => line.startsWith(TRACE_MARKER));
      const labels: string[] = [];
      let lastMs = -1;
      for (const line of traceLines) {
        const match = TRACE_LINE.exec(line);
        expect(match).not.toBeNull();
        const [, ms, pid, label] = match as RegExpExecArray;
        expect(Number(pid)).toBe(result.pid);
        // Milliseconds since process start never go backwards.
        expect(Number(ms)).toBeGreaterThanOrEqual(lastMs);
        lastMs = Number(ms);
        labels.push(label as string);
      }
      expect(labels[0]).toBe("cli: start");
      expect(labels).toContain("store: index open");
      expect(labels).toContain("cli: done (0)");
    },
    TEST_TIMEOUT_MS
  );
});
