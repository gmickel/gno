/**
 * `gno daemon --status` reads the persisted findings-pass state from the
 * data dir and surfaces it in both the terminal and JSON payloads, without
 * contacting a daemon.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import {
  createPendingFindingsRunState,
  findingsRunStatePath,
  writeFindingsRunState,
} from "../../src/core/findings-run-state";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string }> {
  stdoutData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (): boolean => true;
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

const ENV_KEYS = ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"] as const;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gno-daemon-findings-status-"));
  await mkdir(join(dir, "data"), { recursive: true });
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    const prior = process.env[key];
    if (prior !== undefined) envSnapshot[key] = prior;
  }
  process.env.GNO_CONFIG_DIR = join(dir, "config");
  process.env.GNO_DATA_DIR = join(dir, "data");
  process.env.GNO_CACHE_DIR = join(dir, "cache");
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const prior = envSnapshot[key];
    if (prior === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prior;
  }
  await safeRm(dir);
});

describe("gno daemon --status findings", () => {
  const statusArgs = () => [
    "daemon",
    "--status",
    "--pid-file",
    join(dir, "daemon.pid"),
    "--log-file",
    join(dir, "daemon.log"),
  ];

  test("reports findings: null when no state file exists", async () => {
    const { code, stdout } = await cli(...statusArgs(), "--json");
    expect(code).toBe(3);
    expect(JSON.parse(stdout).findings).toBeNull();
    const terminal = await cli(...statusArgs());
    expect(terminal.stdout).not.toContain("  findings ");
  });

  test("surfaces a failed last run and a lease skip from the persisted state", async () => {
    const statePath = findingsRunStatePath(getIndexDbPath());
    const base = createPendingFindingsRunState(
      {
        collection: {
          name: "findings",
          path: "/x",
          pattern: "**/*",
          include: [],
          exclude: [],
        },
        cadence: "1h",
        cadenceMs: 3_600_000,
      },
      new Date()
    );
    await writeFindingsRunState(statePath, {
      ...base,
      lastOutcome: "failed",
      lastRunAt: "2026-09-03T10:00:00.000Z",
      error: "audit failed: boom",
    });
    const failed = await cli(...statusArgs(), "--json");
    expect(JSON.parse(failed.stdout).findings).toMatchObject({
      state: "failed",
      lastOutcome: "failed",
      error: "audit failed: boom",
      collection: "findings",
    });
    const failedTerminal = await cli(...statusArgs());
    expect(failedTerminal.stdout).toContain("findings failed (");
    expect(failedTerminal.stdout).toContain("error: audit failed: boom");

    await writeFindingsRunState(statePath, {
      ...base,
      lastOutcome: "skipped_lease",
      lastRunAt: "2026-09-03T11:00:00.000Z",
      error: "lease held by gno index (pid 9)",
    });
    const skipped = await cli(...statusArgs(), "--json");
    expect(JSON.parse(skipped.stdout).findings.state).toBe("skipped_lease");

    await writeFindingsRunState(statePath, {
      ...base,
      lastOutcome: "success",
      nextDueAt: "2020-01-01T00:00:00.000Z",
    });
    const overdue = await cli(...statusArgs(), "--json");
    expect(JSON.parse(overdue.stdout).findings.state).toBe("overdue");
  });
});
