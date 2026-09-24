import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdir)
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, snapshotSessionEnv, tempDir } from "../sessions/helpers";

let root: string;
let archiveConfig: string;
const restoreEnv = snapshotSessionEnv();

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const sessionsCode = (stderr: string): string | undefined =>
  (
    JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}") as {
      error?: { details?: { sessionsCode?: string } };
    }
  ).error?.details?.sessionsCode;

beforeAll(async () => {
  root = await tempDir("gno-cli-sessions-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  process.env.HOME = join(root, "home");
  for (const key of [
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_HOME",
    "HERMES_HOME",
  ]) {
    delete process.env[key];
  }
  await mkdir(join(root, "notes"), { recursive: true });
  expect((await cli("init", join(root, "notes"), "--name", "notes")).code).toBe(
    0
  );
  archiveConfig = join(root, "archive.yml");
  const archive = ["--config", archiveConfig, "--index", "sessions"];
  expect(
    (
      await cli(
        ...archive,
        "sessions",
        "init",
        "--archive",
        join(root, "archive"),
        "--collection",
        "work"
      )
    ).code
  ).toBe(0);
  expect(
    (
      await cli(
        ...archive,
        "sessions",
        "source",
        "add",
        "codex",
        "--harness",
        "codex",
        "--path",
        join(FIXTURES, "codex"),
        "--collection",
        "work"
      )
    ).code
  ).toBe(0);
});

afterAll(async () => {
  restoreEnv();
  await safeRm(root);
});

describe("gno sessions CLI", () => {
  test("a fresh install discovers without importing", async () => {
    const result = await cli("sessions", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ candidates: [] });
  });

  const failures: Array<[string, string[], number, string]> = [
    [
      "import without a selection",
      ["--config", "ARCHIVE", "--index", "sessions", "sessions", "import"],
      1,
      "SESSIONS_SELECTION_REQUIRED",
    ],
    [
      "path import without a destination",
      [
        "--config",
        "ARCHIVE",
        "--index",
        "sessions",
        "sessions",
        "import",
        "FIXTURE",
      ],
      1,
      "SESSIONS_DESTINATION_REQUIRED",
    ],
    [
      "archive config with the default index",
      ["--config", "ARCHIVE", "update"],
      1,
      "SESSIONS_BINDING_MISMATCH",
    ],
    [
      "curated config with the archive index",
      ["--index", "sessions", "search", "sqlite"],
      1,
      "SESSIONS_BINDING_MISMATCH",
    ],
    [
      "sessions commands without the archive pair",
      ["sessions", "status"],
      1,
      "SESSIONS_NOT_CONFIGURED",
    ],
  ];
  for (const [name, rawArgs, exit, code] of failures) {
    test(name, async () => {
      const args = rawArgs.map((arg) =>
        arg === "ARCHIVE"
          ? archiveConfig
          : arg === "FIXTURE"
            ? join(FIXTURES, "codex")
            : arg
      );
      const result = await cli("--json", ...args);
      expect(result.code).toBe(exit);
      expect(sessionsCode(result.stderr)).toBe(code);
    });
  }

  test("plain update on the curated config never reads the archive", async () => {
    const imported = await cli(
      "--config",
      archiveConfig,
      "--index",
      "sessions",
      "sessions",
      "import",
      "--source",
      "codex",
      "--json"
    );
    expect(JSON.parse(imported.stdout).counts.imported).toBe(4);
    expect((await cli("update")).code).toBe(0);
    const curated = await cli("search", "SQLite", "--json");
    expect(JSON.parse(curated.stdout).results).toEqual([]);
    const archive = await cli(
      "--config",
      archiveConfig,
      "--index",
      "sessions",
      "search",
      "SQLite",
      "--json"
    );
    expect(JSON.parse(archive.stdout).results).toHaveLength(1);
    const listed = await cli(
      "--config",
      archiveConfig,
      "--index",
      "sessions",
      "ls",
      "--json"
    );
    expect(JSON.parse(listed.stdout).documents.length).toBeGreaterThan(0);
  });

  test("ask --json result URIs on the archive carry ?index=", async () => {
    const result = await cli(
      "--config",
      archiveConfig,
      "--index",
      "sessions",
      "ask",
      "SQLite",
      "--no-answer",
      "--offline",
      "--json"
    );
    const parsed = JSON.parse(result.stdout) as {
      results: Array<{ uri: string }>;
    };
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const item of parsed.results) {
      expect(item.uri).toContain("?index=sessions");
    }
  });

  test("an unsupported-only selection names the file and exits 1", async () => {
    const odd = join(root, "odd-notes.jsonl");
    await Bun.write(odd, `${JSON.stringify({ hello: "world" })}\n`);
    const result = await cli(
      "--json",
      "--config",
      archiveConfig,
      "--index",
      "sessions",
      "sessions",
      "import",
      odd,
      "--collection",
      "work"
    );
    expect(result.code).toBe(1);
    expect(sessionsCode(result.stderr)).toBe("SESSIONS_UNSUPPORTED_FORMAT");
    const receipt = JSON.parse(result.stdout) as {
      status: string;
      units: Array<{ locator: string; outcome: string }>;
    };
    expect(receipt.status).toBe("failed");
    expect(receipt.units[0]).toMatchObject({
      locator: "odd-notes.jsonl",
      outcome: "unsupported",
    });
  });
});
