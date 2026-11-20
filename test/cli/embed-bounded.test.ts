/**
 * Bounded `gno embed` runs (`--max-chunks`, `--max-seconds`) through the real
 * CLI process: exit code, JSON receipt, persisted stage marker, write-lease
 * release, and resumption by the next run.
 *
 * The embedding model is a loopback OpenAI-compatible fake served by this
 * test (local_only egress permits loopback), as in index-resume.test.ts.
 *
 * @module test/cli/embed-bounded
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no temporary-directory creation API.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_COUNT = 20;
const DIMENSIONS = 4;

interface FakeEmbedServer {
  port: number;
  texts: () => string[];
  stop: () => void;
}

/** Fails every request that contains the text "poison". */
function startFakeEmbedServer(delayMs = 0): FakeEmbedServer {
  const texts: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (delayMs) await Bun.sleep(delayMs);
      if (inputs.some((text) => text.includes("poison")))
        return new Response("injected failure", { status: 500 });
      texts.push(...inputs);
      return Response.json({
        object: "list",
        model: "fake",
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: Array.from(
            { length: DIMENSIONS },
            (_v, i) => (i + 1) / 10
          ),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    },
  });
  return {
    port: server.port as number,
    texts: () => texts,
    stop: () => server.stop(true),
  };
}

async function writeHome(port: number, poison = 0) {
  const home = await mkdtemp(join(tmpdir(), "gno-embed-bounded-"));
  const docs = join(home, "docs");
  await mkdir(docs, { recursive: true });
  for (let i = 1; i <= DOC_COUNT; i += 1) {
    const body = i <= poison ? "poison" : `paragraph about bounded topic ${i}`;
    await writeFile(
      join(docs, `d${String(i).padStart(2, "0")}.md`),
      `# Doc ${i}\n\n${body}\n`
    );
  }
  const base = `http://127.0.0.1:${port}/v1`;
  const config = {
    version: "1.0",
    ftsTokenizer: "snowball english",
    busyTimeoutMs: 60_000,
    collections: [
      { name: "docs", path: docs, pattern: "**/*", include: [], exclude: [] },
    ],
    contexts: [],
    contentTypes: [],
    models: {
      activePreset: "fake",
      presets: [
        {
          id: "fake",
          name: "Fake loopback",
          embed: `${base}/embeddings#fake`,
          rerank: `${base}/completions#fake`,
          expand: `${base}/chat/completions#fake`,
          gen: `${base}/chat/completions#fake`,
        },
      ],
    },
  };
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, "config", "index.yml"), JSON.stringify(config));
  const env = {
    ...(process.env as Record<string, string>),
    GNO_CONFIG_DIR: join(home, "config"),
    GNO_DATA_DIR: join(home, "data"),
    GNO_CACHE_DIR: join(home, "cache"),
  };
  return { home, env };
}

async function runGno(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function embedStageState(home: string): string | undefined {
  const db = new Database(join(home, "data", "index-default.sqlite"), {
    readonly: true,
  });
  try {
    const row = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM schema_meta WHERE key = ?"
      )
      .get("index_stage_state");
    return row
      ? (JSON.parse(row.value) as { embed?: { state: string } }).embed?.state
      : undefined;
  } finally {
    db.close();
  }
}

