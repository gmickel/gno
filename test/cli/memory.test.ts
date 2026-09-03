import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { resolveMemoryIdentity } from "../../src/cli/commands/memory";
import { runCli } from "../../src/cli/run";
import { MEMORY_EMPTY_RECALL_HINT } from "../../src/core/memory";
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

const IDENTITY = ["--caller", "codex", "--session", "s1"] as const;
const SCOPE = ["--scope", "project:gno"] as const;

function errorEnvelope(stderr: string): {
  code: string;
  message: string;
  details?: { memoryCode?: string };
} {
  return JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}").error;
}

describe("gno remember / gno recall", () => {
  let testDir: string;
  let memoryDir: string;
  const originalEnv = {
    configDir: process.env.GNO_CONFIG_DIR,
    dataDir: process.env.GNO_DATA_DIR,
    cacheDir: process.env.GNO_CACHE_DIR,
  };

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-memory-cli-"));
    memoryDir = join(testDir, "memory");
    const notesDir = join(testDir, "notes");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    expect((await cli("init", memoryDir, "--name", "memory")).code).toBe(0);
    expect(
      (await cli("collection", "add", notesDir, "--name", "notes")).code
    ).toBe(0);

    // Flip the memory collection to managed mode (no CLI flag for it yet).
    const configPath = join(testDir, "config", "index.yml");
    const config = Bun.YAML.parse(await Bun.file(configPath).text()) as {
      collections: Array<{ name: string; memoryManaged?: boolean }>;
    };
    for (const collection of config.collections) {
      if (collection.name === "memory") collection.memoryManaged = true;
    }
    await Bun.write(configPath, Bun.YAML.stringify(config));
  });

  afterAll(async () => {
    await safeRm(testDir);
    process.env.GNO_CONFIG_DIR = originalEnv.configDir;
    process.env.GNO_DATA_DIR = originalEnv.dataDir;
    process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
  });

  test("missing --scope exits VALIDATION naming the flag on both commands", async () => {
    const remembered = await cli("remember", "x", ...IDENTITY, "--json");
    expect(remembered.code).toBe(1);
    expect(errorEnvelope(remembered.stderr).code).toBe("VALIDATION");
    expect(errorEnvelope(remembered.stderr).message).toContain("--scope");

    const recalled = await cli("recall", "x", ...IDENTITY);
    expect(recalled.code).toBe(1);
    expect(recalled.stderr).toContain("--scope");
  });

  test("unmanaged collection fails validation with a clear message", async () => {
    const result = await cli(
      "remember",
      "x",
      ...SCOPE,
      ...IDENTITY,
      "--collection",
      "notes",
      "--add",
      "--json"
    );
    expect(result.code).toBe(1);
    const envelope = errorEnvelope(result.stderr);
    expect(envelope.details?.memoryCode).toBe("MEMORY_COLLECTION_UNMANAGED");
    expect(envelope.message).toContain("memoryManaged");
  });

  test("supersede flag errors are VALIDATION and name the missing flag", async () => {
    const noHash = await cli(
      "remember",
      "x",
      ...SCOPE,
      ...IDENTITY,
      "--supersede",
      "gno://memory/facts/x.md"
    );
    expect(noHash.code).toBe(1);
    expect(noHash.stderr).toContain("--predecessor-hash");

    const both = await cli(
      "remember",
      "x",
      ...SCOPE,
      ...IDENTITY,
      "--add",
      "--supersede",
      "gno://memory/facts/x.md",
      "--predecessor-hash",
      "abc"
    );
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("mutually exclusive");

    const badBudget = await cli(
      "recall",
      "x",
      ...SCOPE,
      ...IDENTITY,
      "--max-facts",
      "0",
      "--json"
    );
    expect(badBudget.code).toBe(1);
    expect(errorEnvelope(badBudget.stderr).message).toContain("--max-facts");
    expect(errorEnvelope(badBudget.stderr).details?.memoryCode).toBe(
      "MEMORY_BUDGET_INVALID"
    );
  });

  test("empty recall prints the self-teaching line verbatim", async () => {
    const text = await cli("recall", "anything", ...SCOPE, ...IDENTITY);
    expect(text.code).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe(MEMORY_EMPTY_RECALL_HINT);

    const json = await cli(
      "recall",
      "anything",
      ...SCOPE,
      ...IDENTITY,
      "--json"
    );
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.facts).toEqual([]);
    expect(parsed.hint).toBe(MEMORY_EMPTY_RECALL_HINT);
    expect(parsed.receipt.caller).toBe("codex");
  });

  test("no decision returns the candidate shape and writes nothing", async () => {
    const result = await cli(
      "remember",
      "The build uses Bun 1.3.",
      ...SCOPE,
      ...IDENTITY,
      "--json"
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("candidates");
    expect(parsed.candidates).toEqual([]);
    expect(parsed.matching.mode).toBe("lexical");
    const files = Array.from(new Bun.Glob("**/*.md").scanSync(memoryDir));
    expect(files).toEqual([]);
  });

  test("add writes the fact, recall cites it with a receipt, budget is honored", async () => {
    const added = await cli(
      "remember",
      "The build uses Bun 1.3.",
      ...SCOPE,
      ...IDENTITY,
      "--add",
      "--json"
    );
    expect(added.code).toBe(0);
    const record = JSON.parse(added.stdout);
    expect(record.outcome).toBe("added");
    expect(record.sync.status).toBe("completed");
    expect(record.record.uri).toStartWith("gno://memory/");
    expect(await Bun.file(record.absPath).exists()).toBe(true);

    const second = await cli(
      "remember",
      "The release build is tagged from main.",
      ...SCOPE,
      ...IDENTITY,
      "--add"
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Remembered fact.");
    expect(second.stdout).toContain("URI: gno://memory/");

    const recalled = await cli(
      "recall",
      "Bun build",
      ...SCOPE,
      ...IDENTITY,
      "--json"
    );
    expect(recalled.code).toBe(0);
    const parsed = JSON.parse(recalled.stdout);
    expect(parsed.facts.map((fact: { uri: string }) => fact.uri)).toContain(
      record.record.uri
    );
    expect(parsed.hint).toBeUndefined();
    expect(parsed.budget).toMatchObject({ maxFacts: 8, maxTokens: 512 });
    expect(parsed.receipt.spanHashes).toContain(record.record.contentHash);

    const text = await cli("recall", "Bun build", ...SCOPE, ...IDENTITY);
    expect(text.stdout).toContain(`1. ${record.record.uri}`);
    expect(text.stdout).toContain("Receipt: ");

    const budgeted = await cli(
      "recall",
      "build",
      ...SCOPE,
      ...IDENTITY,
      "--max-facts",
      "1",
      "--json"
    );
    const limited = JSON.parse(budgeted.stdout);
    expect(limited.facts).toHaveLength(1);
    expect(limited.budget).toMatchObject({ maxFacts: 1, omitted: 1 });

    // Scope is any-intersection: a foreign scope sees nothing.
    const other = await cli(
      "recall",
      "Bun build",
      "--scope",
      "project:other",
      ...IDENTITY,
      "--json"
    );
    expect(JSON.parse(other.stdout).facts).toEqual([]);
  });

  test("exact duplicate is idempotent; receipted replay is fenced", async () => {
    const duplicate = await cli(
      "remember",
      "The build uses Bun 1.3.",
      ...SCOPE,
      ...IDENTITY,
      "--add",
      "--json"
    );
    expect(duplicate.code).toBe(0);
    expect(JSON.parse(duplicate.stdout).outcome).toBe("existing");

    const recalled = await cli(
      "recall",
      "Bun",
      ...SCOPE,
      ...IDENTITY,
      "--json"
    );
    const receiptPath = join(testDir, "receipt.json");
    await Bun.write(receiptPath, recalled.stdout);
    const fenced = await cli(
      "remember",
      "The build uses Bun 1.3.",
      ...SCOPE,
      ...IDENTITY,
      "--add",
      "--receipt",
      receiptPath,
      "--json"
    );
    expect(fenced.code).toBe(1);
    expect(errorEnvelope(fenced.stderr).details?.memoryCode).toBe(
      "MEMORY_FENCED_REPLAY"
    );
  });

  test("supersede verifies the hash, hides the predecessor, and conflicts on a second attempt", async () => {
    const recalled = await cli(
      "recall",
      "Bun",
      ...SCOPE,
      ...IDENTITY,
      "--json"
    );
    const predecessor = JSON.parse(recalled.stdout).facts.find(
      (fact: { text: string }) => fact.text === "The build uses Bun 1.3."
    );
    expect(predecessor).toBeDefined();

    const wrongHash = await cli(
      "remember",
      "The build uses Bun 1.4.",
      ...SCOPE,
      ...IDENTITY,
      "--supersede",
      predecessor.uri,
      "--predecessor-hash",
      "deadbeef",
      "--json"
    );
    expect(wrongHash.code).toBe(1);
    expect(errorEnvelope(wrongHash.stderr).details?.memoryCode).toBe(
      "MEMORY_PREDECESSOR_HASH_MISMATCH"
    );

    const superseded = await cli(
      "remember",
      "The build uses Bun 1.4.",
      ...SCOPE,
      ...IDENTITY,
      "--decision",
      "supersede",
      "--predecessor",
      predecessor.uri,
      "--predecessor-hash",
      predecessor.contentHash,
      "--json"
    );
    expect(superseded.code).toBe(0);
    const successor = JSON.parse(superseded.stdout);
    expect(successor.outcome).toBe("superseded");
    expect(successor.record.supersedes).toEqual([predecessor.uri]);

    const conflict = await cli(
      "remember",
      "The build uses Bun 1.5.",
      ...SCOPE,
      ...IDENTITY,
      "--supersede",
      predecessor.uri,
      "--predecessor-hash",
      predecessor.contentHash,
      "--json"
    );
    expect(conflict.code).toBe(4);
    expect(errorEnvelope(conflict.stderr)).toMatchObject({
      code: "BUSY",
      details: { memoryCode: "MEMORY_SUPERSEDE_CONFLICT" },
    });

    const current = await cli("recall", "Bun", ...SCOPE, ...IDENTITY, "--json");
    const uris = JSON.parse(current.stdout).facts.map(
      (fact: { uri: string }) => fact.uri
    );
    expect(uris).toContain(successor.record.uri);
    expect(uris).not.toContain(predecessor.uri);
  });
});

describe("resolveMemoryIdentity", () => {
  test("flags win over env, env wins over process defaults", () => {
    const env = {
      GNO_MEMORY_CALLER: "env-caller",
      GNO_MEMORY_SESSION: "env-session",
      USER: "gordon",
    };
    expect(
      resolveMemoryIdentity({ caller: "flag", session: "s" }, env)
    ).toEqual({ caller: "flag", session: "s" });
    expect(resolveMemoryIdentity({}, env)).toEqual({
      caller: "env-caller",
      session: "env-session",
    });
    expect(resolveMemoryIdentity({}, { USER: "gordon" })).toEqual({
      caller: "cli:gordon",
      session: `ppid:${process.ppid}`,
    });
  });
});
