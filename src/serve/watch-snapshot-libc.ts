/**
 * Libc FFI boundary for anchored watcher directory handles.
 *
 * Loads system libc with platform-correct sonames, parses dirent records
 * using d_reclen/d_namlen bounds, and clears errno around readdir.
 *
 * @module src/serve/watch-snapshot-libc
 */

// bun:ffi — no Bun high-level openat/fdopendir; libc is required for fd-relative ops
import { type Pointer, dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
// node:fs — flag constants for openat; no Bun equivalent
import { constants as fsConstants } from "node:fs";

export type LibcSymbols = {
  openat: (dirfd: number, path: Pointer, flags: number) => number;
  dup: (fd: number) => number;
  close: (fd: number) => number;
  fdopendir: (fd: number) => Pointer | null;
  readdir: (dirp: Pointer) => Pointer | null;
  closedir: (dirp: Pointer) => number;
  errnoPtr: () => Pointer;
};

/** Platform dirent field layout (little-endian). */
export type DirentLayout = {
  /** Offset of d_reclen (uint16). Both Darwin and Linux: 16. */
  dReclenOffset: number;
  /**
   * Offset of d_namlen (uint16) when present.
   * Darwin: 18. Linux glibc has no d_namlen (null).
   */
  dNamlenOffset: number | null;
  /** Offset of d_name char array. Darwin: 21. Linux glibc: 19. */
  dNameOffset: number;
};

export type LoadedLibc = {
  /** Strong reference so FFI symbols stay live for the process lifetime. */
  library: ReturnType<typeof dlopen>;
  symbols: LibcSymbols;
  dirent: DirentLayout;
  openChildFlags: number;
  openDirFlags: number;
  openLstatFlags: number;
};

let cachedLibc: LoadedLibc | null | undefined;

/**
 * Deterministic libc soname candidates.
 * Never rely solely on `libc.<suffix>` (Linux libc.so is often a linker script).
 */
export function libcLoadCandidates(
  platform: string = process.platform
): string[] {
  if (platform === "darwin") {
    return ["libSystem.B.dylib", "libc.dylib"];
  }
  if (platform === "linux") {
    return ["libc.so.6", "libc.so"];
  }
  return [];
}

function direntLayoutFor(platform: string): DirentLayout {
  if (platform === "darwin") {
    // struct dirent: d_ino(8) d_seekoff(8) d_reclen(2) d_namlen(2) d_type(1) d_name[]
    return { dReclenOffset: 16, dNamlenOffset: 18, dNameOffset: 21 };
  }
  // glibc struct dirent: d_ino(8) d_off(8) d_reclen(2) d_type(1) d_name[]
  return { dReclenOffset: 16, dNamlenOffset: null, dNameOffset: 19 };
}

function openLibcSymbols(
  path: string,
  errnoName: string
): ReturnType<typeof dlopen> | null {
  try {
    return dlopen(path, {
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      dup: { args: [FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
      readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
      closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
      [errnoName]: { args: [], returns: FFIType.ptr },
    });
  } catch {
    return null;
  }
}

export function loadLibc(): LoadedLibc | null {
  if (cachedLibc !== undefined) {
    return cachedLibc;
  }
  if (process.platform === "win32") {
    cachedLibc = null;
    return null;
  }

  const platform = process.platform;
  const errnoName = platform === "darwin" ? "__error" : "__errno_location";
  const candidates = libcLoadCandidates(platform);

  let library: ReturnType<typeof dlopen> | null = null;
  for (const candidate of candidates) {
    library = openLibcSymbols(candidate, errnoName);
    if (library) {
      break;
    }
  }
  if (!library) {
    cachedLibc = null;
    return null;
  }

  const raw = library.symbols as Record<string, unknown>;
  const openat = asLibcFn<LibcSymbols["openat"]>(raw.openat);
  const dup = asLibcFn<LibcSymbols["dup"]>(raw.dup);
  const close = asLibcFn<LibcSymbols["close"]>(raw.close);
  const fdopendir = asLibcFn<LibcSymbols["fdopendir"]>(raw.fdopendir);
  const readdir = asLibcFn<LibcSymbols["readdir"]>(raw.readdir);
  const closedir = asLibcFn<LibcSymbols["closedir"]>(raw.closedir);
  const errnoFn = asLibcFn<LibcSymbols["errnoPtr"]>(raw[errnoName]);
  if (
    !openat ||
    !dup ||
    !close ||
    !fdopendir ||
    !readdir ||
    !closedir ||
    !errnoFn
  ) {
    cachedLibc = null;
    return null;
  }

  const O_RDONLY = fsConstants.O_RDONLY;
  const O_DIRECTORY = fsConstants.O_DIRECTORY;
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

  let openLstatFlags: number;
  if (platform === "darwin") {
    // Darwin O_SYMLINK opens the symlink inode itself (lstat-like).
    // Without it, O_RDONLY would follow — refuse rather than silent follow.
    // O_NONBLOCK is required: plain O_RDONLY|O_SYMLINK can block forever on a
    // FIFO with no writer (and similarly hang on some device nodes).
    const O_SYMLINK = (fsConstants as { O_SYMLINK?: number }).O_SYMLINK;
    if (O_SYMLINK === undefined || O_SYMLINK === 0) {
      cachedLibc = null;
      return null;
    }
    const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
    openLstatFlags = O_RDONLY | O_SYMLINK | O_NONBLOCK;
  } else {
    // Linux O_PATH|O_NOFOLLOW is the portable no-follow open for any type.
    // O_PATH does not block on FIFOs/sockets; no extra O_NONBLOCK needed.
    const O_PATH = (fsConstants as { O_PATH?: number }).O_PATH ?? 0o10_000_000;
    openLstatFlags = O_RDONLY | O_PATH | O_NOFOLLOW;
  }

  const openDirFlags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;

  cachedLibc = {
    library,
    symbols: {
      openat,
      dup,
      close,
      fdopendir,
      readdir,
      closedir,
      errnoPtr: errnoFn,
    },
    dirent: direntLayoutFor(platform),
    openChildFlags: openDirFlags,
    openDirFlags,
    openLstatFlags,
  };
  return cachedLibc;
}

function asLibcFn<T extends (...args: never[]) => unknown>(
  value: unknown
): T | null {
  if (typeof value !== "function") {
    return null;
  }
  return value as T;
}

export function errnoError(
  errno: number,
  syscall: string,
  path: string
): NodeJS.ErrnoException {
  const error = new Error(
    `${syscall} failed (errno ${errno}): ${path}`
  ) as NodeJS.ErrnoException;
  error.errno = errno;
  error.syscall = syscall;
  error.path = path;
  // Map common POSIX errno values used on darwin/linux.
  if (errno === 2) {
    error.code = "ENOENT";
  } else if (errno === 13) {
    error.code = "EACCES";
  } else if (errno === 20) {
    error.code = "ENOTDIR";
  } else if (errno === 40 || errno === 62) {
    // Linux ELOOP=40, Darwin ELOOP=62
    error.code = "ELOOP";
  } else if (errno === 17) {
    error.code = "EEXIST";
  } else {
    error.code = "EIO";
  }
  return error;
}

export function readErrno(libc: LoadedLibc): number {
  const p = libc.symbols.errnoPtr();
  if (!p) {
    return 0;
  }
  const view = new Int32Array(toArrayBuffer(p, 0, 4));
  return view[0] ?? 0;
}

/** Clear thread errno so readdir EOF (null + errno 0) is distinguishable from error. */
export function clearErrno(libc: LoadedLibc): void {
  const p = libc.symbols.errnoPtr();
  if (!p) {
    return;
  }
  const view = new Int32Array(toArrayBuffer(p, 0, 4));
  view[0] = 0;
}

/**
 * Parse d_name from a dirent pointer using platform reclen/namlen bounds.
 * Returns null for malformed records (caller treats as scan failure).
 */
export function parseDirentName(
  ent: Pointer,
  layout: DirentLayout
): string | null {
  // Header must cover through d_name start (includes reclen and optional namlen).
  if (layout.dNameOffset < 18) {
    return null;
  }
  let header: DataView;
  try {
    header = new DataView(toArrayBuffer(ent, 0, layout.dNameOffset));
  } catch {
    return null;
  }

  const reclen = header.getUint16(layout.dReclenOffset, true);
  // Record must at least hold the fixed header + one byte of d_name room.
  if (reclen < layout.dNameOffset + 1) {
    return null;
  }
  const maxNameBytes = reclen - layout.dNameOffset;
  // POSIX NAME_MAX is typically 255; reject absurd reclen-derived lengths.
  if (maxNameBytes > 1024) {
    return null;
  }

  let nameLen: number;
  if (layout.dNamlenOffset !== null) {
    const namlen = header.getUint16(layout.dNamlenOffset, true);
    if (namlen > maxNameBytes) {
      return null;
    }
    nameLen = namlen;
  } else {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        toArrayBuffer(ent, layout.dNameOffset, maxNameBytes)
      );
    } catch {
      return null;
    }
    let end = 0;
    while (end < bytes.length && bytes[end] !== 0) {
      end += 1;
    }
    // Linux dirents are NUL-terminated within d_reclen; missing NUL → malformed.
    if (end === bytes.length) {
      return null;
    }
    return Buffer.from(bytes.subarray(0, end)).toString();
  }

  if (nameLen === 0) {
    return "";
  }
  try {
    const nameBytes = new Uint8Array(
      toArrayBuffer(ent, layout.dNameOffset, nameLen)
    );
    return Buffer.from(nameBytes).toString();
  } catch {
    return null;
  }
}

/**
 * Enumerate child names via fdopendir/readdir, stopping after `maxNames + 1`
 * observed entries so overflow is proven without materializing an unbounded list.
 */
export function readDirNames(
  libc: LoadedLibc,
  dirfd: number,
  maxNames: number
): { status: "ok"; names: string[] } | { status: "overflow" } {
  if (!Number.isInteger(maxNames) || maxNames < 0) {
    throw Object.assign(new Error("maxNames must be a non-negative integer"), {
      code: "EINVAL",
    });
  }
  // fdopendir consumes the fd on success — operate on a dup so the handle stays live.
  const dupFd = libc.symbols.dup(dirfd);
  if (dupFd < 0) {
    throw errnoError(readErrno(libc), "dup", "");
  }
  const dirp = libc.symbols.fdopendir(dupFd);
  if (!dirp) {
    libc.symbols.close(dupFd);
    throw errnoError(readErrno(libc), "fdopendir", "");
  }
  const names: string[] = [];
  try {
    while (true) {
      clearErrno(libc);
      const ent = libc.symbols.readdir(dirp);
      if (!ent) {
        const err = readErrno(libc);
        if (err !== 0) {
          throw errnoError(err, "readdir", "");
        }
        break;
      }
      const name = parseDirentName(ent, libc.dirent);
      if (name === null) {
        throw Object.assign(new Error("Malformed dirent record"), {
          code: "EIO",
          syscall: "readdir",
        });
      }
      if (name === "" || name === "." || name === "..") {
        continue;
      }
      // maxNames+1th name proves overflow; do not store it or continue.
      if (names.length >= maxNames) {
        return { status: "overflow" };
      }
      names.push(name);
    }
  } finally {
    libc.symbols.closedir(dirp);
  }
  return { status: "ok", names };
}

export function openatOrThrow(
  libc: LoadedLibc,
  dirfd: number,
  name: string,
  flags: number,
  syscall: string
): number {
  if (name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw Object.assign(new Error(`Invalid directory entry name: ${name}`), {
      code: "EINVAL",
    });
  }
  const nameBuf = Buffer.from(`${name}\0`);
  const fd = libc.symbols.openat(dirfd, ptr(nameBuf), flags);
  if (fd < 0) {
    throw errnoError(readErrno(libc), syscall, name);
  }
  return fd;
}
