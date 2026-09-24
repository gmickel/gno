/**
 * R8 sweep: no CLI read command returns archived session content under the
 * curated (default) config, whether it names the archive index with --index
 * or through a `?index=` URI.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdir)
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, tempDir } from "../sessions/helpers";

/** Text that only exists in the archived Codex fixture turn. */
const ARCHIVED = "alpha queue uses SQLite";

let root: string;
let archiveUri: string;
const saved = { ...process.env };

async function cli(
  ...args: string[]
): Promise<{ code: number; output: string }> {
  let output = "";
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    return { code: await runCli(["node", "gno", ...args]), output };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

beforeAll(async () => {
  root = await tempDir("gno-sessions-isolation-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  process.env.HOME = join(root, "home");
  await mkdir(join(root, "notes"), { recursive: true });
  await Bun.write(
    join(root, "notes", "note.md"),
    "# Note\n\nA curated note.\n"
  );
  expect((await cli("init", join(root, "notes"), "--name", "notes")).code).toBe(
    0
  );
  expect((await cli("update")).code).toBe(0);
  const archive = [
    "--config",
    join(root, "archive.yml"),
    "--index",
    "sessions",
  ];
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
  expect(
    (await cli(...archive, "sessions", "import", "--source", "codex")).code
  ).toBe(0);
  const found = await cli(...archive, "search", "SQLite", "--json");
  archiveUri = (JSON.parse(found.output) as { results: Array<{ uri: string }> })
    .results[0]!.uri;
  expect(archiveUri).toContain("?index=sessions");
});

afterAll(async () => {
  process.env = saved;
  await safeRm(root);
});

describe("curated config never returns archive content", () => {
  const cases: Array<[string, () => string[]]> = [
    ["get <archive uri>", () => ["get", archiveUri]],
    [
      "get --index default <archive uri>",
      () => ["--index", "default", "get", archiveUri],
    ],
    ["multi-get <archive uri>", () => ["multi-get", archiveUri]],
    ["--index sessions get", () => ["--index", "sessions", "get", archiveUri]],
    [
      "--index sessions search",
      () => ["--index", "sessions", "search", "SQLite"],
    ],
    [
      "--index sessions query --fast",
      () => ["--index", "sessions", "query", "SQLite", "--fast"],
    ],
    [
      "--index sessions ask --no-answer",
      () => ["--index", "sessions", "ask", "SQLite", "--no-answer"],
    ],
    ["--index sessions ls", () => ["--index", "sessions", "ls"]],
    ["--index sessions tags", () => ["--index", "sessions", "tags", "list"]],
    [
      "--index sessions links",
      () => ["--index", "sessions", "links", "list", archiveUri],
    ],
    [
      "--index sessions backlinks",
      () => ["--index", "sessions", "backlinks", archiveUri],
    ],
    [
      "--index sessions similar",
      () => ["--index", "sessions", "similar", archiveUri],
    ],
    [
      "--index sessions graph",
      () => ["--index", "sessions", "graph", "--json"],
    ],
    ["--index sessions changes", () => ["--index", "sessions", "changes"]],
    [
      "--index sessions diff",
      () => ["--index", "sessions", "diff", archiveUri],
    ],
    [
      "--index sessions impact",
      () => ["--index", "sessions", "impact", archiveUri],
    ],
    [
      "--index sessions context build",
      () => [
        "--index",
        "sessions",
        "context",
        "build",
        "SQLite queue",
        "--budget",
        "4000",
        "--fast",
      ],
    ],
    [
      "--index sessions publish export",
      () => ["--index", "sessions", "publish", "export", "work"],
    ],
    ["links list <archive uri>", () => ["links", "list", archiveUri]],
    ["backlinks <archive uri>", () => ["backlinks", archiveUri]],
    ["similar <archive uri>", () => ["similar", archiveUri]],
    ["diff <archive uri>", () => ["diff", archiveUri]],
    ["impact <archive uri>", () => ["impact", archiveUri]],
    ["search", () => ["search", "SQLite"]],
    ["ls", () => ["ls"]],
  ];
  for (const [name, args] of cases) {
    test(name, async () => {
      const result = await cli(...args());
      expect(result.output).not.toContain(ARCHIVED);
    });
  }

  test("control: the archive pair itself returns the archived turn", async () => {
    const result = await cli(
      "--config",
      join(root, "archive.yml"),
      "--index",
      "sessions",
      "get",
      archiveUri
    );
    expect(result.output).toContain(ARCHIVED);
  });

  test("the archive pair can run every read command without a binding error", async () => {
    const pair = ["--config", join(root, "archive.yml"), "--index", "sessions"];
    const failures: string[] = [];
    for (const [name, args] of cases) {
      const own = args().filter(
        (arg, index, all) =>
          !(arg === "--index" || all[index - 1] === "--index")
      );
      const result = await cli(...pair, ...own);
      if (
        result.output.includes("SESSIONS_BINDING_MISMATCH") ||
        result.output.includes("session archive bound to")
      ) {
        failures.push(name);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  test("a cross-index get names the binding mismatch", async () => {
    const result = await cli("--json", "get", archiveUri);
    expect(result.code).toBe(1);
    expect(result.output).toContain("SESSIONS_BINDING_MISMATCH");
  });
});
