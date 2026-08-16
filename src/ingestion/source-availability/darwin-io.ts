/**
 * Darwin FFI backend for no-materialization I/O policy and guarded content reads.
 * Provider-neutral; reuses the TN3150 mechanism proven in
 * scripts/macos-file-provider-smoke.ts (IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES).
 * No provider SDK; no pin/evict/download/availability mutation.
 *
 * @module src/ingestion/source-availability/darwin-io
 */

// bun:ffi — getiopolicy_np/setiopolicy_np/open/read require libc FFI; no Bun high-level equivalent
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
// node:fs constants expose Darwin O_NOFOLLOW; Bun has no file-open flag API.
import { constants as fsConstants } from "node:fs";

/** TN3150 / File Provider constants (from smoke harness evidence). */
export const SF_DATALESS = 0x4000_0000;
export const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
export const IOPOL_SCOPE_PROCESS = 0;
export const IOPOL_MATERIALIZE_DATALESS_FILES_OFF = 1;
/** Darwin errno for guarded dataless materialization refusal. */
export const DARWIN_EDEADLK = 11;
export const DARWIN_EACCES = 13;
export const DARWIN_EPERM = 1;
export const DARWIN_ENOENT = 2;
export const DARWIN_EISDIR = 21;
export const DARWIN_ELOOP = 62;
export const DARWIN_EIO = 5;
const OPEN_RDONLY_NOFOLLOW = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

export type DarwinIoPolicyPort = {
  get: (type: number, scope: number) => number;
  set: (type: number, scope: number, policy: number) => number;
  readErrno: () => number;
};

export type DarwinFileIoPort = {
  open: (absPath: string, flags: number) => number;
  read: (fd: number, buf: Uint8Array) => number;
  close: (fd: number) => number;
  readErrno: () => number;
};

/**
 * No-follow lstat of `st_flags` for SF_DATALESS directory classification.
 * Distinct from content open/read — used only at directory boundaries.
 */
export type DarwinStatPort = {
  lstatFlags: (
    absPath: string
  ) => { ok: true; stFlags: number } | { ok: false; errno: number };
};

export type DarwinIoBundle = {
  policy: DarwinIoPolicyPort;
  file: DarwinFileIoPort;
  stat: DarwinStatPort;
};

/** Darwin `struct stat` layout used by the smoke harness (arm64/x86_64). */
export const DARWIN_STAT_BUF_SIZE = 144;
export const DARWIN_ST_FLAGS_OFFSET = 116;

type LibSymbols = {
  getiopolicy_np: (type: number, scope: number) => number;
  setiopolicy_np: (type: number, scope: number, policy: number) => number;
  open: (path: ReturnType<typeof ptr>, flags: number) => number;
  close: (fd: number) => number;
  read: (fd: number, buf: ReturnType<typeof ptr>, n: bigint) => bigint;
  lstat: (path: ReturnType<typeof ptr>, buf: ReturnType<typeof ptr>) => number;
  __error: () => ReturnType<typeof ptr> | null;
};

let cachedBundle: DarwinIoBundle | null | undefined;

/** Test-only: clear FFI caches between cases. */
export function resetDarwinIoCachesForTests(): void {
  cachedBundle = undefined;
}

function asFn<T extends (...args: never[]) => unknown>(
  value: unknown
): T | null {
  return typeof value === "function" ? (value as T) : null;
}

function cstr(value: string): Uint8Array {
  return Buffer.from(`${value}\0`);
}

function readErrnoFrom(symbols: LibSymbols): number {
  const p = symbols.__error();
  if (!p) {
    return 0;
  }
  return new Int32Array(toArrayBuffer(p, 0, 4))[0] ?? 0;
}

