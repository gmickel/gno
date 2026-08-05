import { afterAll, describe, expect, test } from "bun:test";
/**
 * Real-filesystem capture of what Bun's recursive `node:fs.watch` actually
 * reports for the write/delete sequences that matter to fn-114.
 *
 * This file captures event SHAPE. It asserts only invariants that were
 * observed to hold on BOTH captured platforms, because the behaviour under
 * investigation is platform-specific; everything else is recorded rather than
 * asserted. Encoding one platform's defect as an expectation would make the
 * suite lie on the other.
 *
 * Captured with Bun 1.3.11 on darwin 25.5.0 and on linux (Debian container,
 * verified against a `tmpfs` mount so the events are genuine inotify and not a
 * degraded bind mount). See the fixture comment in `watch-service.test.ts` for
 * the recorded tuples the RED tests replay.
 *
 * The shapes are ALSO not stable across Bun PATCH releases: 1.3.14 on Linux
 * reports a recursive directory delete as one arbitrary surviving child name
 * rather than the directory. Assertions here are therefore kept to what held on
 * every capture; the fn-114 outcome guarantees live in
 * `watch-service.lifecycle.fs.test.ts`, which never asserts a shape.
 *
 * ## Synchronization (R8: no fixed sleep as a settle signal)
 *
 * The end of a scenario is established in two observed steps, never by a fixed
 * sleep standing in for a settle:
 *
 * 1. **Quiescence** — wait for a window in which the watcher reported nothing.
 *    The window RESTARTS on every event, so it is driven by observed watcher
 *    activity rather than by a guess about how long the platform needs.
 * 2. **Cookie confirmation** — write a uniquely named file into a watched
 *    directory and wait for the watcher to report *that file*. A positively
 *    observed cookie proves the watcher is still live and that everything it
 *    intends to deliver for the preceding operations has been delivered, since
 *    a single inotify fd delivers in order. This is Watchman's cookie
 *    technique. Cookie events are filtered out of the captured sequences.
 *
 * Both steps are needed because of two captured Bun/Linux behaviours:
 *
 * - Operations that land in the SAME watcher read batch collapse to a single
 *   delivered event (measured: a ~5 ms separation is enough to split them; 300
 *   rapid writes delivered 20 events). A cookie written immediately after the
 *   action would therefore destroy the action's own event — hence the
 *   quiescence step before the cookie, and again after it so the next action
 *   starts a fresh batch.
 * - Cookies are deliberately NOT dot-prefixed: Bun's Linux recursive watcher
 *   never reports dot-prefixed names at all, so a dotfile cookie would hang.
 *   A dropped cookie is retried until one is observed or the bound expires.
 *
 * Every scenario is its own test with its own temp root and its own watcher,
 * so no scenario can inherit or contaminate another's events. Directories a
 * scenario acts inside are created BEFORE the watcher starts, because Bun's
 * Linux watcher does not extend recursion to subdirectories created after the
 * watch began (captured below as `newSubdirectoryWrite`).
 *
 * Set GNO_WATCH_CAPTURE_OUT=<path> to write the captured sequences as JSON for
 * task evidence. Nothing is written when the suite skipped.
 */
