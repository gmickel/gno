/**
 * Real-filesystem, end-to-end proof of the fn-114 watch-to-index lifecycle (R8).
 *
 * Every other test for this feature replays CAPTURED watcher tuples through a
 * fake `watchFactory` and a fake sync service. Those prove the reconciliation
 * ALGEBRA. They cannot prove the claim the spec actually makes to a user:
 *
 *   an atomic save becomes retrievable, and a deleted directory's children
 *   become inactive, WITHOUT a manual `gno update`.
 *
 * So nothing in the chain under test is faked here. A real temp directory, a
 * real recursive `node:fs.watch` (the service's default `watchFactory`), the
 * real `defaultSyncService` ingestion path, and a real on-disk SQLite store.
 * The assertions are OBSERVABLE queries against that store - a BM25 search for
 * a token that only exists inside the saved file, and the `active` flag of the
 * deleted directory's indexed children - never a spy on `syncPaths`.
 *
 * ## Why the assertions are outcomes, not event shapes
 *
 * The watcher's event SHAPE for these two sequences is platform-divergent and
 * is captured (never asserted) in `watch-service.fs-smoke.test.ts`:
 *
 * - an atomic save through a plain temp name reports only the SOURCE name on
 *   Linux, and both source and destination on macOS;
 * - a recursive directory delete reports only the bare DIRECTORY on Linux, and
 *   the removed children as well on macOS.
 *
 * The OUTCOME is identical on both, and the outcome is what fn-114 promises, so
 * that is what this file asserts. The same assertions therefore hold on macOS
 * and on Linux, which is what makes the Linux run of this file the evidence
 * that closes the original report.
 *
 * ## Synchronization (R8: no fixed sleep as a settle signal)
 *
 * Two mechanisms, both observed rather than assumed:
 *
 * 1. **Liveness cookie** - before each scenario's action, an eligible cookie
 *    file is written into the watched root and we wait until *that document* is
 *    active in the store. A positively observed cookie proves the entire chain
 *    (watcher -> debounce -> reconcile -> ingest -> store) is live, so a later
 *    timeout is a real defect rather than a race with startup. Cookies are not
 *    dot-prefixed: Bun's Linux recursive watcher never reports dot-prefixed
 *    names at all, so a dotfile cookie would hang.
 * 2. **Outcome wait** - `waitFor` re-runs the scenario's own observable store
 *    query until it holds or a bound expires. The short interval is a RETRY
 *    cadence, not a settle estimate: no duration is ever treated as proof that
 *    the pipeline finished, and a passing test has only ever observed the real
 *    end state.
 *
 * Each scenario owns its temp root, its store, and its watcher, so no scenario
 * can inherit or contaminate another's state. Cleanup is unconditional.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, watch } from "node:fs";
// node:fs/promises is used for mkdtemp/mkdir/rename/rm: Bun has no native
// equivalents for temp-directory creation or filesystem structure operations.
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

/** Per-test hard bound. Generous: containers and cold FTS are slow. */
const HARD_TIMEOUT_MS = 60_000;
/** Bound on any single observed-outcome wait. */
const WAIT_MS = 25_000;
/** Retry cadence for re-running an observable query. Not a settle estimate. */
const POLL_MS = 25;
const COOKIE_PREFIX = "gno-cookie-";

/**
 * Error codes that genuinely mean "this runtime/platform cannot do a recursive
 * watch". Anything else (EACCES, EMFILE, ENOSPC, a watcher regression) is a
 * real failure and must surface as one rather than masquerading as an
 * unsupported platform (R8).
 */
const UNSUPPORTED_CODES = new Set([
  "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

function isRecursiveWatchUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && UNSUPPORTED_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("recursive") && message.includes("not supported");
}

/**
 * Probe once, synchronously, so the suite can skip cleanly instead of hanging.
 * ONLY a recognized unsupported-recursive-watch failure yields a skip.
 */
const recursiveWatchSupported = (() => {
  let probeDir: string | undefined;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "gno-lifecycle-probe-"));
    const watcher = watch(probeDir, { recursive: true }, () => undefined);
    watcher.close();
    return true;
  } catch (error) {
    if (isRecursiveWatchUnsupported(error)) {
      return false;
    }
    throw error;
  } finally {
    if (probeDir) {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }
})();

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);
const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);

afterEach(() => {
  // Nothing here mocks the sync service; this restores it if a sibling suite
  // sharing the module singleton left it patched.
  defaultSyncService.syncPaths = originalSyncPaths;
  defaultSyncService.syncCollection = originalSyncCollection;
});

