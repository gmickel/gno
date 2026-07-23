import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const cli = async (
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
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
};

describe("saved Context Capsule CLI", () => {
  let testDir: string;
  let capsulePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-context-saved-${crypto.randomUUID()}`);
    const docsDir = join(testDir, "docs");
    capsulePath = join(testDir, "capsule.json");
    await mkdir(docsDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    await Bun.write(
      join(docsDir, "decision.md"),
      "# Launch decision\n\nMina owns the launch decision."
    );
    expect((await cli("init", docsDir, "--name", "docs")).code).toBe(0);
    expect((await cli("update")).code).toBe(0);
    expect(
      (
        await cli(
          "context",
          "build",
          "launch decision",
          "--budget",
          "100000",
          "--collection",
          "docs",
          "--fast",
          "--json",
          "--output",
          capsulePath
        )
      ).code
    ).toBe(0);
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("watches, lists, reverifies, and unwatches an explicit Capsule file", async () => {
    const watched = await cli(
      "context",
      "watch",
      capsulePath,
      "--question",
      "Who owns launch?",
      "--label",
      "launch",
      "--notify",
      "--json"
    );
    expect(watched.code).toBe(0);
    const registration = JSON.parse(watched.stdout);
    expect(registration).toMatchObject({
      label: "launch",
      question: "Who owns launch?",
      notificationPreference: "local",
      indexName: "default",
    });
    expect(JSON.stringify(registration)).not.toContain(
      "Mina owns the launch decision."
    );
    expect(
      assertValid(registration, await loadSchema("saved-capsule-watch"))
    ).toBe(true);

    const listed = await cli("context", "watches", "--json");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).registrations).toHaveLength(1);
    expect(
      assertValid(
        JSON.parse(listed.stdout),
        await loadSchema("saved-capsule-list")
      )
    ).toBe(true);

    const reverified = await cli(
      "context",
      "reverify",
      registration.registrationId,
      "--json"
    );
    expect(reverified.code).toBe(0);
    const completed = JSON.parse(reverified.stdout);
    expect(completed.verification).toMatchObject({
      operationStatus: "completed",
      affectedQuestionState: "unaffected",
    });
    expect(completed.registration.verification).toEqual(completed.verification);
    expect(
      assertValid(completed, await loadSchema("saved-capsule-reverification"))
    ).toBe(true);

    await Bun.write(
      capsulePath,
      `${await Bun.file(capsulePath).text()}
`
    );
    const failedReverification = await cli(
      "context",
      "reverify",
      registration.registrationId,
      "--json"
    );
    expect(failedReverification.code).toBe(0);
    const failed = JSON.parse(failedReverification.stdout);
    expect(failed).toMatchObject({
      receipt: null,
      verification: {
        triggerKind: "manual",
        operationStatus: "failed",
        affectedQuestionState: "unknown",
        errorCode: "capsule_file_changed",
      },
    });
    expect(failed.registration.verification).toEqual(failed.verification);
    expect(
      assertValid(failed, await loadSchema("saved-capsule-reverification"))
    ).toBe(true);

    const removed = await cli(
      "context",
      "unwatch",
      registration.registrationId,
      "--json"
    );
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout).removed).toBe(true);
    expect(
      assertValid(
        JSON.parse(removed.stdout),
        await loadSchema("saved-capsule-unwatch")
      )
    ).toBe(true);
    const emptyList = JSON.parse(
      (await cli("context", "watches", "--json")).stdout
    );
    expect(emptyList.registrations).toEqual([]);
  }, 30_000);
});
