/**
 * Production anchored directory handles (openat / fdopendir).
 *
 * Uses Bun FFI for fd-relative open/enumerate/no-follow metadata and node:fs
 * structure ops for directory open + fstat confirmation. No new dependencies.
 *
 * Windows and runtimes without a safe anchored path report
 * `supportsAnchoredHandles: false` so callers fall back rather than claiming
 * strict no-follow.
 *
 * @module src/serve/watch-snapshot-handles
 */

// node:fs — open/fstat/close with O_DIRECTORY|O_NOFOLLOW; no Bun equivalent
import { closeSync, fstatSync, openSync } from "node:fs";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { LoadedLibc } from "./watch-snapshot-libc";
import type {
  SnapshotEntryFingerprint,
  WatcherDirHandle,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "./watch-snapshot-types";

import {
  loadLibc,
  openatOrThrow,
  readDirNames,
  statatNoFollowOrThrow,
} from "./watch-snapshot-libc";
import { fingerprintFromStat, isMissingFsError } from "./watch-snapshot-types";

type NativeDir = {
  fd: number;
};

const nativeHandles = new WeakMap<object, NativeDir>();

function asHandle(native: NativeDir): WatcherDirHandle {
  const handle = {} as WatcherDirHandle;
  nativeHandles.set(handle as object, native);
  return handle;
}

function requireNative(handle: WatcherDirHandle): NativeDir {
  const native = nativeHandles.get(handle as object);
  if (!native) {
    throw Object.assign(new Error("Invalid or closed directory handle"), {
      code: "EBADF",
    });
  }
  return native;
}

function openNativeDirByRel(
  libc: LoadedLibc,
  rootAbs: string,
  dirRel: string
): number {
  let fd = openSync(rootAbs, libc.openDirFlags);
  try {
    for (const segment of dirRel.split("/").filter(Boolean)) {
      const child = openatOrThrow(
        libc,
        fd,
        segment,
        libc.openChildFlags,
        "openat"
      );
      closeSync(fd);
      fd = child;
    }
    return fd;
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}

function readDirectChildrenNative(
  libc: LoadedLibc,
  rootAbs: string,
  dirRel: string,
  maxEntries: number
): ReturnType<NonNullable<WatcherSnapshotFs["readDirectChildrenSync"]>> {
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    return {
      status: "scan_failed",
      cause: new Error("maxEntries must be a non-negative integer"),
    };
  }

  let fd: number;
  try {
    fd = openNativeDirByRel(libc, rootAbs, dirRel);
  } catch (cause) {
    return isMissingFsError(cause)
      ? { status: "missing" }
      : { status: "scan_failed", cause };
  }

  try {
    const listed = readDirNames(libc, fd, maxEntries);
    if (listed.status === "overflow") {
      return listed;
    }
    const entries = new Map<string, SnapshotEntryFingerprint>();
    listed.names.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const name of listed.names) {
      if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
        return {
          status: "scan_failed",
          cause: new Error(`Invalid directory entry name: ${name}`),
        };
      }
      if (entries.size >= maxEntries) {
        return { status: "overflow" };
      }
      try {
        const fingerprinted = fingerprintFromStat(
          statatNoFollowOrThrow(libc, fd, name)
        );
        if (!fingerprinted.ok) {
          return { status: "unreliable_metadata" };
        }
        entries.set(name, fingerprinted.fingerprint);
      } catch (cause) {
        return { status: "scan_failed", cause };
      }
    }
    return { status: "present", entries };
  } catch (cause) {
    return isMissingFsError(cause)
      ? { status: "missing" }
      : { status: "scan_failed", cause };
  } finally {
    closeSync(fd);
  }
}

function lstatChildByRelNative(
  libc: LoadedLibc,
  rootAbs: string,
  parentRel: string,
  name: string
): WatcherSnapshotStat {
  const parentFd = openNativeDirByRel(libc, rootAbs, parentRel);
  try {
    return statatNoFollowOrThrow(libc, parentFd, name);
  } finally {
    closeSync(parentFd);
  }
}

