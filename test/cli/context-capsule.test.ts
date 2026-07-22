import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatContextCapsuleMarkdown,
  formatContextCapsuleVerificationMarkdown,
} from "../../src/app/context-format";
import {
  canonicalBuiltContextCapsuleJson,
  canonicalVerifiedContextCapsuleJson,
} from "../../src/app/context-runtime";
import { runCli } from "../../src/cli/run";
import { createGnoClient } from "../../src/sdk/client";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const captureOutput = (): void => {
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
};

const restoreOutput = (): void => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
};

const cli = async (
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  captureOutput();
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
};

describe("Context Capsule CLI and SDK", () => {
  let testDir: string;
  let capsulePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-context-capsule-${crypto.randomUUID()}`);
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    capsulePath = join(testDir, "capsule.json");
    await Bun.write(
      join(docsDir, "decision.md"),
      "# Launch decision\n\nMina owns the launch decision.\n\nReview is Friday."
    );
    expect((await cli("init", docsDir, "--name", "docs")).code).toBe(0);
    expect((await cli("context", "add", "/", "Company decisions")).code).toBe(
      0
    );
    expect((await cli("update")).code).toBe(0);
  });

  afterEach(async () => {
    restoreOutput();
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("emits byte-equivalent canonical Capsules across CLI JSON and SDK", async () => {
    const built = await cli(
      "context",
      "build",
      "launch decision",
      "--budget",
      "100000",
      "--collection",
      "docs",
      "--uri-prefix",
      "gno://docs/",
      "--fast",
      "--json"
    );
    expect(built.code).toBe(0);
    expect(built.stderr).toBe("");

    const client = await createGnoClient();
    try {
      const sdkCapsule = await client.context({
        goal: "launch decision",
        budgetTokens: 100_000,
        collections: ["docs"],
        uriPrefix: "gno://docs/",
        depthPolicy: "fast",
      });
      expect(built.stdout).toBe(
        `${canonicalBuiltContextCapsuleJson(sdkCapsule)}\n`
      );
      expect(sdkCapsule.budget.usedBytes).toBe(
        new TextEncoder().encode(built.stdout.trimEnd()).byteLength
      );
      expect(sdkCapsule.budget.usedTokens).toBe(sdkCapsule.budget.usedBytes);
      expect(sdkCapsule.guidance.configuredContexts).toHaveLength(1);
      expect(Object.getOwnPropertySymbols(sdkCapsule.evidence[0]!)).toEqual([]);

      const markdown = await cli(
        "context",
        "build",
        "launch decision",
        "--budget",
        "100000",
        "--collection",
        "docs",
        "--uri-prefix",
        "gno://docs/",
        "--fast",
        "--md"
      );
      expect(markdown.code).toBe(0);
      expect(markdown.stdout).toBe(
        `${formatContextCapsuleMarkdown(sdkCapsule)}\n`
      );
      expect(markdown.stdout).toContain("GNO_EVIDENCE_START");
      expect(markdown.stdout).toContain("Mina owns the launch decision.");
    } finally {
      await client.close();
    }
  }, 30_000);

  test("writes only to an explicit output file and verifies with SDK parity", async () => {
    const built = await cli(
      "context",
      "build",
      "launch decision",
      "--budget",
      "100000",
      "--collection",
      "docs",
      "--uri-prefix",
      "gno://docs/",
      "--fast",
      "--json",
      "--output",
      capsulePath
    );
    expect(built).toEqual({ code: 0, stdout: "", stderr: "" });
    const capsule = JSON.parse(await Bun.file(capsulePath).text());

    const verified = await cli("context", "verify", capsulePath, "--json");
    expect(verified.code).toBe(0);
    expect(verified.stderr).toBe("");

    const client = await createGnoClient();
    try {
      const sdkReceipt = await client.verifyContext(capsule);
      expect(verified.stdout).toBe(
        `${canonicalVerifiedContextCapsuleJson(sdkReceipt)}\n`
      );
      expect(sdkReceipt.contentStatus).toBe("unchanged");
      expect(sdkReceipt.rankingStatus).toBe("unavailable");
      expect(sdkReceipt.evidence[0]?.currentSourceHash).not.toBeNull();

      const markdown = await cli("context", "verify", capsulePath, "--md");
      expect(markdown.code).toBe(0);
      expect(markdown.stdout).toBe(
        `${formatContextCapsuleVerificationMarkdown(sdkReceipt)}\n`
      );
      expect(markdown.stdout).toContain("Fingerprint reasons: none");
    } finally {
      await client.close();
    }
  }, 30_000);

  test("rejects invalid budgets without partial stdout", async () => {
    const result = await cli(
      "context",
      "build",
      "decision owner",
      "--budget",
      "0",
      "--json"
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("VALIDATION");
  });

  test("rejects noncanonical Capsules before opening the store", async () => {
    await Bun.write(capsulePath, JSON.stringify({ schemaVersion: 1 }));
    const result = await cli("context", "verify", capsulePath, "--json");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.details.contextCode).toBe("invalid_input");
  });
});
