/**
 * Child-process backend of the file processor (fn-198).
 *
 * Where a TypeScript worker cannot start (a standalone compiled executable),
 * sync prepares each file in a child process instead: the same executable
 * re-run with `FILE_PROCESSOR_CHILD_ENV` set (see src/index.ts), or this
 * module under a source runtime. It serves `prepareFile` requests over IPC,
 * one at a time, until its parent disconnects; the parent kills it when a
 * file overruns its budget, exactly as it terminates the worker.
 *
 * @module src/ingestion/file-child
 */

import type {
  FileChildMessage,
  FileWorkerRequest,
  ReadyMessage,
} from "./file-processor";

import { defaultChunker } from "./chunker";
import { FILE_PROCESSOR_CHILD_ENV } from "./file-child-env";
import { convertForPreparation } from "./prepare-convert";
import { prepareFile } from "./prepare-file";

const send = (message: FileChildMessage | ReadyMessage): void => {
  process.send?.(message);
};

/** Serve prepare requests from the parent until it disconnects. */
export function runFileProcessorChild(): Promise<void> {
  // Nothing this child starts may re-enter child mode.
  delete process.env[FILE_PROCESSOR_CHILD_ENV];
  return new Promise((resolve) => {
    process.on("message", async (job: Pick<FileWorkerRequest, "request">) => {
      const outcome = await prepareFile(job.request, {
        convert: convertForPreparation,
        chunker: defaultChunker,
        onPrevious: (structure) => send({ type: "previous", structure }),
        onPhase: (phase) => send({ type: "phase", phase }),
        // The parent enforces the budget and kills this process.
        check: () => null,
      });
      send({ type: "done", outcome });
    });
    process.on("disconnect", () => resolve());
    send({ type: "ready" });
  });
}

if (import.meta.main) {
  await runFileProcessorChild();
  process.exit(0);
}
