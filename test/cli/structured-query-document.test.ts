import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

let testDir: string;
let fixturesDir: string;
let stdoutData = "";
let stderrData = "";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalNoAutoDownload = process.env.GNO_NO_AUTO_DOWNLOAD;

function captureOutput() {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput() {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(...args: string[]) {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

beforeAll(async () => {
  testDir = join(tmpdir(), `gno-structured-query-${Date.now()}`);
  fixturesDir = join(testDir, "fixtures");

  await mkdir(testDir, { recursive: true });
  await cp(join(import.meta.dir, "../fixtures/docs"), fixturesDir, {
    recursive: true,
  });

  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  process.env.GNO_NO_AUTO_DOWNLOAD = "1";

  await cli("init", fixturesDir, "--name", "fixtures");
  await cli("update");
}, 30_000);

afterAll(async () => {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  if (originalNoAutoDownload === undefined) {
    Reflect.deleteProperty(process.env, "GNO_NO_AUTO_DOWNLOAD");
  } else {
    process.env.GNO_NO_AUTO_DOWNLOAD = originalNoAutoDownload;
  }
});

describe("CLI structured query documents", () => {
  test("gno query accepts multiline structured query documents", async () => {
    const { code, stdout } = await cli(
      "query",
      "auth flow\nterm: JWT token\nintent: refresh token rotation",
      "--fast",
      "--json"
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      results: Array<{ uri: string }>;
      meta: {
        query: string;
        queryModes: { term: number; intent: number; hyde: boolean };
      };
    };
    expect(parsed.meta.query).toBe("auth flow");
    expect(parsed.meta.queryModes).toEqual({ term: 1, intent: 1, hyde: false });
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  test("gno ask accepts multiline structured query documents", async () => {
    const { code, stdout } = await cli(
      "ask",
      "term: JWT token\nintent: refresh token rotation",
      "--no-answer",
      "--fast",
      "--json"
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      results: Array<{ uri: string }>;
      meta: {
        queryModes: { term: number; intent: number; hyde: boolean };
      };
    };
    expect(parsed.meta.queryModes).toEqual({ term: 1, intent: 1, hyde: false });
    expect(parsed.results.length).toBeGreaterThan(0);
  });

  test("returns validation error for invalid structured documents", async () => {
    const { code, stderr } = await cli(
      "query",
      "term: JWT token\nvector: semantic expansion",
      "--json"
    );
    expect(code).toBeGreaterThan(0);
    expect(stderr).toContain("Unknown structured query line prefix");
  });
});
