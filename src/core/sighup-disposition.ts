/**
 * Whether a resident may take over SIGHUP (fn-210).
 *
 * Registering any SIGHUP listener replaces the inherited disposition, so a
 * resident started under `nohup` (or `trap '' HUP`) would start shutting down
 * when its terminal closes. The disposition is read once with sigaction(2):
 * if SIGHUP was ignored at start, it stays ignored. When it cannot be read
 * (Windows, no FFI), the default is kept and no handler is installed.
 *
 * @module src/core/sighup-disposition
 */

const SIGHUP = 1;
/** `SIG_IGN` is handler value 1 on Linux and macOS. */
const SIG_IGN = 1n;
/** Comfortably larger than `struct sigaction` on Linux and macOS. */
const SIGACTION_BYTES = 256;
const LIBC_NAMES: Record<string, string[]> = {
  linux: ["libc.so.6", "libc.so"],
  darwin: ["libc.dylib", "libSystem.B.dylib"],
};

let cached: boolean | undefined;

function readSighupIgnored(): boolean | null {
  const names = LIBC_NAMES[process.platform];
  if (!names) return null;
  try {
    // bun:ffi is built into Bun (no native dependency).
    const { dlopen, FFIType, ptr } =
      require("bun:ffi") as typeof import("bun:ffi");
    for (const name of names) {
      try {
        const libc = dlopen(name, {
          sigaction: {
            args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
            returns: FFIType.i32,
          },
        });
        try {
          const old = new BigUint64Array(SIGACTION_BYTES / 8);
          if (libc.symbols.sigaction(SIGHUP, null, ptr(old)) !== 0) return null;
          // The handler is the first member of struct sigaction on both.
          return old[0] === SIG_IGN;
        } finally {
          libc.close();
        }
      } catch {
        // Try the next library name.
      }
    }
  } catch {
    // No FFI in this runtime.
  }
  return null;
}

/**
 * True when SIGHUP was not ignored at start and its disposition is known, so
 * a resident can shut down gracefully on it. Read before any SIGHUP listener
 * is installed; the answer is cached.
 */
export function sighupHandlerAllowed(): boolean {
  if (cached === undefined) cached = readSighupIgnored() === false;
  return cached;
}