function loadLibSystem(): {
  library: ReturnType<typeof dlopen>;
  symbols: LibSymbols;
} | null {
  if (process.platform !== "darwin") {
    return null;
  }
  for (const soname of ["libSystem.B.dylib", "libSystem.dylib"]) {
    try {
      const library = dlopen(soname, {
        getiopolicy_np: {
          args: [FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        setiopolicy_np: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
        open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        read: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u64],
          returns: FFIType.i64,
        },
        lstat: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      const raw = library.symbols as Record<string, unknown>;
      const getiopolicy_np = asFn<LibSymbols["getiopolicy_np"]>(
        raw.getiopolicy_np
      );
      const setiopolicy_np = asFn<LibSymbols["setiopolicy_np"]>(
        raw.setiopolicy_np
      );
      const openFn = asFn<LibSymbols["open"]>(raw.open);
      const closeFn = asFn<LibSymbols["close"]>(raw.close);
      const readFn = asFn<LibSymbols["read"]>(raw.read);
      const lstatFn = asFn<LibSymbols["lstat"]>(raw.lstat);
      const errorFn = asFn<LibSymbols["__error"]>(raw.__error);
      if (
        !getiopolicy_np ||
        !setiopolicy_np ||
        !openFn ||
        !closeFn ||
        !readFn ||
        !lstatFn ||
        !errorFn
      ) {
        continue;
      }
      return {
        library,
        symbols: {
          getiopolicy_np,
          setiopolicy_np,
          open: openFn,
          close: closeFn,
          read: readFn,
          lstat: lstatFn,
          __error: errorFn,
        },
      };
    } catch {
      // try next soname
    }
  }
  return null;
}

/** Load Darwin policy + file I/O ports; null when unavailable. */
export function loadDarwinIo(): DarwinIoBundle | null {
  if (cachedBundle !== undefined) {
    return cachedBundle;
  }
  const loaded = loadLibSystem();
  if (!loaded) {
    cachedBundle = null;
    return null;
  }
  const { symbols } = loaded;
  const readErrno = (): number => readErrnoFrom(symbols);
  cachedBundle = {
    policy: {
      get: symbols.getiopolicy_np,
      set: symbols.setiopolicy_np,
      readErrno,
    },
    file: {
      open: (absPath: string, flags: number): number =>
        symbols.open(ptr(cstr(absPath)), flags),
      read: (fd: number, buf: Uint8Array): number =>
        Number(symbols.read(fd, ptr(buf), BigInt(buf.byteLength))),
      close: symbols.close,
      readErrno,
    },
    stat: {
      lstatFlags: (absPath: string) => {
        const buf = new Uint8Array(DARWIN_STAT_BUF_SIZE);
        const rc = symbols.lstat(ptr(cstr(absPath)), ptr(buf));
        if (rc !== 0) {
          return { ok: false as const, errno: readErrno() };
        }
        const stFlags = new DataView(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength
        ).getUint32(DARWIN_ST_FLAGS_OFFSET, true);
        return { ok: true as const, stFlags };
      },
    },
  };
  // Keep library strongly referenced via symbols closure for process lifetime.
  void loaded.library;
  return cachedBundle;
}

/**
 * Run `fn` under process-scoped IOPOL_MATERIALIZE_DATALESS_FILES_OFF.
 * Always restores prior policy. Fail-closed on setup/restore failure.
 */
export function withNoMaterializePolicy<T>(
  run: () => T,
  port: DarwinIoPolicyPort
):
  | { ok: true; value: T }
  | {
      ok: false;
      error:
        | "policy_get_failed"
        | "policy_set_failed"
        | "policy_restore_failed";
    } {
  let prior: number;
  try {
    prior = port.get(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS
    );
  } catch {
    return { ok: false, error: "policy_get_failed" };
  }
  if (prior < 0) {
    return { ok: false, error: "policy_get_failed" };
  }
  let setupResult: number;
  try {
    setupResult = port.set(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
      IOPOL_MATERIALIZE_DATALESS_FILES_OFF
    );
  } catch {
    return { ok: false, error: "policy_set_failed" };
  }
  if (setupResult !== 0) {
    return { ok: false, error: "policy_set_failed" };
  }
  let value: T;
  let thrown: unknown;
  try {
    value = run();
  } catch (error) {
    thrown = error;
  }
  let restoreResult: number;
  try {
    restoreResult = port.set(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
      prior
    );
  } catch {
    return { ok: false, error: "policy_restore_failed" };
  }
  if (restoreResult !== 0) {
    return { ok: false, error: "policy_restore_failed" };
  }
  if (thrown !== undefined) {
    throw thrown;
  }
  return { ok: true, value: value! };
}

export function guardedOpenFlags(): number {
  return OPEN_RDONLY_NOFOLLOW;
}

export function classifyGuardedReadErrno(
  errno: number
): "EDEADLK" | "EACCES" | "EPERM" | "ENOENT" | "EISDIR" | "ELOOP" | "OTHER" {
  if (errno === DARWIN_EDEADLK) return "EDEADLK";
  if (errno === DARWIN_EACCES) return "EACCES";
  if (errno === DARWIN_EPERM) return "EPERM";
  if (errno === DARWIN_ENOENT) return "ENOENT";
  if (errno === DARWIN_EISDIR) return "EISDIR";
  if (errno === DARWIN_ELOOP) return "ELOOP";
  return "OTHER";
}
