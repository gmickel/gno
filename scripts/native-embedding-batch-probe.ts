#!/usr/bin/env bun
/**
 * Probe node-llama-cpp internals for true native multi-sequence embedding.
 *
 * This is intentionally a development-only probe. It verifies whether the
 * installed node-llama-cpp binding can evaluate multiple embedding sequences in
 * one native batch and then retrieve a distinct embedding vector for each
 * sequence.
 */

import { createDefaultConfig } from "../src/config";
import { LlmAdapter } from "../src/llm/nodeLlamaCpp/adapter";

interface ProbeArgs {
  allowDownload: boolean;
  model?: string;
  sequences: number;
}

interface InternalModel {
  createContext(options: Record<string, unknown>): Promise<InternalContext>;
  tokenize(text: string): number[];
}

interface InternalContext {
  readonly batchSize: number;
  readonly totalSequences: number;
  _ctx: {
    getEmbedding(
      inputTokensLength: number,
      maxVectorSize?: number
    ): Float64Array;
  };
  dispose(): Promise<void>;
  getSequence(): InternalSequence;
}

interface InternalSequence {
  readonly _sequenceId: number;
  readonly nextTokenIndex: number;
  dispose(): void;
  evaluateWithoutGeneratingNewTokens(
    tokens: number[],
    options?: Record<string, unknown>
  ): Promise<void>;
}

interface InternalEmbeddingPort {
  readonly modelUri: string;
  dimensions(): number;
  dispose(): Promise<void>;
  init(): Promise<{ ok: true; value: void } | { ok: false; error: Error }>;
  llamaModel?: InternalModel;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = {
    allowDownload: false,
    model: undefined,
    sequences: 4,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--allow-download":
        args.allowDownload = true;
        break;
      case "--model":
        args.model = argv[(i += 1)];
        break;
      case "--sequences":
        args.sequences = parsePositiveInt(argv[(i += 1)], args.sequences);
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
  console.log(`Native embedding batch probe

Usage:
  bun scripts/native-embedding-batch-probe.ts [options]

Options:
  --model <uri>      Model URI/path (default: active/default embed model)
  --allow-download   Allow model download if not cached
  --sequences <n>    Native context sequences to probe (default: 4)
`);
}

function formatPrefix(values: Float64Array, length = 5): string {
  return Array.from(values.slice(0, length))
    .map((value) => value.toFixed(4))
    .join(", ");
}

const args = parseArgs(Bun.argv.slice(2));
const adapter = new LlmAdapter(createDefaultConfig());
const portResult = await adapter.createEmbeddingPort(args.model, {
  policy: {
    allowDownload: args.allowDownload,
    offline: !args.allowDownload,
  },
});

if (!portResult.ok) {
  throw new Error(portResult.error.message);
}

const port = portResult.value as unknown as InternalEmbeddingPort;
try {
  const initResult = await port.init();
  if (!initResult.ok) {
    throw new Error(initResult.error.message);
  }

  const model = port.llamaModel;
  if (!model) {
    throw new Error("Embedding model internals unavailable after init");
  }

  const context = await model.createContext({
    _embeddings: true,
    batchSize: 512,
    contextSize: 256,
    sequences: args.sequences,
  });

  try {
    const texts = Array.from(
      { length: args.sequences },
      (_, index) =>
        `native batch probe document ${index} ${"token ".repeat(16)}`
    );
    const sequences = texts.map(() => context.getSequence());
    const started = performance.now();
    await Promise.all(
      sequences.map((sequence, index) =>
        sequence.evaluateWithoutGeneratingNewTokens(
          model.tokenize(texts[index] ?? "")
        )
      )
    );
    const durationMs = performance.now() - started;

    console.log(`Model: ${port.modelUri}`);
    console.log(`Context sequences: ${context.totalSequences}`);
    console.log(`Native batch size: ${context.batchSize}`);
    console.log(`Decode duration: ${(durationMs / 1000).toFixed(3)}s`);
    console.log("");
    console.log(
      "| sequence | token length | getEmbedding(len) | getEmbedding(len, seqId) length |"
    );
    console.log("| ---: | ---: | --- | ---: |");

    let distinctRetrievalSupported = true;
    for (const sequence of sequences) {
      const defaultVector = context._ctx.getEmbedding(sequence.nextTokenIndex);
      const seqVector = context._ctx.getEmbedding(
        sequence.nextTokenIndex,
        sequence._sequenceId
      );
      if (seqVector.length !== port.dimensions()) {
        distinctRetrievalSupported = false;
      }
      console.log(
        `| ${sequence._sequenceId} | ${sequence.nextTokenIndex} | ${formatPrefix(defaultVector)} | ${seqVector.length} |`
      );
      sequence.dispose();
    }

    console.log("");
    if (distinctRetrievalSupported) {
      console.log(
        "Result: native per-sequence embedding retrieval appears supported."
      );
    } else {
      console.log(
        "Result: blocked. The binding's second getEmbedding argument is maxVectorSize, not sequence id."
      );
    }
  } finally {
    await context.dispose();
  }
} finally {
  await port.dispose();
  await adapter.dispose();
}
