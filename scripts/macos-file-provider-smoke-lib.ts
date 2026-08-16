/**
 * Shared TN3150 File Provider smoke helpers (non-production).
 * Policy uses process scope — async Bun I/O may escape thread scope.
 */

// bun:ffi — Darwin getiopolicy_np/setiopolicy_np/lstat/open/read
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
// node:fs/promises — structural realpath/lstat; no Bun equivalent
import { lstat, realpath } from "node:fs/promises";
// node:os — Bun has no home-directory helper
import { homedir } from "node:os";
// node:path — Bun has no path utilities
import { basename, dirname, join, resolve, sep } from "node:path";

export const SF_DATALESS = 0x4000_0000;
export const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
export const IOPOL_SCOPE_PROCESS = 0;
export const IOPOL_SCOPE_THREAD = 1;
export const IOPOL_MATERIALIZE_DATALESS_FILES_OFF = 1;
export const DARWIN_EDEADLK = 11;
export const STAT_BUF_SIZE = 144;
export const ST_FLAGS_OFFSET = 116;
export const FIXTURE_BASENAME_RE =
  /^GNO-fn118-smoke-[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CORPUS_FILE_COUNT = 24;
export const INTERMEDIATE_DIR_CAVEAT =
  "TN3150: stat/getattrlist classify via SF_DATALESS but may materialize intermediate dataless folders";

export const MATRIX_ROWS = [
  "local",
  "pinned-offline",
  "cached-unpinned",
  "cloud-only",
  "nested-dataless-directory",
  "partial-content",
  "classification-to-read-race",
] as const;

export type MatrixRow = (typeof MATRIX_ROWS)[number];
export type RowVerdict = "PASS" | "FAIL" | "BLOCKED" | "NOT AVAILABLE";
export type ProbeKind = "metadata" | "traversal" | "guarded-read";

export type IoPolicyPort = {
  get: (type: number, scope: number) => number;
  set: (type: number, scope: number, policy: number) => number;
  readErrno: () => number;
};

export type AvailabilitySnapshot = {
  ok: boolean;
  dataless: boolean | null;
  stFlags: number | null;
  errno: number | null;
  error?: string;
};

export type AvailabilityObserver = {
  kind: "darwin-ffi-lstat-st_flags";
  intermediateDirectoryCaveat: string;
  observe: (absPath: string) => AvailabilitySnapshot;
};

export type ProviderLabel = "google" | "icloud" | "onedrive";

type LibSymbols = {
  getiopolicy_np: (type: number, scope: number) => number;
  setiopolicy_np: (type: number, scope: number, policy: number) => number;
  lstat: (path: ReturnType<typeof ptr>, buf: ReturnType<typeof ptr>) => number;
  open: (path: ReturnType<typeof ptr>, flags: number) => number;
  close: (fd: number) => number;
  read: (fd: number, buf: ReturnType<typeof ptr>, n: bigint) => bigint;
  __error: () => ReturnType<typeof ptr> | null;
};

let cachedLib: {
  library: ReturnType<typeof dlopen>;
  symbols: LibSymbols;
} | null = null;
let cachedPolicy: IoPolicyPort | null | undefined;
let cachedObserver: AvailabilityObserver | null | undefined;

export function resetDarwinCachesForTests(): void {
  cachedLib = null;
  cachedPolicy = undefined;
  cachedObserver = undefined;
}

export function cstr(value: string): Uint8Array {
  return Buffer.from(`${value}\0`);
}

export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

export function redactToken(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

export function assertFixtureBasename(fixtureId: string): void {
  if (
    fixtureId.includes(sep) ||
    fixtureId.includes("/") ||
    fixtureId.includes("\\") ||
    fixtureId.includes("..") ||
    fixtureId !== basename(fixtureId)
  ) {
    throw new Error("unsafe fixture id: separators or traversal refused");
  }
  if (!FIXTURE_BASENAME_RE.test(fixtureId)) {
    throw new Error(
      "unsafe fixture id: must match GNO-fn118-smoke-* basename pattern"
    );
  }
}

export function classifyGuardedReadErrno(errno: number): "EDEADLK" | "OTHER" {
  return errno === DARWIN_EDEADLK ? "EDEADLK" : "OTHER";
}

export function requireDarwin(platform: string = process.platform): void {
  if (platform !== "darwin") {
    throw new Error("non-Darwin platform refused before mutation");
  }
}

function asFn<T extends (...args: never[]) => unknown>(
  value: unknown
): T | null {
  return typeof value === "function" ? (value as T) : null;
}

function loadLibSystem(): {
  library: ReturnType<typeof dlopen>;
  symbols: LibSymbols;
} | null {
  if (cachedLib) {
    return cachedLib;
  }
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
        lstat: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        read: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u64],
          returns: FFIType.i64,
        },
        __error: { args: [], returns: FFIType.ptr },
      });
      const raw = library.symbols as Record<string, unknown>;
      const getiopolicy_np = asFn<LibSymbols["getiopolicy_np"]>(
        raw.getiopolicy_np
      );
      const setiopolicy_np = asFn<LibSymbols["setiopolicy_np"]>(
        raw.setiopolicy_np
      );
      const lstatFn = asFn<LibSymbols["lstat"]>(raw.lstat);
      const openFn = asFn<LibSymbols["open"]>(raw.open);
      const closeFn = asFn<LibSymbols["close"]>(raw.close);
      const readFn = asFn<LibSymbols["read"]>(raw.read);
      const errorFn = asFn<LibSymbols["__error"]>(raw.__error);
      if (
        !getiopolicy_np ||
        !setiopolicy_np ||
        !lstatFn ||
        !openFn ||
        !closeFn ||
        !readFn ||
        !errorFn
      ) {
        continue;
      }
      cachedLib = {
        library,
        symbols: {
          getiopolicy_np,
          setiopolicy_np,
          lstat: lstatFn,
          open: openFn,
          close: closeFn,
          read: readFn,
          __error: errorFn,
        },
      };
      return cachedLib;
    } catch {
      // try next soname
    }
  }
  return null;
}