describe("gno embed bounded runs", () => {
  let server: FakeEmbedServer;
  const homes: string[] = [];

  beforeAll(() => {
    server = startFakeEmbedServer();
  });

  afterAll(async () => {
    server.stop();
    for (const home of homes) await safeRm(home);
  });

  test("--max-chunks stops at a batch boundary, exits 0, releases the lease and the next run finishes", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);

    const first = await runGno(
      env,
      "embed",
      "--max-chunks",
      "5",
      "--batch-size",
      "4",
      "--json"
    );
    expect(first.code).toBe(0);
    const receipt = JSON.parse(first.stdout);
    expect(receipt).toMatchObject({
      embedded: 8,
      errors: 0,
      stopped: "limit",
      remaining: DOC_COUNT - 8,
    });
    // Finished, not left `running` (which the next run would report as a crash).
    expect(embedStageState(home)).toBe("completed");

    // --no-wait proves the write lease was released.
    const second = await runGno(env, "embed", "--no-wait", "--json");
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("interrupted");
    const done = JSON.parse(second.stdout);
    expect(done).toMatchObject({ embedded: DOC_COUNT - 8, remaining: 0 });
    expect(done).not.toHaveProperty("stopped");
    expect(embedStageState(home)).toBe("completed");

    const human = await runGno(env, "embed", "--max-chunks", "5");
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("No chunks need embedding");
  }, 120_000);

  test("the human line reports what remains", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const run = await runGno(
      env,
      "embed",
      "--max-chunks",
      "3",
      "--batch-size",
      "3"
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      `Stopped at the run limit; ${DOC_COUNT - 3} chunks remaining.`
    );
  }, 120_000);

  test("--max-seconds stops after the batch that crosses the time limit", async () => {
    const slow = startFakeEmbedServer(600);
    try {
      const { home, env } = await writeHome(slow.port);
      homes.push(home);
      expect((await runGno(env, "update")).code).toBe(0);
      const run = await runGno(
        env,
        "embed",
        "--max-seconds",
        "1",
        "--batch-size",
        "2",
        "--json"
      );
      expect(run.code).toBe(0);
      const receipt = JSON.parse(run.stdout);
      expect(receipt.stopped).toBe("limit");
      expect(receipt.embedded % 2).toBe(0);
      expect(receipt.embedded).toBeGreaterThanOrEqual(2);
      expect(receipt.remaining).toBe(DOC_COUNT - receipt.embedded);
    } finally {
      slow.stop();
    }
  }, 120_000);

  test("a chunk that keeps failing does not block later chunks across bounded runs", async () => {
    const { home, env } = await writeHome(server.port, 1);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const slice = () =>
      runGno(env, "embed", "--max-chunks", "4", "--batch-size", "4", "--json");
    const receipts = [];
    for (let i = 0; i < 6; i += 1)
      receipts.push(JSON.parse((await slice()).stdout));
    // Every healthy chunk is embedded within a few slices; only the poisoned
    // one stays pending.
    expect(receipts.at(-1)?.remaining).toBe(1);
    const embedded = receipts.reduce((sum, r) => sum + r.embedded, 0);
    expect(embedded).toBe(DOC_COUNT - 1);
  }, 120_000);

  test("remaining counts the real backlog after an unbounded --force run that left work", async () => {
    const { home, env } = await writeHome(server.port, 1);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const first = JSON.parse((await runGno(env, "embed", "--json")).stdout);
    expect(first.remaining).toBe(1);
    const forced = JSON.parse(
      (await runGno(env, "embed", "--force", "--json")).stdout
    );
    expect(forced.errors).toBeGreaterThan(0);
    expect(forced.remaining).toBe(1);
  }, 120_000);

  test("retries that reach the limit leave the run stopped with failures pending", async () => {
    const { home, env } = await writeHome(server.port, 2);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const run = await runGno(
      env,
      "embed",
      "--max-chunks",
      "3",
      "--batch-size",
      "1",
      "--json"
    );
    expect(run.code).toBe(0);
    const receipt = JSON.parse(run.stdout);
    expect(receipt.stopped).toBe("limit");
    expect(receipt.remaining).toBe(DOC_COUNT - receipt.embedded);
  }, 120_000);

  test("a limit reached by the final retry is still a limit stop", async () => {
    const { home, env } = await writeHome(server.port, 1);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const run = await runGno(
      env,
      "embed",
      "--max-chunks",
      "2",
      "--batch-size",
      "1",
      "--json"
    );
    expect(run.code).toBe(0);
    const receipt = JSON.parse(run.stdout);
    expect(receipt.stopped).toBe("limit");
    expect(receipt.remaining).toBe(DOC_COUNT - receipt.embedded);
  }, 120_000);

  test("--force with a limit is a validation error", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);
    const run = await runGno(env, "embed", "--force", "--max-chunks", "5");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("cannot be combined with --force");
  }, 60_000);
});
