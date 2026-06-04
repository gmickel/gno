import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

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

describe("gno capture", () => {
  let testDir: string;
  let notesDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-capture-${Date.now()}`);
    notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    const init = await cli("init", notesDir, "--name", "notes");
    expect(init.code).toBe(0);
  });

  afterEach(async () => {
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("captures inline content and returns a JSON receipt", async () => {
    const result = await cli(
      "capture",
      "Remember this",
      "--collection",
      "notes",
      "--source-kind",
      "web",
      "--source-url",
      "https://example.com/post",
      "--tags",
      "Inbox,Project",
      "--json"
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.uri).toStartWith("gno://notes/inbox/");
    expect(receipt.created).toBe(true);
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.embed.status).toBe("not_requested");
    expect(receipt.source.kind).toBe("web");
    expect(receipt.source.url).toBe("https://example.com/post");
    expect(receipt.tags).toEqual(["inbox", "project"]);

    const content = await Bun.file(join(notesDir, receipt.relPath)).text();
    expect(content).toContain("Remember this");
    expect(content).toContain("source:");
  });

  test("quiet output prints only the URI", async () => {
    const result = await cli(
      "--quiet",
      "capture",
      "Quiet note",
      "--collection",
      "notes"
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toStartWith("gno://notes/inbox/");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("rejects conflicting content sources", async () => {
    const clipPath = join(testDir, "clip.md");
    await writeFile(clipPath, "clip");
    const result = await cli(
      "capture",
      "Inline",
      "--file",
      clipPath,
      "--collection",
      "notes",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("Use only one content source");
  });

  test("detects disk-only collisions", async () => {
    await writeFile(join(notesDir, "project-plan.md"), "# Existing\n");
    const result = await cli(
      "capture",
      "# Project Plan",
      "--collection",
      "notes",
      "--title",
      "Project Plan",
      "--collision-policy",
      "create_with_suffix",
      "--json"
    );

    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.relPath).toBe("project-plan-2.md");
    expect(receipt.createdWithSuffix).toBe(true);
    expect(receipt.collisionPolicyResult).toBe("created_with_suffix");
  });
});
