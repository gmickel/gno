#!/usr/bin/env bun
// node:fs/promises for benchmark artifact directories.
import { mkdir } from "node:fs/promises";
// node:path for artifact path handling.
import { join } from "node:path";

import {
  FIXTURE_ROOT,
  runAstChunkingBenchmark,
  toAstChunkingMarkdown,
} from "./ast-chunking/benchmark";
export { runAstChunkingBenchmark } from "./ast-chunking/benchmark";
export { chunkWithTreeSitterFallback } from "./ast-chunking/chunker";

function parseArgs(args: string[]): {
  fixture: string;
  out?: string;
  write: boolean;
} {
  const options = {
    fixture: "canonical",
    write: false,
    out: undefined as string | undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    switch (arg) {
      case "--fixture":
        options.fixture = args[++index] ?? options.fixture;
        break;
      case "--out":
        options.out = args[++index];
        break;
      case "--write":
        options.write = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runAstChunkingBenchmark({ fixture: options.fixture });
  console.log(
    `AST ${summary.decision.recommendation}: heuristic nDCG@10=${summary.modes.heuristic.metrics.ndcgAt10.toFixed(3)} ast nDCG@10=${summary.modes.ast.metrics.ndcgAt10.toFixed(3)}`
  );

  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.write) {
    const outDir = join(FIXTURE_ROOT, "ast-chunking");
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, "latest.json"), json);
    await Bun.write(join(outDir, "latest.md"), toAstChunkingMarkdown(summary));
  }
  if (options.out) {
    await Bun.write(options.out, json);
  }
}