function createNativeAnchoredFs(libc: LoadedLibc): WatcherSnapshotFs {
  return {
    supportsAnchoredHandles: true,

    readDirectChildrenSync: (rootAbs, dirRel, maxEntries) =>
      readDirectChildrenNative(libc, rootAbs, dirRel, maxEntries),

    lstatChildByRelSync: (rootAbs, parentRel, name) =>
      lstatChildByRelNative(libc, rootAbs, parentRel, name),

    async openDir(absPath: string): Promise<WatcherDirHandle> {
      const fd = openSync(absPath, libc.openDirFlags);
      return asHandle({ fd });
    },

    async readDir(handle: WatcherDirHandle, maxNames: number) {
      const native = requireNative(handle);
      return readDirNames(libc, native.fd, maxNames);
    },

    async lstatChild(
      handle: WatcherDirHandle,
      name: string
    ): Promise<WatcherSnapshotStat> {
      const native = requireNative(handle);
      return statatNoFollowOrThrow(libc, native.fd, name);
    },

    async openChildDir(
      handle: WatcherDirHandle,
      name: string
    ): Promise<WatcherDirHandle> {
      const native = requireNative(handle);
      const fd = openatOrThrow(
        libc,
        native.fd,
        name,
        libc.openChildFlags,
        "openat"
      );
      // Confirm real directory (O_DIRECTORY should enforce; double-check kind).
      try {
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          closeSync(fd);
          throw Object.assign(
            new Error(`Expected real directory child: ${name}`),
            { code: "ENOTDIR" }
          );
        }
      } catch (cause) {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors when fstat failed
        }
        throw cause;
      }
      return asHandle({ fd });
    },

    async closeDir(handle: WatcherDirHandle): Promise<void> {
      const native = nativeHandles.get(handle as object);
      if (!native) {
        return;
      }
      nativeHandles.delete(handle as object);
      try {
        closeSync(native.fd);
      } catch (cause) {
        if (!isMissingFsError(cause)) {
          // EBADF after double-close is fine; surface others.
          const code =
            cause && typeof cause === "object" && "code" in cause
              ? String(cause.code)
              : "";
          if (code !== "EBADF") {
            throw cause;
          }
        }
      }
    },
  };
}

function createUnsupportedFs(reason: string): WatcherSnapshotFs {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error(reason), { code: "ENOTSUP" });
  };
  return {
    supportsAnchoredHandles: false,
    openDir: fail,
    readDir: fail,
    lstatChild: fail,
    openChildDir: fail,
    closeDir: async () => undefined,
  };
}

/**
 * Production filesystem adapter.
 * Unix + working libc FFI → anchored handles; otherwise explicit unsupported.
 */
export function createDefaultWatcherFs(): WatcherSnapshotFs {
  if (process.platform === "win32") {
    return createUnsupportedFs(
      "Anchored no-follow directory handles are not available on Windows; watcher uses fallback reconciliation"
    );
  }
  const libc = loadLibc();
  if (!libc) {
    return createUnsupportedFs(
      "Anchored no-follow directory handles unavailable on this runtime"
    );
  }
  return createNativeAnchoredFs(libc);
}

/**
 * Path-backed handle adapter for deterministic unit tests.
 * NOT production-safe against TOCTOU path swaps — tests that need race
 * coverage must inject genuine pin-by-identity handles.
 */
export function createPathBackedWatcherFs(ops: {
  readdir(absPath: string): Promise<string[]>;
  lstat(absPath: string): Promise<WatcherSnapshotStat>;
}): WatcherSnapshotFs {
  type PathHandle = { absPath: string };
  const table = new WeakMap<object, PathHandle>();

  const wrap = (absPath: string): WatcherDirHandle => {
    const handle = {} as WatcherDirHandle;
    table.set(handle as object, { absPath });
    return handle;
  };

  const unwrap = (handle: WatcherDirHandle): PathHandle => {
    const value = table.get(handle as object);
    if (!value) {
      throw Object.assign(new Error("Invalid or closed directory handle"), {
        code: "EBADF",
      });
    }
    return value;
  };

  return {
    supportsAnchoredHandles: true,

    async openDir(absPath: string): Promise<WatcherDirHandle> {
      const stat = await ops.lstat(absPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw Object.assign(new Error(`Not a real directory: ${absPath}`), {
          code: "ENOTDIR",
        });
      }
      return wrap(absPath);
    },

    async readDir(handle: WatcherDirHandle, maxNames: number) {
      if (!Number.isInteger(maxNames) || maxNames < 0) {
        throw Object.assign(
          new Error("maxNames must be a non-negative integer"),
          { code: "EINVAL" }
        );
      }
      const listed = await ops.readdir(unwrap(handle).absPath);
      const names: string[] = [];
      for (const name of listed) {
        if (name === "" || name === "." || name === "..") {
          continue;
        }
        // Cap storage at maxNames; the next name is overflow-only evidence.
        if (names.length >= maxNames) {
          return { status: "overflow" as const };
        }
        names.push(name);
      }
      return { status: "ok" as const, names };
    },

    async lstatChild(
      handle: WatcherDirHandle,
      name: string
    ): Promise<WatcherSnapshotStat> {
      return ops.lstat(join(unwrap(handle).absPath, name));
    },

    async openChildDir(
      handle: WatcherDirHandle,
      name: string
    ): Promise<WatcherDirHandle> {
      const absPath = join(unwrap(handle).absPath, name);
      const stat = await ops.lstat(absPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw Object.assign(new Error(`Not a real directory: ${absPath}`), {
          code: "ENOTDIR",
        });
      }
      return wrap(absPath);
    },

    async closeDir(handle: WatcherDirHandle): Promise<void> {
      table.delete(handle as object);
    },
  };
}
