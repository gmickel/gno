import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directories and fixture creation without Bun equivalents.
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import {
  formatSetupResult,
  setup,
  terminalSecretConfirmation,
} from "../../src/cli/commands/setup";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const tempRoots: string[] = [];
const ORIGINAL_DIRS = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function harness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `gno-setup-cli-${label}-`));
  tempRoots.push(root);
  const folder = join(root, "docs");
  await mkdir(folder, { recursive: true });
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  return { root, folder };
}

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.env.GNO_CONFIG_DIR = ORIGINAL_DIRS.config;
  process.env.GNO_DATA_DIR = ORIGINAL_DIRS.data;
  process.env.GNO_CACHE_DIR = ORIGINAL_DIRS.cache;
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("setup command", () => {
  test("bootstraps, proves an exact lexical result, and emits closed JSON", async () => {
    const { folder } = await harness("success");
    await writeFile(
      join(folder, "readme.md"),
      "# Launch\n\nThe Atlas launch window opens on Friday."
    );

    const outcome = await setup({
      folder,
      semantic: false,
      json: true,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.lexical.receipt?.activation?.evidence.resultUri).toBe(
      "gno://docs/readme.md"
    );
    expect(outcome.result.semantic?.status).toBe("skipped");
    assertValid(outcome.result, await loadSchema("setup-command-result"));
    expect(() =>
      JSON.parse(formatSetupResult(outcome.result, { json: true }))
    ).not.toThrow();
  });

  test("repeatable literal exclusions remove secret risk", async () => {
    const { folder } = await harness("exclude");
    await Promise.all([
      writeFile(join(folder, ".env"), "TOKEN=do-not-index"),
      writeFile(
        join(folder, "notes.md"),
        "# Notes\n\nSafe searchable content."
      ),
    ]);

    const outcome = await setup({
      folder,
      exclude: [".env", "node_modules"],
      semantic: false,
      json: true,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.lexical.receipt?.input.excludes).toEqual([
      ".env",
      "node_modules",
    ]);
  });

  test("global yes and JSON never authorize secret risk or prompt", async () => {
    const { folder } = await harness("fail-closed");
    await Promise.all([
      writeFile(join(folder, ".env"), "TOKEN=do-not-index"),
      writeFile(
        join(folder, "notes.md"),
        "# Notes\n\nSafe searchable content."
      ),
    ]);
    let prompts = 0;

    const outcome = await setup({
      folder,
      yes: true,
      json: true,
      stdinIsTTY: true,
      stderrIsTTY: true,
      semantic: false,
      confirmSecretRisk: async () => {
        prompts += 1;
        return true;
      },
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.lexical.error?.code).toBe("secret_risk");
    expect(prompts).toBe(0);
    assertValid(outcome.result, await loadSchema("setup-command-result"));
  });

  test("terminal confirmation reruns the same core with explicit authorization", async () => {
    const { folder } = await harness("authorize");
    await Promise.all([
      writeFile(join(folder, ".env"), "TOKEN=do-not-index"),
      writeFile(
        join(folder, "notes.md"),
        "# Notes\n\nSafe searchable content."
      ),
    ]);
    let prompts = 0;

    const outcome = await setup({
      folder,
      stdinIsTTY: true,
      stderrIsTTY: true,
      semantic: false,
      confirmSecretRisk: async (receipt) => {
        prompts += 1;
        expect(receipt.input.folder).toBe(await realpath(folder));
        return true;
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(prompts).toBe(1);
    expect(outcome.result.lexical.receipt?.input.secretRiskAuthorized).toBe(
      true
    );
  });

  test("decline and prompt EOF preserve the failed secret-risk receipt", async () => {
    const { folder } = await harness("decline");
    await Promise.all([
      writeFile(join(folder, ".env"), "TOKEN=do-not-index"),
      writeFile(
        join(folder, "notes.md"),
        "# Notes\n\nSafe searchable content."
      ),
    ]);
    const outcome = await setup({
      folder,
      stdinIsTTY: true,
      stderrIsTTY: true,
      semantic: false,
      confirmSecretRisk: async () => false,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.lexical.receipt?.failure?.code).toBe("secret_risk");
    expect(
      await terminalSecretConfirmation(
        outcome.result.lexical.receipt!,
        async () => {
          throw new Error("EOF");
        }
      )
    ).toBe(false);
    expect(outcome.result.lexical.receipt?.status).toBe("failed");
  });

  test("empty exclusion is an argument failure before bootstrap", async () => {
    const { folder } = await harness("invalid-exclude");
    const outcome = await setup({
      folder,
      exclude: [""],
      semantic: false,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.lexical.error?.code).toBe("invalid_exclusion");
    expect(
      await Bun.file(join(process.env.GNO_CONFIG_DIR!, "index.yml")).exists()
    ).toBe(false);
  });

  test("semantic failure never changes proven lexical success", async () => {
    const { folder } = await harness("semantic-pending");
    await writeFile(join(folder, "notes.md"), "# Notes\n\nSearchable content.");

    const outcome = await setup({
      folder,
      scheduleSemanticFn: async (options) => ({
        schemaVersion: "1.0",
        status: "pending",
        generatedAt: "2026-07-24T10:00:00.000Z",
        startedAt: null,
        completedAt: null,
        jobId: "a".repeat(64),
        collection: options.setupReceipt.collection.name!,
        indexName: options.indexName,
        folderFingerprint: options.setupReceipt.input.folderFingerprint,
        pid: null,
        offline: options.offline,
        setupReceiptFingerprint: "b".repeat(64),
        setupReceiptPath: options.setupReceipt.paths.receipt,
        receiptPath: join(options.dataDir, "semantic.json"),
        logPath: join(options.dataDir, "semantic.log"),
        resumeCommand: "gno --index default embed docs",
        counts: null,
        error: {
          message: "spawn failed",
          remediation: "Run: gno --index default embed docs",
        },
      }),
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.semantic?.status).toBe("pending");
  });

  test("Commander JSON writes one stdout object and no progress on success and failure", async () => {
    const { folder } = await harness("commander-json");
    await writeFile(join(folder, "notes.md"), "# Notes\n\nSearchable content.");

    const success = await cli("setup", folder, "--no-semantic", "--json");
    expect(success.code).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toMatchObject({
      schemaVersion: "1.0",
      status: "completed",
    });
    expect(
      success.stdout
        .trim()
        .split("\n")
        .filter((line) => line === "{")
    ).toHaveLength(1);

    const missing = await cli("setup", join(folder, "missing"), "--json");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("");
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schemaVersion: "1.0",
      status: "failed",
      lexical: { error: { code: "folder_not_found" } },
    });
  });

  test("Commander terminal progress is stderr-only and quiet suppresses it", async () => {
    const first = await harness("commander-progress");
    await writeFile(
      join(first.folder, "notes.md"),
      "# Notes\n\nSearchable content."
    );
    const normal = await cli("setup", first.folder, "--no-semantic");
    expect(normal.code).toBe(0);
    expect(normal.stdout).toContain("Setup created: docs");
    expect(normal.stderr).toContain("setup: preflight");
    expect(normal.stderr).toContain("setup: completed");
    expect(normal.stderr.match(/setup: preflight/g)).toHaveLength(1);
    expect(normal.stderr.match(/setup: completed/g)).toHaveLength(1);
    expect(normal.stdout).not.toContain("setup: preflight");

    const second = await harness("commander-quiet");
    await writeFile(
      join(second.folder, "notes.md"),
      "# Notes\n\nSearchable content."
    );
    const quiet = await cli("--quiet", "setup", second.folder, "--no-semantic");
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toContain("Setup created: docs");
    expect(quiet.stderr).toBe("");
  });
});
