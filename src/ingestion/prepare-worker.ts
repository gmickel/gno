/**
 * Worker entry for per-file preparation (fn-198). See `file-worker.ts`.
 *
 * @module src/ingestion/prepare-worker
 */

import type { ConvertInput } from "../converters/types";
import type { FileWorkerMessage, FileWorkerRequest } from "./file-worker";

import { markdownConverter } from "../converters/native/markdown";
import { plaintextConverter } from "../converters/native/plaintext";
import { ConversionPipeline, getDefaultPipeline } from "../converters/pipeline";
import { ConverterRegistry } from "../converters/registry";
import { defaultChunker } from "./chunker";
import { PREPARE_PHASES, prepareFile } from "./prepare-file";

declare const self: Worker;

// Native files skip the default registry, whose PDF/Office adapters take
// about half a second to load. The default registry tries these two
// converters first, so the output is the same.
const nativeRegistry = new ConverterRegistry();
nativeRegistry.register(markdownConverter);
nativeRegistry.register(plaintextConverter);
const nativePipeline = new ConversionPipeline(nativeRegistry);

const convert = (input: ConvertInput) =>
  (nativeRegistry.select(input.mime, input.ext)
    ? nativePipeline
    : getDefaultPipeline()
  ).convert(input);

const post = (message: FileWorkerMessage): void => {
  self.postMessage(message);
};

self.onmessage = async (event: MessageEvent<FileWorkerRequest>) => {
  const { request, phaseSlot } = event.data;
  const outcome = await prepareFile(request, {
    convert,
    chunker: defaultChunker,
    onPrevious: (structure) => post({ type: "previous", structure }),
    // Progress goes through shared memory, not messages: the parent only
    // reads it when it stops a file.
    onPhase: (phase) => {
      Atomics.store(phaseSlot, 0, PREPARE_PHASES.indexOf(phase));
    },
    // The parent enforces the budget and terminates this worker.
    check: () => null,
  });
  post({ type: "done", outcome });
};
