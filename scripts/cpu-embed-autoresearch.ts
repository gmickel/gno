#!/usr/bin/env bun
/**
 * CPU embedding autoresearch harness.
 *
 * This script benchmarks the scheduling behavior of GNO's native embedding
 * context pool without requiring a local GGUF model. It uses delayed mock
 * embedding contexts to measure the throughput impact of context-count choices
 * and prints the same Windows memory heuristic that production uses.
 */

// Bun does not expose total system memory; node:os is the narrow runtime API.
import { totalmem } from "node:os";

import {
  NodeLlamaCppEmbedding,
  resolveEmbeddingContextPoolSize,
} from "../src/llm/nodeLlamaCpp/embedding";

interface Args {
  chunks: number;
  delayMs: number;
  dimensions: number;
  contexts: number[];
  cpuCores: number;
}

interface BenchmarkResult {
  contexts: number;
  durationMs: number;
  chunksPerSecond: number;
  speedup: number;
}

const DEFAULT_CONTEXTS = [1, 2, 4];
const BYTES_PER_GIB = 1024 * 1024 * 1024;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    chunks: 256,
    delayMs: 40,
    dimensions: 1024,
    contexts: DEFAULT_CONTEXTS,
    cpuCores: navigator.hardwareConcurrency || 8,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--chunks":
        args.chunks = parsePositiveInt(argv[(i += 1)], args.chunks);
        break;
      case "--delay-ms":
        args.delayMs = parsePositiveInt(argv[(i += 1)], args.delayMs);
        break;
      case "--dimensions":
        args.dimensions = parsePositiveInt(argv[(i += 1)], args.dimensions);
        break;
      case "--cpu-cores":
        args.cpuCores = parsePositiveInt(argv[(i += 1)], args.cpuCores);
        break;
      case "--contexts":
        args.contexts = (argv[(i += 1)] ?? "")
          .split(",")
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (args.contexts.length === 0) {
          args.contexts = DEFAULT_CONTEXTS;
        }
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`CPU embedding autoresearch

Usage:
  bun scripts/cpu-embed-autoresearch.ts [options]

Options:
  --chunks <n>       Synthetic chunks to embed (default: 256)
  --delay-ms <n>     Per-chunk mock native latency (default: 40)
  --dimensions <n>   Mock vector dimensions (default: 1024)
  --contexts <csv>   Context counts to compare (default: 1,2,4)
  --cpu-cores <n>    CPU core count for heuristic display
`);
}

function createManager(options: {
  contexts: number;
  cpuCores: number;
  delayMs: number;
  dimensions: number;
}) {
  let created = 0;
  const vector = Array.from({ length: options.dimensions }, (_, index) =>
    index % 2 === 0 ? 0.1 : -0.1
  );

  return {
    getLlama: async () => ({
      cpuMathCores: options.cpuCores,
      gpu: false,
    }),
    loadModel: async () => ({
      ok: true as const,
      value: {
        model: {
          embeddingVectorSize: options.dimensions,
          trainContextSize: 2_048,
          tokenize: (text: string) => text.split(""),
          detokenize: (tokens: readonly string[]) => tokens.join(""),
          createEmbeddingContext: async () => {
            created += 1;
            if (created > options.contexts) {
              throw new Error("context limit reached");
            }
            return {
              dispose: async () => undefined,
              getEmbeddingFor: async () => {
                await Bun.sleep(options.delayMs);
                return { vector };
              },
            };
          },
        },
      },
    }),
  };
}

async function runVariant(
  args: Args,
  contexts: number
): Promise<BenchmarkResult> {
  const previousOverride = process.env.GNO_EMBED_CONTEXTS;
  process.env.GNO_EMBED_CONTEXTS = String(contexts);
  const manager = createManager({
    contexts,
    cpuCores: args.cpuCores,
    delayMs: args.delayMs,
    dimensions: args.dimensions,
  });
  const embedding = new NodeLlamaCppEmbedding(
    manager as never,
    "synthetic-cpu-embed",
    "/tmp/synthetic.gguf"
  );
  const texts = Array.from({ length: args.chunks }, (_, index) => {
    const suffix = index.toString().padStart(4, "0");
    return `title: synthetic-${suffix} | text: ${"token ".repeat(96)}`;
  });

  const started = performance.now();
  const result = await embedding.embedBatch(texts);
  const durationMs = performance.now() - started;
  await embedding.dispose();
  if (previousOverride === undefined) {
    delete process.env.GNO_EMBED_CONTEXTS;
  } else {
    process.env.GNO_EMBED_CONTEXTS = previousOverride;
  }

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return {
    contexts,
    durationMs,
    chunksPerSecond: args.chunks / (durationMs / 1000),
    speedup: 1,
  };
}

function printHeuristic(args: Args): void {
  const memoryCases = [12, 16, 24, Math.round(totalmem() / BYTES_PER_GIB)];
  console.log("Windows CPU context heuristic:");
  for (const gib of [...new Set(memoryCases)].sort((a, b) => a - b)) {
    const pool = resolveEmbeddingContextPoolSize({
      gpu: false,
      cpuMathCores: args.cpuCores,
      platformName: "win32",
      totalMemoryBytes: gib * BYTES_PER_GIB,
    });
    console.log(`  ${gib} GiB, ${args.cpuCores} cores -> ${pool} context(s)`);
  }
  console.log("");
}

function printResults(results: BenchmarkResult[]): void {
  const baseline = results[0]?.chunksPerSecond ?? 1;
  console.log("| contexts | duration | chunks/s | speedup |");
  console.log("| ---: | ---: | ---: | ---: |");
  for (const result of results) {
    result.speedup = result.chunksPerSecond / baseline;
    console.log(
      `| ${result.contexts} | ${(result.durationMs / 1000).toFixed(2)}s | ${result.chunksPerSecond.toFixed(1)} | ${result.speedup.toFixed(2)}x |`
    );
  }
}

const args = parseArgs(Bun.argv.slice(2));
printHeuristic(args);

const results: BenchmarkResult[] = [];
for (const contexts of args.contexts) {
  results.push(await runVariant(args, contexts));
}

printResults(results);
