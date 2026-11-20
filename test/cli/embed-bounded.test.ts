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
// Bun has no temporary-directory creation API (structure ops only; file
// contents are written with Bun.write).
import { mkdtemp } from "node:fs/promises";
// Bun has no OS temp-directory lookup.
import { tmpdir } from "node:os";
// Bun has no path utilities.
import { join, resolve } from "node:path";

import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const DOC_COUNT = 20;
const DIMENSIONS = 4;

interface FakeEmbedServer {
  port: number;
  texts: () => string[];
  poisonRequests: () => number;
  stop: () => void;
}

/**
 * Fails every request that contains the text "poison"; with `failBatches`,
 * also every request that submits more than one text.
 */
function startFakeEmbedServer(
  delayMs = 0,
  failBatches = false
): FakeEmbedServer {
  const texts: string[] = [];
  let poisonRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (delayMs) await Bun.sleep(delayMs);
      if (inputs.some((text) => text.includes("poison"))) {
        poisonRequests += 1;
        return new Response("injected failure", { status: 500 });
      }
      if (failBatches && inputs.length > 1)
        return new Response("injected batch failure", { status: 500 });
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
    poisonRequests: () => poisonRequests,
    stop: () => server.stop(true),
  };
}

async function writeHome(port: number, poison = 0) {
  const home = await mkdtemp(join(tmpdir(), "gno-embed-bounded-"));
  const docs = join(home, "docs");
  // Bun.write creates the missing parent directories.
  for (let i = 1; i <= DOC_COUNT; i += 1) {
    const body = i <= poison ? "poison" : `paragraph about bounded topic ${i}`;
    await Bun.write(
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
  await Bun.write(join(home, "config", "index.yml"), JSON.stringify(config));
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
  let receiptSchema: object;
  const homes: string[] = [];

  beforeAll(async () => {
    server = startFakeEmbedServer();
    receiptSchema = await loadSchema("embed-receipt");
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
    expect(assertValid(receipt, receiptSchema)).toBe(true);
    // Finished, not left `running` (which the next run would report as a crash).
    expect(embedStageState(home)).toBe("completed");

    const dry = await runGno(
      env,
      "embed",
      "--dry-run",
      "--max-chunks",
      "5",
      "--json"
    );
    expect(dry.code).toBe(0);
    const dryReceipt = JSON.parse(dry.stdout);
    expect(dryReceipt).toMatchObject({ embedded: DOC_COUNT - 8 });
    expect(dryReceipt).not.toHaveProperty("remaining");
    expect(assertValid(dryReceipt, receiptSchema)).toBe(true);

    // --no-wait proves the write lease was released.
    const second = await runGno(env, "embed", "--no-wait", "--json");
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("interrupted");
    const done = JSON.parse(second.stdout);
    expect(done).toMatchObject({ embedded: DOC_COUNT - 8, remaining: 0 });
    expect(done).not.toHaveProperty("stopped");
    expect(assertValid(done, receiptSchema)).toBe(true);
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
    // Leave only the poisoned chunk pending.
    const seed = JSON.parse((await runGno(env, "embed", "--json")).stdout);
    expect(seed.remaining).toBe(1);
    const before = server.poisonRequests();
    const run = await runGno(
      env,
      "embed",
      "--max-chunks",
      "4",
      "--batch-size",
      "1",
      "--json"
    );
    expect(run.code).toBe(0);
    // Each attempt submits the chunk three times (the batch, then alone, then
    // alone after a model reset). The first attempt spends 3 of the 4, so only
    // the final retry drain reaches the limit: two attempts, six submissions.
    expect(server.poisonRequests() - before).toBe(6);
    expect(JSON.parse(run.stdout)).toMatchObject({
      stopped: "limit",
      remaining: 1,
    });
  }, 120_000);

  test("a deferred vec index sync is kept across stopped slices and settled by a complete run", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);
    expect((await runGno(env, "update")).code).toBe(0);
    const key = `embed_vec_sync_owed:http://127.0.0.1:${server.port}/v1/embeddings#fake`;
    const meta = (value?: string) => {
      const db = new Database(join(home, "data", "index-default.sqlite"));
      try {
        if (value !== undefined)
          db.run(
            "INSERT OR REPLACE INTO schema_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            [key, value]
          );
        return (
          db
            .query<{ value: string }, [string]>(
              "SELECT value FROM schema_meta WHERE key = ?"
            )
            .get(key)?.value ?? null
        );
      } finally {
        db.close();
      }
    };
    meta("1");
    for (let i = 0; i < 2; i += 1) {
      const slice = await runGno(
        env,
        "embed",
        "--max-chunks",
        "4",
        "--batch-size",
        "4",
        "--json"
      );
      expect(slice.code).toBe(0);
      const receipt = JSON.parse(slice.stdout);
      expect(receipt.stopped).toBe("limit");
      expect(receipt.suggestion).toContain("gno vec sync");
      expect(meta()).toBe("1");
    }
    const done = await runGno(env, "embed", "--json");
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout).remaining).toBe(0);
    expect(meta()).toBeNull();
  }, 120_000);

  test("recovery resubmissions count toward --max-chunks", async () => {
    // Pairs fail; single chunks succeed. The first two-chunk batch costs four
    // submissions (the pair, then each chunk alone), which reaches a limit of
    // three, so the next batch stays pending.
    const pairsFail = startFakeEmbedServer(0, true);
    try {
      const { home, env } = await writeHome(pairsFail.port);
      homes.push(home);
      expect((await runGno(env, "update")).code).toBe(0);
      const run = await runGno(
        env,
        "embed",
        "--max-chunks",
        "3",
        "--batch-size",
        "2",
        "--json"
      );
      expect(run.code).toBe(0);
      const receipt = JSON.parse(run.stdout);
      expect(receipt).toMatchObject({
        embedded: 2,
        errors: 0,
        stopped: "limit",
        remaining: DOC_COUNT - 2,
      });
      expect(assertValid(receipt, receiptSchema)).toBe(true);
      // Only the first batch's two chunks were embedded (one at a time);
      // the other texts are the port's dimension probes.
      expect(
        pairsFail.texts().filter((text) => text.includes("bounded topic"))
      ).toHaveLength(2);
    } finally {
      pairsFail.stop();
    }
  }, 120_000);

  test("--force with a limit is a validation error", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);
    const run = await runGno(env, "embed", "--force", "--max-chunks", "5");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("cannot be combined with --force");
  }, 60_000);
});