import { mkdtempSync, rmSync, watch } from "node:fs";
// node:fs/promises is used for mkdtemp/mkdir/rename/unlink/rm: Bun has no
// native equivalents for temp-directory creation or filesystem structure ops.
import { mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { platform, release, tmpdir } from "node:os";
import { basename, join } from "node:path";

type CapturedEvent = readonly [eventType: string, filename: string | null];

const HARD_TIMEOUT_MS = 20_000;
const EVENT_WAIT_MS = 8000;
const COOKIE_RETRY_MS = 200;
/**
 * Watcher-silence window. Comfortably above the ~5 ms batch separation measured
 * on Bun 1.3.11/Linux; it is a no-activity detector, not a settle estimate.
 */
const QUIET_MS = 120;
const COOKIE_PREFIX = "gno-cookie-";

/**
 * Error codes that genuinely mean "this runtime/platform cannot do a recursive
 * watch". Anything else (EACCES, EMFILE, ENOSPC, an unexpected TypeError from a
 * watcher regression) is a real failure and must surface as one rather than
 * masquerading as an unsupported platform (R8).
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
 * ONLY a recognized unsupported-recursive-watch failure yields a skip; every
 * other error is rethrown at module load so it cannot hide behind "unsupported
 * platform".
 */
const recursiveWatchSupported = (() => {
  let probeDir: string | undefined;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "gno-watch-probe-"));
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

const capture: Record<string, CapturedEvent[]> = {};

afterAll(async () => {
  const outPath = process.env.GNO_WATCH_CAPTURE_OUT;
  // Never write a capture file for a run that produced no capture: an empty or
  // stale artifact presented as evidence is worse than no artifact.
  if (!outPath || Object.keys(capture).length === 0) {
    return;
  }
  await Bun.write(
    outPath,
    `${JSON.stringify(
      {
        platform: platform(),
        release: release(),
        bun: Bun.version,
        sequences: capture,
      },
      null,
      2
    )}\n`
  );
});

type Recorder = {
  /**
   * Closes the current scenario: waits for observed watcher quiescence, then
   * confirms a cookie written into `dir` (collection-relative, "" for the
   * watched root), then quiesces again so the next action starts a fresh
   * watcher read batch. Returns every non-cookie event observed since the
   * previous boundary.
   */
  settle(dir?: string): Promise<CapturedEvent[]>;
  close(): void;
};

function createRecorder(root: string): Recorder {
  const events: CapturedEvent[] = [];
  let notify: (() => void) | null = null;
  let received = 0;
  let cookieSeq = 0;

  const watcher = watch(root, { recursive: true }, (eventType, filename) => {
    received += 1;
    events.push([
      String(eventType),
      filename === null || filename === undefined
        ? null
        : String(filename).replaceAll("\\", "/"),
    ]);
    notify?.();
  });

  const isCookie = (event: CapturedEvent): boolean =>
    event[1] !== null && basename(event[1]).startsWith(COOKIE_PREFIX);

  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  /**
   * Waits until the watcher has reported nothing for a full QUIET_MS window.
   * The window restarts on every observed event, so the wait tracks real
   * watcher activity instead of assuming a settle duration.
   */
  const quiesce = async (deadline: number): Promise<void> => {
    for (;;) {
      const before = received;
      await delay(QUIET_MS);
      if (received === before) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `watcher never went quiet within the bound; observed ${JSON.stringify(events)}`
        );
      }
    }
  };

  return {
    async settle(dir = ""): Promise<CapturedEvent[]> {
      const deadline = Date.now() + EVENT_WAIT_MS;
      await quiesce(deadline);

      const pending = new Set<string>();
      const seen = () =>
        events.some((event) => event[1] !== null && pending.has(event[1]));

      while (!seen()) {
        if (Date.now() >= deadline) {
          throw new Error(
            `no cookie in ${dir || "<root>"} reported within ${EVENT_WAIT_MS}ms after ${cookieSeq} attempts; observed ${JSON.stringify(events)}`
          );
        }
        cookieSeq += 1;
        const cookieName = `${COOKIE_PREFIX}${cookieSeq}.cookie`;
        const relative = dir ? `${dir}/${cookieName}` : cookieName;
        pending.add(relative);
        pending.add(cookieName);
        await Bun.write(join(root, relative), "cookie");

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            notify = null;
            resolve();
          }, COOKIE_RETRY_MS);
          notify = () => {
            if (seen()) {
              clearTimeout(timer);
              notify = null;
              resolve();
            }
          };
        });
      }

      // Separate this boundary from the next scenario action's read batch.
      await quiesce(Date.now() + EVENT_WAIT_MS);
      return events.splice(0, events.length).filter((e) => !isCookie(e));
    },
    close(): void {
      notify = null;
      watcher.close();
    },
  };
}

