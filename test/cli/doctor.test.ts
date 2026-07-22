import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkConnectorActivation,
  checkRetrievalActivation,
} from "../../src/cli/commands/doctor-activation";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
let testDir = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
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
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-doctor-activation-"));
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  await safeRm(testDir);
});

describe("gno doctor activation exit semantics", () => {
  test("writes one JSON result and exits 2 silently when lexical proof fails", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    expect((await cli("init", emptyDir, "--name", "empty")).code).toBe(0);

    const result = await cli("doctor", "--json");
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.activation).toMatchObject({ usable: false, healthy: false });
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        name: "retrieval-activation",
        status: "error",
      })
    );
  });

  test("warns when connector status omits bounded projections", () => {
    const check = checkConnectorActivation({
      schemaVersion: "1.0",
      usable: true,
      healthy: true,
      collections: [],
      connectors: Array.from({ length: 64 }, (_, index) => ({
        collection: "notes",
        target: index === 0 ? "cursor-mcp" : `connector-${index}`,
        status: "passed",
        remediation: null,
      })),
      connectorProjection: { total: 85, projected: 64, truncated: true },
    });

    expect(check).toMatchObject({
      status: "warn",
      message: "64 of 85 connector target/collection checks projected",
    });
    expect(check?.details?.[0]).toContain(
      "21 target/collection checks were omitted"
    );
  });

  test("does not describe known vector unavailability as pending", () => {
    const check = checkRetrievalActivation({
      schemaVersion: "1.0",
      usable: true,
      healthy: true,
      collections: [
        {
          collection: "notes",
          ready: true,
          generatedAt: null,
          stages: {} as never,
          semanticAvailability: {
            status: "skipped",
            code: "vector_unavailable",
            command: "gno doctor",
          },
          remediation: null,
        },
      ],
      connectors: [],
      connectorProjection: { total: 0, projected: 0, truncated: false },
    });

    expect(check.details).toEqual([
      "Semantic retrieval remains separate (vector_unavailable).",
    ]);
    expect(check.details?.join(" ")).not.toContain("pending");
  });

  test("keeps the store open until a healthy lexical proof completes", async () => {
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(
      join(notesDir, "proof.md"),
      "# Proof\npackagedactivationneedle confirms local retrieval."
    );
    expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
    expect((await cli("update", "--yes")).code).toBe(0);

    const result = await cli("doctor", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).activation).toMatchObject({
      usable: true,
      healthy: true,
      collections: [{ collection: "notes", ready: true }],
    });
  });
});
