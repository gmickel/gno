/**
 * Child-process backend of the file processor (fn-198).
 *
 * Where a TypeScript worker cannot start (a standalone compiled executable),
 * sync prepares each file in a child process instead: the same executable
 * re-run with `FILE_PROCESSOR_CHILD_ENV` set (see src/index.ts), or this
 * module under a source runtime. It serves `prepareFile` requests over IPC,
 * one at a time, until its parent disconnects; the parent kills it when a
 * file overruns its budget, exactly as it terminates the worker, and on
 * every shutdown path it controls.
 *
 * A child busy in a synchronous step cannot notice its parent dying. On
 * Linux it asks the kernel to SIGKILL it when the parent dies
 * (PR_SET_PDEATHSIG, through Bun's built-in FFI), which holds even if the
 * parent is SIGKILLed. Elsewhere it checks between steps that its parent is
 * still there and exits if not; a parent killed with SIGKILL on macOS or
 * Windows can leave the child running until its current step ends.
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

const PR_SET_PDEATHSIG = 1;
const SIGKILL = 9;
const LINUX_LIBC_NAMES = ["libc.so.6", "libc.so"];

/** Linux: have the kernel SIGKILL this process when its parent dies. */
async function killWithParent(): Promise<void> {
  if (process.platform !== "linux") return;
  try {
    // bun:ffi is built into Bun (no native dependency); loaded only here.
    const { dlopen, FFIType } = await import("bun:ffi");
    for (const name of LINUX_LIBC_NAMES) {
      try {
        const libc = dlopen(name, {
          prctl: {
            args: [
              FFIType.i32,
              FFIType.u64,
              FFIType.u64,
              FFIType.u64,
              FFIType.u64,
            ],
            returns: FFIType.i32,
          },
        });
        libc.symbols.prctl(PR_SET_PDEATHSIG, BigInt(SIGKILL), 0n, 0n, 0n);
        libc.close();
        return;
      } catch {
        // Try the next libc name; the between-step check still applies.
      }
    }
  } catch {
    // No FFI in this runtime: the between-step check still applies.
  }
}

/** Serve prepare requests from the parent until it disconnects. */
export async function runFileProcessorChild(): Promise<void> {
  // Nothing this child starts may re-enter child mode.
  delete process.env[FILE_PROCESSOR_CHILD_ENV];
  const parentPid = process.ppid;
  await killWithParent();
  // The parent may have died before the death signal was armed.
  const parentGone = (): boolean => process.ppid !== parentPid;
  if (parentGone()) process.exit(1);
  return new Promise((resolve) => {
    process.on("message", async (job: Pick<FileWorkerRequest, "request">) => {
      const outcome = await prepareFile(job.request, {
        convert: convertForPreparation,
        chunker: defaultChunker,
        onPrevious: (structure) => send({ type: "previous", structure }),
        onPhase: (phase) => send({ type: "phase", phase }),
        // The parent enforces the budget and kills this process; between
        // steps the child only checks that its parent is still alive.
        check: () => {
          if (parentGone()) process.exit(1);
          return null;
        },
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
