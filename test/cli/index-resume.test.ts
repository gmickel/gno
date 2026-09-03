/**
 * Staged resumable indexing (fn-132 R4): real-process kill during the embed
 * stage, then resume without re-embedding; embed failure exits non-zero with a
 * per-stage receipt.
 *
 * The embedding model is a loopback OpenAI-compatible fake served by this test
 * (local_only egress permits loopback), so the CLI exercises its real HTTP
 * embedding port and the full `gno index` process path.
 *
 * @module test/cli/index-resume
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { markIndexStageRunning } from "../../src/embed/stage-state";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_COUNT = 100;
const BATCH_DELAY_MS = 400;
const DIMENSIONS = 4;

interface FakeEmbedServer {
  port: number;
  /** Texts embedded through batch (array-input) requests. */
  batchTexts: () => number;
  batchCalls: () => number;
  reset: () => void;
  stop: () => void;
}

function startFakeEmbedServer(): FakeEmbedServer {
  let batchTexts = 0;
  let batchCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (Array.isArray(body.input)) {
        batchCalls += 1;
        batchTexts += inputs.length;
        await Bun.sleep(BATCH_DELAY_MS);
      }
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
    batchTexts: () => batchTexts,
    batchCalls: () => batchCalls,
    reset: () => {
      batchTexts = 0;
      batchCalls = 0;
    },
    stop: () => server.stop(true),
  };
}

async function writeHome(
  port: number
): Promise<{ home: string; env: Record<string, string> }> {
  const home = await mkdtemp(join(tmpdir(), "gno-index-resume-"));
  const docs = join(home, "docs");
  await mkdir(docs, { recursive: true });
  for (let i = 1; i <= DOC_COUNT; i += 1) {
    await writeFile(
      join(docs, `d${i}.md`),
      `# Doc ${i}\n\nparagraph about topic ${i} and resumable indexing\n`
    );
  }
  const base = `http://127.0.0.1:${port}/v1`;
  const config = {
    version: "1.0",
    ftsTokenizer: "snowball english",
    busyTimeoutMs: 60_000,
    collections: [
      {
        name: "docs",
        path: docs,
        pattern: "**/*",
        include: [],
        exclude: [".git"],
      },
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

function spawnGno(env: Record<string, string>, ...args: string[]) {
  return Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runGno(env: Record<string, string>, ...args: string[]) {
  const proc = spawnGno(env, ...args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function countVectors(home: string): number {
  const db = new Database(join(home, "data", "index-default.sqlite"), {
    readonly: true,
  });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM content_vectors")
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

describe("gno index staged resume", () => {
  let server: FakeEmbedServer;
  let schema: object;
  const homes: string[] = [];

  beforeAll(async () => {
    server = startFakeEmbedServer();
    schema = await loadSchema("index-receipt");
  });

  afterAll(async () => {
    server.stop();
    for (const home of homes) {
      await safeRm(home);
    }
  });

  test("kill -9 during embed keeps lexical valid; rerun reports the interrupted stage and resumes without re-embedding", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);

    // First run: SIGKILL once the first embed batch has been persisted.
    const first = spawnGno(env, "index", "--json");
    const deadline = Date.now() + 30_000;
    while (server.batchCalls() < 1 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    await Bun.sleep(BATCH_DELAY_MS + 150);
    first.kill("SIGKILL");
    await first.exited;
    expect(first.signalCode).toBe("SIGKILL");

    const embeddedBeforeKill = countVectors(home);
    expect(embeddedBeforeKill).toBeGreaterThan(0);
    expect(embeddedBeforeKill).toBeLessThan(DOC_COUNT);

    // Lexical stage is intact: keyword search works on the killed index.
    const search = await runGno(env, "search", "resumable indexing", "--json");
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).results.length).toBeGreaterThan(0);

    // Human preamble on the rerun names the interrupted embed stage.
    server.reset();
    const rerun = await runGno(env, "index");
    expect(rerun.code).toBe(0);
    expect(rerun.stderr).toContain("interrupted during the embed stage");
    expect(rerun.stdout).toContain("Indexing complete.");

    // Only the remaining backlog went to the model: no re-embedding.
    expect(server.batchTexts()).toBe(DOC_COUNT - embeddedBeforeKill);
    expect(countVectors(home)).toBe(DOC_COUNT);

    // A clean third run starts without a resume marker.
    const clean = await runGno(env, "index", "--json");
    expect(clean.code).toBe(0);
    const receipt = JSON.parse(clean.stdout);
    expect(assertValid(receipt, schema)).toBe(true);
    expect(receipt.resumedFrom).toBeNull();
    expect(receipt.stages.embed).toMatchObject({
      state: "completed",
      embedded: 0,
    });
  }, 120_000);

  test("index --no-embed settles a stale embed marker so later runs stop reporting the interruption", async () => {
    const { home, env } = await writeHome(server.port);
    homes.push(home);

    const initial = await runGno(env, "index", "--no-embed", "--json");
    expect(initial.code).toBe(0);

    // A killed embed run leaves `embed: running` behind.
    const db = new Database(join(home, "data", "index-default.sqlite"));
    try {
      markIndexStageRunning(db, "embed");
    } finally {
      db.close();
    }

    // The first lexical-only run surfaces it once...
    const first = await runGno(env, "index", "--no-embed");
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("interrupted during the embed stage");

    // ...and settles it: the next run starts clean.
    const second = await runGno(env, "index", "--no-embed", "--json");
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("interrupted");
    expect(JSON.parse(second.stdout).resumedFrom).toBeNull();
  }, 120_000);

  test("embed stage failure exits non-zero with a per-stage receipt (lexical completed, embed failed)", async () => {
    const dead = startFakeEmbedServer();
    const { home, env } = await writeHome(dead.port);
    homes.push(home);
    dead.stop();

    const result = await runGno(env, "index", "--json");
    expect(result.code).toBe(2);
    const receipt = JSON.parse(result.stdout);
    expect(assertValid(receipt, schema)).toBe(true);
    expect(receipt).toMatchObject({
      success: false,
      stages: {
        lexical: { state: "completed", filesAdded: DOC_COUNT },
        embed: { state: "failed" },
      },
      resumedFrom: null,
      embedSkipped: false,
    });
    expect(receipt.error).toContain("Embed stage failed");

    // The lexical work of the failed run is kept: the next run syncs nothing new.
    const noEmbed = await runGno(env, "index", "--no-embed", "--json");
    expect(noEmbed.code).toBe(0);
    const skipped = JSON.parse(noEmbed.stdout);
    expect(skipped.stages.lexical).toMatchObject({
      state: "completed",
      filesAdded: 0,
    });
    expect(skipped.stages.embed).toMatchObject({
      state: "skipped",
      reason: "--no-embed",
    });
    expect(skipped.resumedFrom).toBeNull();
  }, 120_000);
});
