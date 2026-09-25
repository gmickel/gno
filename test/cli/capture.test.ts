import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDataDir } from "../../src/cli/commands/reset";
import { runCli } from "../../src/cli/run";
import { defaultSyncService } from "../../src/ingestion";
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

// A request ID makes each test open a fresh ledger directory, which on Windows
// runs the PowerShell DACL helper: ~0.4 s warm, 2.5 s to over 5 s when it is
// the first PowerShell start of a CI run (bun's default test timeout is 5 s).
const LEDGER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5000;

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

  test(
    "a retried request ID replays, reports status, and refuses a changed payload",
    async () => {
      const args = [
        "capture",
        "Retry me",
        "--collection",
        "notes",
        "--title",
        "Retry",
        "--collision-policy",
        "create_with_suffix",
        "--request-id",
        "cli-retry-1",
        "--json",
      ];
      const first = await cli(...args);
      const again = await cli(...args);
      // Carry stderr so a failed exit code names its error.
      expect(
        [first, again].map(({ code, stderr }) => ({ code, stderr }))
      ).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ]);
      const [a, b] = [JSON.parse(first.stdout), JSON.parse(again.stdout)];
      expect(a.request).toMatchObject({
        requestId: "cli-retry-1",
        replayed: false,
      });
      expect(b).toEqual({ ...a, request: { ...a.request, replayed: true } });

      const status = await cli("request-status", "cli-retry-1", "--json");
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        status: "committed",
        operation: "capture",
        result: { uri: a.uri },
      });

      const changed = await cli(
        ...args.map((arg) => (arg === "Retry me" ? "Different body" : arg))
      );
      expect(changed.code).toBe(1);
      expect(changed.stderr).toContain("REQUEST_ID_CONFLICT");
      const files = [...new Bun.Glob("**/*.md").scanSync(notesDir)];
      expect(files).toEqual([a.relPath]);
    },
    LEDGER_TEST_TIMEOUT_MS
  );

  test("without a request ID a failed lexical sync is still a receipt (exit 0)", async () => {
    const syncPaths = spyOn(defaultSyncService, "syncPaths").mockResolvedValue({
      collection: "notes",
      filesProcessed: 1,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesErrored: 1,
      filesSkipped: 0,
      filesMarkedInactive: 0,
      durationMs: 1,
      files: [
        {
          relPath: "unsynced.md",
          status: "error",
          errorCode: "PARSE_ERROR",
          errorMessage: "bad markdown",
        },
      ],
      errors: [],
    });
    try {
      const result = await cli(
        "capture",
        "Body",
        "--collection",
        "notes",
        "--title",
        "Unsynced",
        "--json"
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).sync).toEqual({
        status: "failed",
        error: "PARSE_ERROR - bad markdown",
      });
    } finally {
      syncPaths.mockRestore();
    }
  });

  test(
    "reset keeps the request ledger so a used ID never runs again",
    async () => {
      const args = [
        "capture",
        "Before reset",
        "--collection",
        "notes",
        "--title",
        "Reset",
        "--collision-policy",
        "create_with_suffix",
        "--request-id",
        "survives-reset",
        "--json",
      ];
      const first = JSON.parse((await cli(...args)).stdout);
      // reset() refuses paths outside the real home directory, so drive the
      // data-directory step it runs directly.
      const cleared = await clearDataDir(join(testDir, "data"));
      expect(cleared.map((entry) => entry.status)).toEqual(["deleted", "kept"]);

      const again = await cli(...args);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout)).toEqual({
        ...first,
        request: { ...first.request, replayed: true },
      });
      expect([...new Bun.Glob("**/*.md").scanSync(notesDir)]).toEqual([
        first.relPath,
      ]);
    },
    LEDGER_TEST_TIMEOUT_MS
  );

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

  test("rejects binary-like file captures", async () => {
    const binaryPath = join(testDir, "clip.bin");
    await writeFile(binaryPath, Buffer.from([0x47, 0x49, 0x46, 0x01, 0x02]));
    const result = await cli(
      "capture",
      "--file",
      binaryPath,
      "--collection",
      "notes",
      "--json"
    );

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr);
    expect(payload.error.code).toBe("VALIDATION");
    expect(payload.error.message).toContain("binary-like");
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