function readErrnoFrom(symbols: LibSymbols): number {
  const p = symbols.__error();
  if (!p) {
    return 0;
  }
  return new Int32Array(toArrayBuffer(p, 0, 4))[0] ?? 0;
}

export function loadIoPolicyPort(): IoPolicyPort | null {
  if (cachedPolicy !== undefined) {
    return cachedPolicy;
  }
  const loaded = loadLibSystem();
  if (!loaded) {
    cachedPolicy = null;
    return null;
  }
  const { symbols } = loaded;
  cachedPolicy = {
    get: symbols.getiopolicy_np,
    set: symbols.setiopolicy_np,
    readErrno: () => readErrnoFrom(symbols),
  };
  return cachedPolicy;
}

export function loadAvailabilityObserver(): AvailabilityObserver | null {
  if (cachedObserver !== undefined) {
    return cachedObserver;
  }
  const loaded = loadLibSystem();
  if (!loaded) {
    cachedObserver = null;
    return null;
  }
  const { symbols } = loaded;
  cachedObserver = {
    kind: "darwin-ffi-lstat-st_flags",
    intermediateDirectoryCaveat: INTERMEDIATE_DIR_CAVEAT,
    observe: (absPath: string): AvailabilitySnapshot => {
      const buf = new Uint8Array(STAT_BUF_SIZE);
      const rc = symbols.lstat(ptr(cstr(absPath)), ptr(buf));
      if (rc !== 0) {
        return {
          ok: false,
          dataless: null,
          stFlags: null,
          errno: readErrnoFrom(symbols),
          error: "lstat_failed",
        };
      }
      const stFlags = new DataView(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength
      ).getUint32(ST_FLAGS_OFFSET, true);
      return {
        ok: true,
        dataless: (stFlags & SF_DATALESS) !== 0,
        stFlags,
        errno: null,
      };
    },
  };
  return cachedObserver;
}

export async function withNoMaterializePolicy<T>(
  run: () => Promise<T>,
  port: IoPolicyPort | null = loadIoPolicyPort()
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  if (!port) {
    return { ok: false, error: "policy_unavailable" };
  }
  const prior = port.get(
    IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
    IOPOL_SCOPE_PROCESS
  );
  if (prior < 0) {
    return { ok: false, error: "policy_get_failed" };
  }
  if (
    port.set(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
      IOPOL_MATERIALIZE_DATALESS_FILES_OFF
    ) !== 0
  ) {
    return { ok: false, error: "policy_set_failed" };
  }
  let value: T;
  let thrown: unknown;
  try {
    value = await run();
  } catch (error) {
    thrown = error;
  }
  const restoreResult = port.set(
    IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
    IOPOL_SCOPE_PROCESS,
    prior
  );
  if (restoreResult !== 0) {
    return { ok: false, error: "policy_restore_failed" };
  }
  if (thrown !== undefined) {
    throw thrown;
  }
  return { ok: true, value: value! };
}

