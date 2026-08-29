import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERSION, getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

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
}

function restoreOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

async function writeServePid(dataDir: string, payload: object): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await Bun.write(`${dataDir}/serve.pid`, `${JSON.stringify(payload)}\n`);
}

describe("gno peek --json", () => {
  let root: string;
  let notes: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-cli-peek-"));
    notes = join(root, "notes");
    await mkdir(notes, { recursive: true });
    previousEnv = {
      GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
      GNO_DATA_DIR: process.env.GNO_DATA_DIR,
      GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    };
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
  });

  afterEach(async () => {
    restoreOutput();
    setOptionalEnv("GNO_CONFIG_DIR", previousEnv.GNO_CONFIG_DIR);
    setOptionalEnv("GNO_DATA_DIR", previousEnv.GNO_DATA_DIR);
    setOptionalEnv("GNO_CACHE_DIR", previousEnv.GNO_CACHE_DIR);
    await safeRm(root);
  });

  test("uninitialized exits 0 with pinned nulls", async () => {
    const { code, stdout } = await cli("peek", "--json");
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload).toMatchObject({
      schemaVersion: "peek@1.0",
      gnoVersion: VERSION,
      initialized: false,
      indexName: "default",
      counts: null,
      backlog: null,
      lastIndexedAt: null,
      recent: [],
      serve: { running: false, url: null },
    });
    expect(assertValid(payload, await loadSchema("peek"))).toBe(true);
  });

  test("initialized empty index reports zero counts", async () => {
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    const { code, stdout } = await cli("peek", "--json");
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.initialized).toBe(true);
    expect(payload.counts).toEqual({ documents: 0, collections: 0 });
    expect(payload.backlog).toEqual({ pending: 0, failed: 0 });
    expect(payload.recent).toEqual([]);
    expect(payload.serve).toEqual({ running: false, url: null });
    expect(assertValid(payload, await loadSchema("peek"))).toBe(true);
  });

  test("initialized index includes recent docs and store docids", async () => {
    await Bun.write(join(notes, "inbox.md"), "# Inbox\n\nhello\n");
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    expect(await runCli(["bun", "gno", "index", "--no-embed"])).toBe(0);

    const first = await cli("peek", "--json");
    expect(first.code).toBe(0);
    const warmStarted = performance.now();
    const { code, stdout } = await cli("peek", "--json");
    const warmMs = performance.now() - warmStarted;
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.initialized).toBe(true);
    expect(payload.counts.documents).toBeGreaterThanOrEqual(1);
    expect(payload.counts.collections).toBe(1);
    expect(payload.recent).toHaveLength(1);
    expect(payload.recent[0].docid).toMatch(/^#[a-f0-9]{6,8}$/);
    expect(payload.recent[0].uri).toBe("gno://notes/inbox.md");
    expect(payload.recent[0].collection).toBe("notes");
    expect(payload.recent[0].absPath).toBe(join(notes, "inbox.md"));
    expect(payload.recent[0].title).toBe("Inbox");
    expect(assertValid(payload, await loadSchema("peek"))).toBe(true);
    expect(warmMs).toBeGreaterThanOrEqual(0);
  });

  test("live serve pid-file reports localhost url", async () => {
    await writeServePid(join(root, "data"), {
      pid: process.pid,
      cmd: "serve",
      version: VERSION,
      started_at: "2026-08-29T09:00:00Z",
      port: 3456,
    });
    const { code, stdout } = await cli("peek", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).serve).toEqual({
      running: true,
      url: "http://localhost:3456",
    });
  });

  test("stale serve pid reports not running", async () => {
    await writeServePid(join(root, "data"), {
      pid: 2_147_483_647,
      cmd: "serve",
      version: VERSION,
      started_at: "2026-08-29T09:00:00Z",
      port: 3456,
    });
    const { code, stdout } = await cli("peek", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).serve).toEqual({ running: false, url: null });
  });

  test("failed database read returns RUNTIME envelope and exit 2", async () => {
    expect(await runCli(["bun", "gno", "init", notes, "--name", "notes"])).toBe(
      0
    );
    const dbPath = getIndexDbPath();
    await unlink(dbPath).catch(() => undefined);
    await unlink(`${dbPath}-wal`).catch(() => undefined);
    await unlink(`${dbPath}-shm`).catch(() => undefined);
    await mkdir(dbPath);
    const { code, stdout, stderr } = await cli("peek", "--json");
    expect(code).toBe(2);
    const envelope = JSON.parse(stderr);
    expect(envelope).toMatchObject({
      error: { code: "RUNTIME" },
    });
    expect(stdout).not.toContain("schemaVersion");
    expect(envelope.initialized).toBeUndefined();
    expect(envelope.counts).toBeUndefined();
  });

  test("builder and command never touch model or activation machinery", async () => {
    const [coreSource, commandSource] = await Promise.all([
      Bun.file("src/core/peek.ts").text(),
      Bun.file("src/cli/commands/peek.ts").text(),
    ]);
    for (const source of [coreSource, commandSource]) {
      expect(source).not.toContain("ModelCache");
      expect(source).not.toContain("resolveModelUri");
      expect(source).not.toContain("buildActivationStatus");
      expect(source).not.toContain("initStore");
    }
  });
});