interface Harness {
  /** The watched collection root. Never holds the SQLite file. */
  root: string;
  store: SqliteAdapter;
  collection: Collection;
  /**
   * Re-runs `probe` until it resolves true or the bound expires. `describe`
   * renders the current observed state into the timeout message so a failure
   * says what the store actually held.
   */
  waitFor(
    label: string,
    probe: () => Promise<boolean>,
    describeState: () => Promise<string>
  ): Promise<void>;
  /**
   * Proves the whole watcher -> ingest -> store chain is live by writing an
   * eligible cookie into the watched root and waiting until that document is
   * active in the store.
   */
  confirmChainLive(): Promise<void>;
  /** True when the collection has an ACTIVE indexed document at `relPath`. */
  isActive(relPath: string): Promise<boolean>;
  /** relPath -> active, for every indexed document in the collection. */
  snapshot(): Promise<string>;
  /** relPaths retrievable by a BM25 search for `token`. */
  searchRelPaths(token: string): Promise<string[]>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Builds a fully real harness, runs `body`, and tears everything down
 * unconditionally. `seed` runs BEFORE the initial sync and before the watcher
 * exists - directories a scenario acts inside must pre-exist, because Bun's
 * Linux recursive watcher does not extend recursion to subdirectories created
 * after the watch began.
 */
async function withLifecycleHarness(
  label: string,
  options: {
    seed?: (root: string) => Promise<void>;
    body: (harness: Harness) => Promise<void>;
  }
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), `gno-lifecycle-${label}-`));
  // The store lives OUTSIDE the watched root so SQLite's own writes can never
  // be mistaken for collection activity.
  const root = join(tempDir, "collection");
  await mkdir(root, { recursive: true });
  await options.seed?.(root);

  const collection: Collection = {
    name: "notes",
    path: root,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };

  const store = new SqliteAdapter();
  let service: CollectionWatchService | null = null;
  try {
    const opened = await store.open(join(tempDir, "index.sqlite"), "porter");
    expect(opened.ok).toBe(true);
    expect((await store.syncCollections([collection])).ok).toBe(true);
    // Real initial sync: whatever `seed` wrote is indexed and active, exactly
    // as a `gno update` before the daemon starts would leave it.
    await defaultSyncService.syncCollection(collection, store, {
      runUpdateCmd: false,
    });

    const isActive = async (relPath: string): Promise<boolean> => {
      const row = await store.getDocument(collection.name, relPath);
      return row.ok && row.value !== null && row.value.active;
    };

    const snapshot = async (): Promise<string> => {
      const rows = await store.listDocuments(collection.name);
      if (!rows.ok) {
        return `<listDocuments failed: ${rows.error.message}>`;
      }
      return JSON.stringify(rows.value.map((row) => [row.relPath, row.active]));
    };

    const searchRelPaths = async (token: string): Promise<string[]> => {
      const results = await store.searchFts(token, {
        collection: collection.name,
      });
      if (!results.ok) {
        return [];
      }
      const relPaths = new Set<string>();
      for (const hit of results.value) {
        if (hit.relPath) {
          relPaths.add(hit.relPath);
        }
      }
      return [...relPaths];
    };

    let cookieSeq = 0;
    const harness: Harness = {
      root,
      store,
      collection,
      isActive,
      snapshot,
      searchRelPaths,
      async waitFor(waitLabel, probe, describeState) {
        const deadline = Date.now() + WAIT_MS;
        for (;;) {
          if (await probe()) {
            return;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `${waitLabel} not observed within ${WAIT_MS}ms; store held ${await describeState()}`
            );
          }
          await delay(POLL_MS);
        }
      },
      async confirmChainLive() {
        cookieSeq += 1;
        const cookie = `${COOKIE_PREFIX}${cookieSeq}.md`;
        await Bun.write(join(root, cookie), `# cookie ${cookieSeq}\n`);
        await harness.waitFor(
          `liveness cookie ${cookie}`,
          () => isActive(cookie),
          snapshot
        );
      },
    };

    service = new CollectionWatchService({
      collections: [collection],
      store,
      scheduler: null,
      eventBus: null,
    });
    service.start();
    expect(service.getState().failedCollections).toEqual([]);
    expect(service.getState().activeCollections).toEqual([collection.name]);

    await options.body(harness);
  } finally {
    await service?.dispose();
    await store.close();
    await safeRm(tempDir);
  }
}

const lifecycleTest = test.skipIf(!recursiveWatchSupported);

