/** Native fd-relative metadata retry semantics. */

import { ptr, toArrayBuffer } from "bun:ffi";
import { describe, expect, test } from "bun:test";

import type { LoadedLibc } from "../../src/serve/watch-snapshot-libc";

import {
  loadLibc,
  statatNoFollowOrThrow,
} from "../../src/serve/watch-snapshot-libc";

function withFstatat(
  libc: LoadedLibc,
  fstatat: LoadedLibc["symbols"]["fstatat"],
  errno: number
): LoadedLibc {
  const errnoBuffer = Buffer.alloc(4);
  errnoBuffer.writeInt32LE(errno);
  return {
    ...libc,
    symbols: {
      ...libc.symbols,
      fstatat,
      errnoPtr: () => ptr(errnoBuffer),
    },
  };
}

function writeRegularFileStat(
  libc: LoadedLibc,
  statPointer: Parameters<LoadedLibc["symbols"]["fstatat"]>[2]
): void {
  const statBuffer = Buffer.from(
    toArrayBuffer(statPointer, 0, libc.statLayout.size)
  );
  if (libc.statLayout.modeBytes === 2) {
    statBuffer.writeUInt16LE(0o100_000, libc.statLayout.modeOffset);
  } else {
    statBuffer.writeUInt32LE(0o100_000, libc.statLayout.modeOffset);
  }
}

describe("fd-relative no-follow metadata", () => {
  test("retries one transient ENOENT against the same parent fd", () => {
    const loaded = loadLibc();
    if (!loaded) return;

    let calls = 0;
    const libc = withFstatat(
      loaded,
      (_dirfd, _path, statPointer, flags) => {
        calls += 1;
        expect(flags).toBe(loaded.atSymlinkNoFollow);
        if (calls === 1) return -1;
        writeRegularFileStat(loaded, statPointer);
        return 0;
      },
      2
    );

    const stat = statatNoFollowOrThrow(libc, 17, "stable.md");

    expect(calls).toBe(2);
    expect(stat.isFile()).toBe(true);
  });

  test("persistent ENOENT remains a missing-child scan failure", () => {
    const loaded = loadLibc();
    if (!loaded) return;

    let calls = 0;
    const libc = withFstatat(
      loaded,
      () => {
        calls += 1;
        return -1;
      },
      2
    );

    try {
      statatNoFollowOrThrow(libc, 17, "gone.md");
      throw new Error("expected persistent missing metadata to fail");
    } catch (cause) {
      expect((cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(calls).toBe(2);
  });
});
