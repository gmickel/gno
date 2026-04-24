/**
 * Bench command smoke tests.
 */

import Ajv from "ajv";
// oxlint-disable-next-line import/no-namespace -- ajv-formats exposes default in CJS-compatible namespace
import * as addFormatsModule from "ajv-formats";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import benchResultSchema from "../../spec/output-schemas/bench-result.schema.json";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

const addFormats = addFormatsModule.default;

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput(): void {
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

function restoreOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

const ajv = new Ajv();
addFormats(ajv);
const validateBenchResult = ajv.compile(benchResultSchema);

describe("gno bench", () => {
  let testDir: string;
  let fixturePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-bench-test-${Date.now()}`);
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir, { recursive: true });

    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    await writeFile(
      join(docsDir, "authentication.md"),
      "# Authentication\n\nJWT token rotation keeps sessions secure."
    );
    await writeFile(
      join(docsDir, "caching.md"),
      "# Caching\n\nCache invalidation uses TTL windows."
    );

    fixturePath = join(testDir, "bench.json");
    await writeFile(
      fixturePath,
      JSON.stringify({
        version: 1,
        metadata: { name: "Bench smoke" },
        collection: "docs",
        topK: 1,
        modes: ["bm25"],
        queries: [
          {
            id: "jwt",
            query: "JWT token",
            expected: ["authentication.md"],
            judgments: [{ doc: "authentication.md", relevance: 2 }],
          },
          {
            id: "cache",
            query: "cache invalidation",
            expected: ["caching.md"],
          },
        ],
      })
    );

    await cli("init", docsDir, "--name", "docs");
    await cli("update");
  });

  afterEach(async () => {
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("runs fixture and validates JSON output", async () => {
    const { code, stdout } = await cli("bench", fixturePath, "--json");
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(validateBenchResult(parsed)).toBe(true);
    expect(parsed.fixture.name).toBe("Bench smoke");
    expect(parsed.modes[0].name).toBe("bm25");
    expect(parsed.modes[0].metrics.recallAtK).toBe(1);
    expect(parsed.modes[0].metrics.mrr).toBe(1);
  });

  test("renders terminal summary", async () => {
    const { code, stdout } = await cli("bench", fixturePath);
    expect(code).toBe(0);
    expect(stdout).toContain("Bench: Bench smoke");
    expect(stdout).toContain("| bm25 | ok |");
  });

  test("rejects unsupported CLI mode", async () => {
    const { code, stderr } = await cli("bench", fixturePath, "--mode", "bogus");
    expect(code).toBe(1);
    expect(stderr).toContain("Unsupported bench mode");
  });
});