describe("watch-to-index lifecycle on a real filesystem", () => {
  lifecycleTest(
    "an atomic save becomes retrievable without a manual update",
    async () => {
      await withLifecycleHarness("atomic-save", {
        body: async (harness) => {
          await harness.confirmChainLive();

          // A genuine atomic save: write a sibling temp file, then rename it
          // over the destination. On Linux the watcher reports only
          // `note.md.tmp`; on macOS it reports both names. Neither shape is
          // asserted - only that the saved document ends up retrievable.
          const token = "kryptonite";
          await Bun.write(
            join(harness.root, "note.md.tmp"),
            `# Atomic\n\n${token} lands through a rename.\n`
          );
          await rename(
            join(harness.root, "note.md.tmp"),
            join(harness.root, "note.md")
          );

          await harness.waitFor(
            "atomically saved note.md retrievable by search",
            async () =>
              (await harness.searchRelPaths(token)).includes("note.md"),
            () => harness.snapshot()
          );

          expect(await harness.searchRelPaths(token)).toEqual(["note.md"]);
          expect(await harness.isActive("note.md")).toBe(true);
          // The temp source must never survive as an indexed document.
          const tempRow = await harness.store.getDocument(
            harness.collection.name,
            "note.md.tmp"
          );
          expect(tempRow).toMatchObject({ ok: true, value: null });
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  lifecycleTest(
    "a recursively deleted directory's children become inactive",
    async () => {
      await withLifecycleHarness("delete-dir", {
        seed: async (root) => {
          await mkdir(join(root, "dir1"), { recursive: true });
          await Bun.write(join(root, "dir1", "a.md"), "# A\n\nblueberry\n");
          await Bun.write(join(root, "dir1", "b.md"), "# B\n\nblueberry\n");
          await Bun.write(join(root, "keep.md"), "# Keep\n\nblueberry\n");
        },
        body: async (harness) => {
          // The initial sync indexed all three; that is the precondition the
          // deletion has to undo.
          expect(await harness.isActive("dir1/a.md")).toBe(true);
          expect(await harness.isActive("dir1/b.md")).toBe(true);
          expect(await harness.isActive("keep.md")).toBe(true);
          expect((await harness.searchRelPaths("blueberry")).sort()).toEqual([
            "dir1/a.md",
            "dir1/b.md",
            "keep.md",
          ]);

          await harness.confirmChainLive();

          // A genuine recursive removal. On Linux the watcher reports only
          // `dir1`, with no child events at all - the exact shape that left
          // stale active documents behind before fn-114.
          await rm(join(harness.root, "dir1"), {
            recursive: true,
            force: true,
          });

          await harness.waitFor(
            "both children of the deleted directory marked inactive",
            async () =>
              !(
                (await harness.isActive("dir1/a.md")) ||
                (await harness.isActive("dir1/b.md"))
              ),
            () => harness.snapshot()
          );

          expect(await harness.isActive("dir1/a.md")).toBe(false);
          expect(await harness.isActive("dir1/b.md")).toBe(false);
          // Bounded: the untouched sibling outside the deleted directory is
          // still indexed and still retrievable.
          expect(await harness.isActive("keep.md")).toBe(true);
          expect(await harness.searchRelPaths("blueberry")).toEqual([
            "keep.md",
          ]);
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  lifecycleTest(
    "a deleted directory's DEEPLY nested children become inactive too",
    async () => {
      await withLifecycleHarness("delete-dir-deep", {
        seed: async (root) => {
          await mkdir(join(root, "dir1", "sub", "deeper"), { recursive: true });
          await Bun.write(join(root, "dir1", "a.md"), "# A\n\ncranberry\n");
          await Bun.write(
            join(root, "dir1", "sub", "c.md"),
            "# C\n\ncranberry\n"
          );
          await Bun.write(
            join(root, "dir1", "sub", "deeper", "d.md"),
            "# D\n\ncranberry\n"
          );
          await Bun.write(join(root, "keep.md"), "# Keep\n\ncranberry\n");
        },
        body: async (harness) => {
          expect((await harness.searchRelPaths("cranberry")).sort()).toEqual([
            "dir1/a.md",
            "dir1/sub/c.md",
            "dir1/sub/deeper/d.md",
            "keep.md",
          ]);

          await harness.confirmChainLive();

          // The whole subtree goes at once. Whatever the runtime reports for
          // it - the bare directory (Bun 1.3.11), one arbitrary child at some
          // depth (1.3.14), or children plus directory (macOS) - every indexed
          // document beneath the removed directory must end up inactive. Only
          // depth ONE was guaranteed before this change; `dir1/sub/deeper/d.md`
          // is what proves the depth limit is gone.
          await rm(join(harness.root, "dir1"), {
            recursive: true,
            force: true,
          });

          await harness.waitFor(
            "every document under the deleted directory marked inactive",
            async () =>
              !(
                (await harness.isActive("dir1/a.md")) ||
                (await harness.isActive("dir1/sub/c.md")) ||
                (await harness.isActive("dir1/sub/deeper/d.md"))
              ),
            () => harness.snapshot()
          );

          expect(await harness.isActive("dir1/a.md")).toBe(false);
          expect(await harness.isActive("dir1/sub/c.md")).toBe(false);
          expect(await harness.isActive("dir1/sub/deeper/d.md")).toBe(false);
          expect(await harness.isActive("keep.md")).toBe(true);
          expect(await harness.searchRelPaths("cranberry")).toEqual([
            "keep.md",
          ]);
        },
      });
    },
    HARD_TIMEOUT_MS
  );
});
