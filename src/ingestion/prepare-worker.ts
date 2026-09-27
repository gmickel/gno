/**
 * Worker entry for per-file preparation (fn-198). See `file-processor.ts`.
 *
 * @module src/ingestion/prepare-worker
 */

import type {
  FileWorkerMessage,
  FileWorkerRequest,
  ReadyMessage,
} from "./file-processor";

import { defaultChunker } from "./chunker";
import { convertForPreparation } from "./prepare-convert";
import { PREPARE_PHASES, prepareFile } from "./prepare-file";

declare const self: Worker;

const post = (message: FileWorkerMessage | ReadyMessage): void => {
  self.postMessage(message);
};

self.onmessage = async (event: MessageEvent<FileWorkerRequest>) => {
  // Only the parent that created this worker may drive it; a Bun Worker sees
  // its parent's messages with an empty origin.
  if (event.origin !== "") return;
  const { request, phaseSlot } = event.data;
  const outcome = await prepareFile(request, {
    convert: convertForPreparation,
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

post({ type: "ready" });
