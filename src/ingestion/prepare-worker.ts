/**
 * Worker entry for per-file preparation (fn-198). See `file-processor.ts`.
 *
 * @module src/ingestion/prepare-worker
 */

import type {
  FileWorkerMessage,
  FileWorkerRequest,
  ReadyMessage,
  UndeliverableJobMessage,
} from "./file-processor";

import { defaultChunker } from "./chunker";
import { convertForPreparation } from "./prepare-convert";
import { PREPARE_PHASES, prepareFile } from "./prepare-file";

declare const self: Worker;

const post = (
  message: FileWorkerMessage | ReadyMessage | UndeliverableJobMessage
): void => {
  self.postMessage(message);
};

// A job that cannot be deserialized never reaches onmessage (Bun 1.4.0+
// raises messageerror instead); tell the parent so the file fails at once.
// A listener, not `onmessageerror`: Bun's worker scope never calls that
// property.
self.addEventListener("messageerror", () => {
  post({ type: "undeliverable-job" });
});

self.onmessage = async (
  event: MessageEvent<FileWorkerRequest | { simulateUndeliverable: true }>
) => {
  // Only the parent that created this worker may drive it; a Bun Worker sees
  // its parent's messages with an empty origin.
  if (event.origin !== "") return;
  if ("simulateUndeliverable" in event.data) {
    // Tests only (simulateUndeliverableMessage): raise the real event.
    self.dispatchEvent(new MessageEvent("messageerror"));
    return;
  }
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