/**
 * Runs one scenario against a freshly created watched temp root. `seed` runs
 * BEFORE the watcher exists (directories a scenario writes into must pre-exist,
 * see the module comment); the watcher is then proven live by an event-driven
 * readiness cookie, never a sleep.
 */
async function withWatchedRoot(
  label: string,
  options: {
    seed?: (root: string) => Promise<void>;
    body: (root: string, recorder: Recorder) => Promise<void>;
  }
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `gno-watch-${label}-`));
  await options.seed?.(root);
  const recorder = createRecorder(root);
  try {
    await recorder.settle();
    await options.body(root, recorder);
  } finally {
    recorder.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Tuple shape only — safe for scenarios whose event set is platform-divergent. */
function expectTuplesWellFormed(sequence: CapturedEvent[]): void {
  for (const [eventType, filename] of sequence) {
    expect(typeof eventType).toBe("string");
    expect(filename === null || typeof filename === "string").toBe(true);
  }
}

function expectReported(label: string, sequence: CapturedEvent[]): void {
  expect(sequence.length, `${label} reported no events`).toBeGreaterThan(0);
  expectTuplesWellFormed(sequence);
}

const shapeTest = test.skipIf(!recursiveWatchSupported);

describe("recursive fs.watch event shapes", () => {
  shapeTest(
    "direct create of an eligible file",
    async () => {
      await withWatchedRoot("direct", {
        body: async (root, recorder) => {
          await Bun.write(join(root, "direct.md"), "# direct\n");
          capture.directCreate = await recorder.settle();

          expectReported("directCreate", capture.directCreate);
          expect(capture.directCreate.map(([, name]) => name)).toContain(
            "direct.md"
          );
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "atomic save through a plain (non-dot) temp name",
    async () => {
      await withWatchedRoot("atomic-plain", {
        body: async (root, recorder) => {
          await Bun.write(join(root, "note.md.tmp"), "# atomic\n");
          await rename(join(root, "note.md.tmp"), join(root, "note.md"));
          capture.atomicCreatePlainTemp = await recorder.settle();

          expectReported(
            "atomicCreatePlainTemp",
            capture.atomicCreatePlainTemp
          );
          // Universal: the SOURCE (temp) name is reported on both platforms.
          // Whether the DESTINATION is ALSO reported is the divergence under
          // investigation (macOS: yes; Linux: no — oven-sh/bun#36328), so it is
          // recorded, never asserted.
          expect(
            capture.atomicCreatePlainTemp.map(([, name]) => name)
          ).toContain("note.md.tmp");
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "atomic save through a dot-prefixed temp name",
    async () => {
      await withWatchedRoot("atomic-hidden", {
        body: async (root, recorder) => {
          await Bun.write(join(root, ".gno-tmp.abc123"), "# atomic\n");
          await rename(
            join(root, ".gno-tmp.abc123"),
            join(root, "hidden-atomic.md")
          );
          capture.atomicCreateHiddenTemp = await recorder.settle();

          // Fully divergent: macOS reports both names, Linux reports only the
          // destination (it never reports dot-prefixed names at all). Recorded,
          // not asserted.
          expectTuplesWellFormed(capture.atomicCreateHiddenTemp);
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "atomic replacement of an existing eligible file in a nested directory",
    async () => {
      await withWatchedRoot("atomic-replace", {
        seed: async (root) => {
          await mkdir(join(root, "nested"), { recursive: true });
          await Bun.write(join(root, "nested", "note.md"), "# v1\n");
        },
        body: async (root, recorder) => {
          await Bun.write(join(root, "nested", "note.md.tmp"), "# v2\n");
          await rename(
            join(root, "nested", "note.md.tmp"),
            join(root, "nested", "note.md")
          );
          capture.atomicReplaceNested = await recorder.settle("nested");

          expectReported("atomicReplaceNested", capture.atomicReplaceNested);
          expect(capture.atomicReplaceNested.map(([, name]) => name)).toContain(
            "nested/note.md.tmp"
          );
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "deletion of a single eligible file",
    async () => {
      await withWatchedRoot("delete-file", {
        seed: (root) => Bun.write(join(root, "direct.md"), "# direct\n").then(),
        body: async (root, recorder) => {
          await unlink(join(root, "direct.md"));
          capture.fileDeletion = await recorder.settle();

          expectReported("fileDeletion", capture.fileDeletion);
          // Universal: a single-file delete names the file. This is why the
          // existing green deletion test passes.
          expect(capture.fileDeletion.map(([, name]) => name)).toContain(
            "direct.md"
          );
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "recursive deletion of a directory holding eligible files",
    async () => {
      await withWatchedRoot("delete-dir", {
        seed: async (root) => {
          await mkdir(join(root, "dir1"), { recursive: true });
          await Bun.write(join(root, "dir1", "a.md"), "# a\n");
          await Bun.write(join(root, "dir1", "b.md"), "# b\n");
        },
        body: async (root, recorder) => {
          await rm(join(root, "dir1"), { recursive: true, force: true });
          capture.recursiveDirectoryDeletion = await recorder.settle();

          expectReported(
            "recursiveDirectoryDeletion",
            capture.recursiveDirectoryDeletion
          );
          // NOT stable across Bun PATCH releases - this is a capture, not a
          // contract. Three shapes have been observed for the same `rm -rf`:
          //
          //   Bun 1.3.11 / Linux  -> ["dir1"]              (directory only)
          //   Bun 1.3.14 / Linux  -> ["dir1/b.md"]         (ONE ARBITRARY child;
          //                          a container on the same version reported
          //                          `dir1/a.md` instead - which child is named
          //                          is not deterministic either)
          //   macOS               -> children + "dir1"
          //
          // An earlier revision asserted `toContain("dir1")` and started failing
          // on 1.3.14 with `Received: [ "dir1/b.md" ]`. The only invariant that
          // held on every capture is that SOMETHING under the removed directory
          // is named - so that, and only that, is asserted. The OUTCOME the fix
          // actually promises (every indexed document beneath the removed
          // directory becomes inactive) is asserted in
          // `watch-service.lifecycle.fs.test.ts`, which is shape-independent by
          // construction.
          const reported = capture.recursiveDirectoryDeletion
            .map(([, name]) => name)
            .filter((name): name is string => name !== null);
          expect(
            reported.some(
              (name) => name === "dir1" || name.startsWith("dir1/")
            ),
            `recursiveDirectoryDeletion named nothing under dir1: ${JSON.stringify(reported)}`
          ).toBe(true);
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "write inside a subdirectory created after the watch began",
    async () => {
      await withWatchedRoot("new-subdir", {
        body: async (root, recorder) => {
          await mkdir(join(root, "post"), { recursive: true });
          await recorder.settle();

          await Bun.write(join(root, "post", "d.md"), "# d\n");
          // The cookie goes in the ROOT: on Linux the new subdirectory is not
          // watched at all, so a cookie written inside it would never arrive.
          capture.newSubdirectoryWrite = await recorder.settle();

          // Divergent: macOS reports `post/d.md`; Linux reports nothing,
          // because recursion does not extend to directories created after the
          // watch began. Recorded, not asserted.
          expectTuplesWellFormed(capture.newSubdirectoryWrite);
        },
      });
    },
    HARD_TIMEOUT_MS
  );

  shapeTest(
    "case-only rename of an eligible file",
    async () => {
      await withWatchedRoot("case-rename", {
        seed: (root) => Bun.write(join(root, "Foo.md"), "# foo\n").then(),
        body: async (root, recorder) => {
          await rename(join(root, "Foo.md"), join(root, "foo.md"));
          capture.caseOnlyRename = await recorder.settle();

          expectTuplesWellFormed(capture.caseOnlyRename);
        },
      });
    },
    HARD_TIMEOUT_MS
  );
});
