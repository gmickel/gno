/**
 * fn-202: a watcher flush that keeps failing backs off instead of retrying
 * every 500 ms for the life of the resident.
 */

import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { CollectionSyncResult } from "../../src/ingestion";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import {
  WATCHER_MAX_RETRY_BACKOFF_MS,
  watcherRetryDelayMs,
} from "../../src/serve/watch-reconciliation";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import { portableWatchOptions } from "./helpers/watch-portable-fixtures";

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);

afterEach(() => {
  defaultSyncService.syncPaths = originalSyncPaths;
});

function syncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 1,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 1,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

const failed = (): CollectionSyncResult =>
  syncResult({
    filesErrored: 1,
    filesUnchanged: 0,
    files: [
      {
        relPath: "note.md",
        status: "error",
        errorCode: "SOURCE_AVAILABILITY_UNSUPPORTED",
      },
    ],
  });

async function watchNote(
  syncPaths: (paths: string[]) => Promise<CollectionSyncResult>,
  overrides: Partial<
    ConstructorParameters<typeof CollectionWatchService>[0]
  > = {}
) {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-backoff-"));
  await writeFile(join(root, "note.md"), "x");
  await writeFile(join(root, "other.md"), "y");
  defaultSyncService.syncPaths = (async (
    _collection: unknown,
    _store: unknown,
    paths: string[]
  ) =>
    await syncPaths(paths)) as unknown as typeof defaultSyncService.syncPaths;
  let emit: ((eventType: string, filename: string | null) => void) | undefined;
  const service = new CollectionWatchService({
    ...portableWatchOptions(),
    collections: [
      {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    eventBus: null,
    scheduler: null,
    store: {
      listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
      listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
      listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    } as unknown as SqliteAdapter,
    flushDebounceMs: 20,
    maxFlushDelayMs: 100,
    watchFactory: ((
      _path: string,
      _options: { recursive: boolean },
      callback: WatchListener<string>
    ) => {
      emit = callback as typeof emit;
      return { close: () => undefined };
    }) as never,
    ...overrides,
  });
  service.start();
  await Bun.sleep(60);
  return {
    touch: (name: string | null = "note.md") => emit?.("change", name),
    cleanup: async () => {
      await service.dispose();
      await safeRm(root);
    },
  };
}

describe("watcher retry backoff", () => {
  test("delay doubles from 500 ms per consecutive failure and is capped", () => {
    expect(watcherRetryDelayMs(1)).toBe(500);
    expect(watcherRetryDelayMs(2)).toBe(1_000);
    expect(watcherRetryDelayMs(3)).toBe(2_000);
    expect(watcherRetryDelayMs(40)).toBe(WATCHER_MAX_RETRY_BACKOFF_MS);
    expect(WATCHER_MAX_RETRY_BACKOFF_MS).toBe(5 * 60_000);
  });

  test("a path that keeps failing is retried less and less often", async () => {
    let calls = 0;
    const watch = await watchNote(async () => {
      calls += 1;
      return failed();
    });
    try {
      watch.touch();
      // Attempts at ~0, +0.5 s, +1.5 s, then +3.5 s. A fixed 500 ms retry
      // would have made five or six attempts in this window.
      await Bun.sleep(2_700);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(calls).toBeLessThanOrEqual(3);
    } finally {
      await watch.cleanup();
    }
  });

  test("a successful flush resets the delay to 500 ms", async () => {
    let calls = 0;
    const watch = await watchNote(async () => {
      calls += 1;
      // Fail twice, succeed once, then fail again on the next change.
      return calls === 3 ? syncResult() : failed();
    });
    try {
      watch.touch();
      // ~0 fail, +0.5 s fail, +1.5 s success; nothing runs after the success.
      await Bun.sleep(2_000);
      expect(calls).toBe(3);
      watch.touch();
      // Fails at once; after a reset the retry follows 500 ms later, not 2 s.
      // The next retry is not due until +1.5 s, so 1 s leaves room both ways.
      await Bun.sleep(1_000);
      expect(calls).toBe(5);
    } finally {
      await watch.cleanup();
    }
  });

  test("an edit to another file is not held back by the failure backoff", async () => {
    const synced: string[][] = [];
    const watch = await watchNote(async (paths) => {
      synced.push(paths);
      return paths.includes("note.md") ? failed() : syncResult();
    });
    try {
      watch.touch();
      // Attempts at ~0, +0.5 s, +1.5 s; the next retry is not due until +3.5 s.
      await Bun.sleep(1_800);
      watch.touch("other.md");
      // A held-back edit would wait for the +3.5 s retry, 1.7 s from now.
      await Bun.sleep(800);
      expect(synced.some((paths) => paths.includes("other.md"))).toBe(true);
    } finally {
      await watch.cleanup();
    }
  });

  test("an edit made while a failing flush runs is not held back", async () => {
    const synced: string[][] = [];
    const watch = await watchNote(async (paths) => {
      synced.push(paths);
      await Bun.sleep(200);
      return paths.includes("note.md") ? failed() : syncResult();
    });
    try {
      watch.touch();
      // Two failed passes put the next retry 1 s after the second one.
      await Bun.sleep(900);
      // The second failing pass is in flight now; edit another file meanwhile.
      watch.touch("other.md");
      await Bun.sleep(500);
      expect(synced.some((paths) => paths.includes("other.md"))).toBe(true);
    } finally {
      await watch.cleanup();
    }
  });

  test("a dirty change whose classification keeps failing also backs off", async () => {
    let storeCalls = 0;
    const watch = await watchNote(async () => syncResult(), {
      store: {
        listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
        listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
        listActiveSourcePaths: async () => {
          storeCalls += 1;
          return {
            ok: false,
            error: { code: "QUERY_FAILED", message: "store boom" },
          };
        },
      } as unknown as SqliteAdapter,
      // No baseline, so the dirty hint is classified against the store.
      buildSnapshot: async () => ({
        status: "fallback",
        reason: "scan_failed",
        durationMs: 0,
        cause: new Error("no baseline"),
      }),
    });
    try {
      // An event without a filename marks the whole root dirty.
      watch.touch(null);
      // Attempts at ~0, +0.5 s, +1.5 s, then +3.5 s. A fixed 500 ms retry
      // would have made five or six attempts in this window.
      await Bun.sleep(2_700);
      expect(storeCalls).toBeGreaterThanOrEqual(2);
      expect(storeCalls).toBeLessThanOrEqual(3);
    } finally {
      await watch.cleanup();
    }
  });
});
