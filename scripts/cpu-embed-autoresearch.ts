#!/usr/bin/env bun
/**
 * CPU embedding autoresearch harness.
 *
 * By default this script benchmarks GNO's embedding context-pool scheduler
 * without requiring a local GGUF model. Use --real to run the same benchmark
 * through the production LlmAdapter, ModelCache, NodeLlamaCppEmbedding, and
 * node-llama-cpp code path with a cached or downloadable GGUF model.
 */

// Bun does not expose total system memory; node:os is the narrow runtime API.
import { totalmem } from "node:os";

import { createDefaultConfig, loadConfig } from "../src/config";
import { LlmAdapter } from "../src/llm/nodeLlamaCpp/adapter";
import {
  NodeLlamaCppEmbedding,
  resolveEmbeddingContextPoolSize,
} from "../src/llm/nodeLlamaCpp/embedding";

interface Args {
  allowDownload: boolean;
  chunks: number;
  configPath?: string;
  contextSize?: number;
  delayMs: number;
  dimensions: number;
  contexts: number[];
  cpuCores: number;
  model?: string;
  real: boolean;
  threads?: number;
  warmup: number;
}

interface BenchmarkResult {
  contexts: number;
  durationMs: number;
  initMs?: number;
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

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    allowDownload: false,
    chunks: 256,
    configPath: undefined,
    contextSize: undefined,
    delayMs: 40,
    dimensions: 1024,
    contexts: DEFAULT_CONTEXTS,
    cpuCores: navigator.hardwareConcurrency || 8,
    model: undefined,
    real: false,
    threads: undefined,
    warmup: 8,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--chunks":
        args.chunks = parsePositiveInt(argv[(i += 1)], args.chunks);
        break;
      case "--config":
        args.configPath = argv[(i += 1)];
        break;
      case "--context-size":
        args.contextSize = parsePositiveInt(argv[(i += 1)], 2_048);
        break;
      case "--delay-ms":
        args.delayMs = parsePositiveInt(argv[(i += 1)], args.delayMs);
        break;
      case "--dimensions":
        args.dimensions = parsePositiveInt(argv[(i += 1)], args.dimensions);
        break;
      case "--model":
        args.model = argv[(i += 1)];
        break;
      case "--cpu-cores":
        args.cpuCores = parsePositiveInt(argv[(i += 1)], args.cpuCores);
        break;
      case "--threads":
        args.threads = parsePositiveInt(argv[(i += 1)], args.cpuCores);
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
      case "--allow-download":
        args.allowDownload = true;
        break;
      case "--real":
        args.real = true;
        break;
      case "--warmup":
        args.warmup = parseNonNegativeInt(argv[(i += 1)], args.warmup);
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
  --real             Use production GGUF embedding path instead of synthetic mocks
  --model <uri>      Model URI/path for --real (default: active/default embed model)
  --allow-download   Allow --real to download the model if not cached
  --config <path>    Config path for --real model preset resolution
  --context-size <n> GNO_EMBED_CONTEXT_SIZE override for --real
  --warmup <n>       Warmup chunks before timing --real (default: 8)
  --delay-ms <n>     Per-chunk mock native latency (default: 40)
  --dimensions <n>   Mock vector dimensions (default: 1024)
  --contexts <csv>   Context counts to compare (default: 1,2,4)
  --cpu-cores <n>    CPU core count for heuristic display
  --threads <n>      GNO_EMBED_THREADS override for --real
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

async function createRealEmbeddingPort(args: Args) {
  const config =
    args.configPath === undefined
      ? createDefaultConfig()
      : await loadConfig(args.configPath).then((result) => {
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        });
  const adapter = new LlmAdapter(config);
  const portResult = await adapter.createEmbeddingPort(args.model, {
    policy: {
      allowDownload: args.allowDownload,
      offline: !args.allowDownload,
    },
  });
  if (!portResult.ok) {
    await adapter.dispose();
    throw new Error(portResult.error.message);
  }
  return { adapter, port: portResult.value };
}

async function runRealVariant(
  args: Args,
  contexts: number,
  texts: string[]
): Promise<BenchmarkResult> {
  const previousOverride = process.env.GNO_EMBED_CONTEXTS;
  const previousThreads = process.env.GNO_EMBED_THREADS;
  const previousContextSize = process.env.GNO_EMBED_CONTEXT_SIZE;
  process.env.GNO_EMBED_CONTEXTS = String(contexts);
  if (args.threads !== undefined) {
    process.env.GNO_EMBED_THREADS = String(args.threads);
  }
  if (args.contextSize !== undefined) {
    process.env.GNO_EMBED_CONTEXT_SIZE = String(args.contextSize);
  }
  const { adapter, port } = await createRealEmbeddingPort(args);

  try {
    const initStarted = performance.now();
    const initResult = await port.init();
    const initMs = performance.now() - initStarted;
    if (!initResult.ok) {
      throw new Error(initResult.error.message);
    }

    if (args.warmup > 0) {
      const warmupTexts = texts.slice(0, Math.min(args.warmup, texts.length));
      const warmupResult = await port.embedBatch(warmupTexts);
      if (!warmupResult.ok) {
        throw new Error(warmupResult.error.message);
      }
    }

    const started = performance.now();
    const result = await port.embedBatch(texts);
    const durationMs = performance.now() - started;
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return {
      contexts,
      durationMs,
      initMs,
      chunksPerSecond: args.chunks / (durationMs / 1000),
      speedup: 1,
    };
  } finally {
    await port.dispose();
    await adapter.dispose();
    if (previousOverride === undefined) {
      delete process.env.GNO_EMBED_CONTEXTS;
    } else {
      process.env.GNO_EMBED_CONTEXTS = previousOverride;
    }
    if (previousThreads === undefined) {
      delete process.env.GNO_EMBED_THREADS;
    } else {
      process.env.GNO_EMBED_THREADS = previousThreads;
    }
    if (previousContextSize === undefined) {
      delete process.env.GNO_EMBED_CONTEXT_SIZE;
    } else {
      process.env.GNO_EMBED_CONTEXT_SIZE = previousContextSize;
    }
  }
}

function createBenchmarkTexts(chunks: number): string[] {
  return Array.from({ length: chunks }, (_, index) => {
    const suffix = index.toString().padStart(4, "0");
    const body = [
      "CPU embedding benchmark chunk",
      suffix,
      "with mixed prose, code identifiers, filenames, and repeated project terms.",
      "The benchmark intentionally resembles indexed note chunks rather than one-word inputs.",
      "query embedding retrieval sqlite vector llama context scheduling windows cpu throughput",
    ].join(" ");
    return `title: cpu-embed-${suffix}\ntext: ${body}`;
  });
}

function printHeuristic(args: Args): void {
  const mode = args.real ? "real GGUF path" : "synthetic scheduler path";
  console.log(`Mode: ${mode}`);
  if (args.real) {
    console.log(
      `Model: ${args.model ?? "active/default embed model"}; warmup: ${args.warmup} chunk(s)`
    );
    if (args.threads !== undefined) {
      console.log(`Threads per context override: ${args.threads}`);
    }
    if (args.contextSize !== undefined) {
      console.log(`Context size override: ${args.contextSize}`);
    }
  }
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
  const hasInit = results.some((result) => result.initMs !== undefined);
  if (hasInit) {
    console.log("| contexts | init | embed duration | chunks/s | speedup |");
    console.log("| ---: | ---: | ---: | ---: | ---: |");
  } else {
    console.log("| contexts | duration | chunks/s | speedup |");
    console.log("| ---: | ---: | ---: | ---: |");
  }
  for (const result of results) {
    result.speedup = result.chunksPerSecond / baseline;
    if (hasInit) {
      console.log(
        `| ${result.contexts} | ${((result.initMs ?? 0) / 1000).toFixed(2)}s | ${(result.durationMs / 1000).toFixed(2)}s | ${result.chunksPerSecond.toFixed(1)} | ${result.speedup.toFixed(2)}x |`
      );
    } else {
      console.log(
        `| ${result.contexts} | ${(result.durationMs / 1000).toFixed(2)}s | ${result.chunksPerSecond.toFixed(1)} | ${result.speedup.toFixed(2)}x |`
      );
    }
  }
}

const args = parseArgs(Bun.argv.slice(2));
printHeuristic(args);

const results: BenchmarkResult[] = [];
const texts = createBenchmarkTexts(args.chunks);
for (const contexts of args.contexts) {
  if (args.real) {
    results.push(await runRealVariant(args, contexts, texts));
  } else {
    results.push(await runVariant(args, contexts));
  }
}

printResults(results);