/** Caller must establish the no-materialization policy before invoking. */
export function readContentUnderActivePolicy(
  absPath: string,
  port: IoPolicyPort | null = loadIoPolicyPort()
): {
  ok: boolean;
  classification: "ok" | "EDEADLK" | "OTHER" | "policy_failed";
  errno: number | null;
  bytesRead: number;
  digest: string | null;
} {
  const loaded = loadLibSystem();
  if (!port || !loaded) {
    return {
      ok: false,
      classification: "policy_failed",
      errno: null,
      bytesRead: 0,
      digest: null,
    };
  }
  const { symbols } = loaded;
  const fd = symbols.open(ptr(cstr(absPath)), 0);
  if (fd < 0) {
    const errno = port.readErrno();
    return {
      ok: false,
      classification: classifyGuardedReadErrno(errno),
      errno,
      bytesRead: 0,
      digest: null,
    };
  }
  try {
    const buf = new Uint8Array(4096);
    const n = Number(symbols.read(fd, ptr(buf), BigInt(buf.length)));
    if (n < 0) {
      const errno = port.readErrno();
      return {
        ok: false,
        classification: classifyGuardedReadErrno(errno),
        errno,
        bytesRead: 0,
        digest: null,
      };
    }
    return {
      ok: true,
      classification: "ok",
      errno: null,
      bytesRead: n,
      digest: sha256Hex(buf.subarray(0, n)),
    };
  } finally {
    symbols.close(fd);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function classifyProviderRootShape(
  absPath: string,
  home: string = homedir()
): ProviderLabel | null {
  const cloudStorage = join(home, "Library", "CloudStorage");
  const relativeCloudPath = absPath.startsWith(cloudStorage + sep)
    ? absPath.slice(cloudStorage.length + 1).split(sep)
    : [];
  if (
    relativeCloudPath.length === 2 &&
    relativeCloudPath[0]?.startsWith("GoogleDrive-") &&
    relativeCloudPath[1] === "My Drive"
  ) {
    return "google";
  }
  if (
    relativeCloudPath.length === 2 &&
    relativeCloudPath[0]?.startsWith("OneDrive-") &&
    relativeCloudPath[0].includes("SharedLibraries") &&
    relativeCloudPath[1] !== undefined &&
    !FIXTURE_BASENAME_RE.test(relativeCloudPath[1])
  ) {
    return "onedrive";
  }
  const iCloudRoot = join(
    home,
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs"
  );
  return absPath === iCloudRoot ? "icloud" : null;
}

export async function resolveProviderRoot(rootArg: string): Promise<{
  realPath: string;
  provider: ProviderLabel;
}>;
export async function resolveProviderRoot(
  rootArg: string,
  home: string
): Promise<{ realPath: string; provider: ProviderLabel }>;
export async function resolveProviderRoot(
  rootArg: string,
  home: string = homedir()
): Promise<{ realPath: string; provider: ProviderLabel }> {
  if (!rootArg || rootArg.trim() === "") {
    throw new Error("unsafe root: --root must be explicitly supplied");
  }
  if (rootArg.split(/[\\/]/).includes("..")) {
    throw new Error("unsafe root: traversal segments are refused");
  }
  const abs = resolve(rootArg);
  const provider = classifyProviderRootShape(abs, home);
  if (!provider) {
    throw new Error(
      "unsafe root: expected an installed Google Drive, iCloud Drive, or immediate OneDrive SharedLibraries library root"
    );
  }
  const rootStat = await lstat(abs).catch(() => null);
  if (!rootStat) {
    throw new Error("unsafe root: path does not exist or is unresolvable");
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error("unsafe root: symlink roots are refused");
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error("unsafe root: path does not exist or is unresolvable");
  }
  if (!(await lstat(real)).isDirectory()) {
    throw new Error("unsafe root: must be a directory");
  }
  if (provider === "onedrive") {
    const domain = dirname(abs);
    const domainReal = await realpath(domain).catch(() => null);
    if (!domainReal || dirname(real) !== domainReal) {
      throw new Error(
        "unsafe root: OneDrive library must remain an immediate child of its installed SharedLibraries domain"
      );
    }
  }
  return { realPath: real, provider };
}

export async function resolveFixtureChild(
  rootReal: string,
  fixtureId: string,
  options: { mustExist?: boolean; mustNotExist?: boolean } = {}
): Promise<string> {
  assertFixtureBasename(fixtureId);
  const child = join(rootReal, fixtureId);
  if (!child.startsWith(rootReal + sep)) {
    throw new Error("unsafe fixture path: escapes provider root");
  }
  let exists = false;
  try {
    await lstat(child);
    exists = true;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw new Error("unsafe fixture path: unable to inspect child");
    }
  }
  if (options.mustNotExist && exists) {
    throw new Error("refusing pre-existing fixture path");
  }
  if (options.mustExist && !exists) {
    throw new Error("fixture path does not exist");
  }
  if (!exists) {
    return child;
  }
  const realChild = await realpath(child);
  if (!realChild.startsWith(rootReal + sep) && realChild !== rootReal) {
    throw new Error("unsafe fixture path: realpath escapes provider root");
  }
  return realChild;
}
