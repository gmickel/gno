/**
 * Session import throughput benchmark (fn-186 R1).
 *
 * Generates a synthetic Codex session corpus (placeholder text only, never
 * real sessions) at several sizes inside an isolated temp root, imports it
 * through the public SessionsService, and reports import time, per-turn cost
 * and peak memory. Each size runs in its own child process so peak RSS is
 * per size and a slow size can be capped without losing the others.
 *
 * Usage:
 *   bun scripts/session-import-benchmark.ts                  # 30,90,300 x 200
 *   bun scripts/session-import-benchmark.ts --threads 10,30 --turns 200
 *   bun scripts/session-import-benchmark.ts --cap-seconds 600
 *
 * A size that exceeds --cap-seconds is reported as capped, not measured.
 * The temp root is deleted after every size, capped or not.
 */

// node:fs/promises for mkdir/mkdtemp (filesystem structure ops)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { initStore } from "../src/cli/commands/shared";
import { SessionsService } from "../src/sessions/service";
import { addSessionSource, initSessionArchive } from "../src/sessions/setup";
import { safeRm } from "../test/helpers/cleanup";
import { writeSyntheticCodexRollouts } from "../test/sessions/helpers";

interface SizeResult {
  threads: number;
  turns: number;
  records: number;
  seconds: number;
  msPerTurn: number;
  peakRssMb: number;
  status: string;
}

const RSS_SAMPLE_MS = 50;
const MB = 1024 * 1024;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function runSize(
  root: string,
  threads: number,
  turns: number
): Promise<SizeResult> {
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  const sourceRoot = join(root, "sources", "codex");
  await mkdir(sourceRoot, { recursive: true });
  await writeSyntheticCodexRollouts(sourceRoot, threads, turns);
  const configPath = join(root, "config.yml");
  const indexName = "session-bench";
  await initSessionArchive({
    configPath,
    indexName,
    archiveRoot: join(root, "archive"),
    collection: "sessions",
  });
  await addSessionSource({
    configPath,
    id: "codex-bench",
    harness: "codex",
    path: sourceRoot,
    collection: "sessions",
  });
  const opened = await initStore({
    configPath,
    indexName,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(opened.error);
  const service = new SessionsService({
    config: opened.config,
    configPath,
    indexName,
    store: opened.store,
  });

  let peakRss = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, RSS_SAMPLE_MS);
  const started = performance.now();
  let status: string;
  try {
    const receipt = await service.import(
      { sourceId: "codex-bench" },
      { allowPaths: false }
    );
    status = `${receipt.status}/${receipt.lexical.status}`;
  } finally {
    clearInterval(sampler);
  }
  const seconds = (performance.now() - started) / 1000;
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  const records = opened.store
    .getRawDb()
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM documents WHERE active = 1"
    )
    .get()?.n;
  await opened.store.close();
  return {
    threads,
    turns,
    records: records ?? 0,
    seconds,
    msPerTurn: (seconds * 1000) / (threads * turns),
    peakRssMb: peakRss / MB,
    status,
  };
}

async function runChild(
  threads: number,
  turns: number,
  capSeconds: number
): Promise<SizeResult> {
  // The parent owns the temp root so a capped (killed) child leaves nothing.
  const root = await mkdtemp(join(tmpdir(), "gno-session-bench-"));
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "--child",
      "--root",
      root,
      "--threads",
      String(threads),
      "--turns",
      String(turns),
    ],
    { stdout: "pipe", stderr: "inherit" }
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), capSeconds * 1000);
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  clearTimeout(timer);
  await safeRm(root);
  const line = output.trim().split("\n").at(-1) ?? "";
  if (code === 0 && line.startsWith("{")) return JSON.parse(line) as SizeResult;
  return {
    threads,
    turns,
    records: threads * turns * 2,
    seconds: capSeconds,
    msPerTurn: Number.NaN,
    peakRssMb: Number.NaN,
    status: code === 0 ? "no-result" : `capped>${capSeconds}s`,
  };
}

async function main(): Promise<void> {
  const turns = Number(flag("--turns", "200"));
  if (process.argv.includes("--child")) {
    const threads = Number(flag("--threads", "30"));
    const root = flag("--root", "");
    if (!root) throw new Error("--child needs --root");
    console.log(JSON.stringify(await runSize(root, threads, turns)));
    return;
  }
  const sizes = flag("--threads", "30,90,300").split(",").map(Number);
  const capSeconds = Number(flag("--cap-seconds", "1800"));
  const results: SizeResult[] = [];
  for (const threads of sizes) {
    const result = await runChild(threads, turns, capSeconds);
    results.push(result);
    console.error(
      `threads=${threads} turns=${turns}: ${result.seconds.toFixed(1)}s (${result.status})`
    );
  }
  console.log(
    "| threads | turns | records | import s | ms/turn | peak RSS MB | status |"
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    console.log(
      `| ${r.threads} | ${r.turns} | ${r.records} | ${r.seconds.toFixed(1)} | ${r.msPerTurn.toFixed(2)} | ${r.peakRssMb.toFixed(0)} | ${r.status} |`
    );
  }
  const first = results[0];
  const last = results.at(-1);
  if (first && last && first !== last) {
    console.log(
      `per-turn ratio largest/smallest: ${(last.msPerTurn / first.msPerTurn).toFixed(2)}`
    );
  }
}

await main();
