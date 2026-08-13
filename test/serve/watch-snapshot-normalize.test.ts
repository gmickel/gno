/**
 * Pure path/fingerprint helpers for watcher snapshots (gno-27 task .1).
 */

import { describe, expect, test } from "bun:test";

import type {
  SnapshotEntryFingerprint,
  WatcherSnapshot,
} from "../../src/serve/watch-snapshot";

import {
  createEmptyWatcherSnapshot,
  fingerprintsEqual,
  normalizeWatcherRelPath,
} from "../../src/serve/watch-snapshot";

describe("normalizeWatcherRelPath", () => {
  test("accepts relative POSIX paths and strips . segments", () => {
    expect(normalizeWatcherRelPath("a/b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath("./a/./b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath("a\\b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath(".")).toBe("");
    expect(normalizeWatcherRelPath("")).toBe("");
  });

  test("rejects absolute, escaping, drive-shaped, and NUL paths", () => {
    expect(normalizeWatcherRelPath("/etc/passwd")).toBeNull();
    expect(normalizeWatcherRelPath("../outside")).toBeNull();
    expect(normalizeWatcherRelPath("a/../../x")).toBeNull();
    expect(normalizeWatcherRelPath("C:/windows")).toBeNull();
    expect(normalizeWatcherRelPath("a\0b")).toBeNull();
  });
});

describe("fingerprintsEqual", () => {
  test("detects inode replacement with preserved size/mtime", () => {
    const base: SnapshotEntryFingerprint = {
      kind: "file",
      device: 1n,
      inode: 10n,
      size: 100,
      mtimeNs: 1_000n,
      ctimeNs: 2_000n,
    };
    expect(
      fingerprintsEqual(base, {
        ...base,
        inode: 11n,
        ctimeNs: 3_000n,
      })
    ).toBe(false);
    expect(fingerprintsEqual(base, { ...base })).toBe(true);
  });
});

describe("createEmptyWatcherSnapshot", () => {
  test("starts with zero entries", () => {
    const empty: WatcherSnapshot = createEmptyWatcherSnapshot();
    expect(empty.entryCount).toBe(0);
    expect(empty.directories.size).toBe(0);
  });
});
