/**
 * fn-202 R3: writer-lease contention keeps its fixed 5 s retry. Fresh edits
 * skip the failure backoff, but they must not probe a held lease at event rate.
 */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import { portableWatchOptions } from "./helpers/watch-portable-fixtures";

describe("watcher lease retry", () => {
  test("fresh edits do not cut the lease-contention retry short", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-lease-"));
    await writeFile(join(root, "note.md"), "x");
    let leaseAttempts = 0;
    let emit:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
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
      // Another writer holds the lease for the whole test.
      acquireWriteLease: async () => {
        leaseAttempts += 1;
        return null;
      },
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        emit = callback as typeof emit;
        return { close: () => undefined };
      }) as never,
    });
    try {
      service.start();
      await Bun.sleep(60);
      emit?.("change", "note.md");
      await Bun.sleep(100);
      expect(leaseAttempts).toBe(1);
      // Keep editing well inside the 5 s lease retry window.
      for (let edit = 0; edit < 8; edit += 1) {
        emit?.("change", "note.md");
        await Bun.sleep(100);
      }
      expect(leaseAttempts).toBe(1);
    } finally {
      await service.dispose();
      await safeRm(root);
    }
  });
});
