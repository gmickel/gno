/**
 * Undeliverable processor messages (fn-213): a message that cannot be
 * deserialized fails the file with PROCESSOR_MESSAGE_FAILED, replaces the
 * processor, logs one line with context, and the next file succeeds.
 *
 * The child backend gets a real malformed IPC frame; Bun closes the channel
 * on both ends, whichever side it was written to. A worker payload cannot be
 * made to fail from JavaScript, so the worker tests raise the `messageerror`
 * event Bun 1.4.0+ dispatches on the receiving side.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
// node:fs: readdirSync/readlinkSync/writeSync act on raw descriptors; Bun has no equivalent.
import { readdirSync, readlinkSync, writeSync } from "node:fs";

import type { PrepareFileRequest } from "../../src/ingestion/prepare-file";

import {
  fileProcessorsStarted,
  PROCESSOR_MESSAGE_FAILED,
  prepareInProcessor,
  simulateUndeliverableMessage,
  useFileProcessorBackend,
} from "../../src/ingestion/file-processor";
import { DEFAULT_CHUNK_PARAMS } from "../../src/ingestion/types";

afterEach(() => {
  useFileProcessorBackend(null);
});

const BUDGET = { timeoutMs: 20_000, maxMemoryBytes: 64 * 1024 ** 3 };

const request = (relativePath: string): PrepareFileRequest => {
  const bytes = new TextEncoder().encode(`# ${relativePath}\n\nBody text.\n`);
  return {
    input: {
      sourcePath: `/virtual/${relativePath}`,
      relativePath,
      collection: "notes",
      bytes,
      mime: "text/markdown",
      ext: ".md",
      limits: { maxBytes: 1_000_000, timeoutMs: BUDGET.timeoutMs },
    },
    metadataExt: ".md",
    contentTypeRules: [],
    chunkParams: DEFAULT_CHUNK_PARAMS,
    memoryManaged: false,
    markdownSource: true,
    previous: null,
  };
};

const prepare = (relativePath: string, onStarted?: () => void) =>
  prepareInProcessor(request(relativePath), BUDGET, {
    onPrevious: () => undefined,
    onStarted,
  });

/** Socket descriptors this process holds (Linux). */
const sockets = (): Set<string> =>
  new Set(
    readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:");
      } catch {
        return false;
      }
    })
  );

/** Bun's advanced IPC frame: [type 1][u32 LE length][payload]. */
const malformedFrame = (): Uint8Array => {
  const payload = [0xff, 0x0f, 0x99, 0x99, 0x99];
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(1, payload.length, true);
  frame.set(payload, 5);
  return frame;
};

const loggedLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("file processor message lost"));

test.skipIf(process.platform !== "linux")(
  "child backend: a malformed IPC frame fails the file, replaces the child, and the next file succeeds",
  async () => {
    useFileProcessorBackend("child");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const before = sockets();
      const startedBefore = fileProcessorsStarted();
      const outcome = await prepare("broken.md", () => {
        const fresh = [...sockets()].filter((fd) => !before.has(fd));
        expect(fresh.length).toBeGreaterThan(0);
        // Ahead of the job on the same channel: Bun closes it on both ends.
        for (const fd of fresh) writeSync(Number(fd), malformedFrame());
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe(PROCESSOR_MESSAGE_FAILED);
      expect(outcome.error.details).toMatchObject({
        direction: "unknown",
        backend: "child",
      });
      const lines = loggedLines(errors);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("notes/broken.md");
      expect(lines[0]).toContain("backend child");
      expect(lines[0]).toContain("direction unknown");

      const next = await prepare("fine.md");
      expect(next.ok).toBe(true);
      expect(fileProcessorsStarted()).toBe(startedBefore + 2);
    } finally {
      errors.mockRestore();
    }
  },
  30_000
);

for (const direction of ["job", "result"] as const) {
  test(`worker backend: an undeliverable ${direction} message fails the file, replaces the worker, and the next file succeeds`, async () => {
    useFileProcessorBackend("worker");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const startedBefore = fileProcessorsStarted();
      const outcome = await prepare(`broken-${direction}.md`, () => {
        expect(simulateUndeliverableMessage(direction)).toBe(true);
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe(PROCESSOR_MESSAGE_FAILED);
      expect(outcome.error.details).toMatchObject({
        direction,
        backend: "worker",
      });
      const lines = loggedLines(errors);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`notes/broken-${direction}.md`);
      expect(lines[0]).toContain(`direction ${direction}`);
      expect(lines[0]).toContain("backend worker");

      const next = await prepare("fine.md");
      expect(next.ok).toBe(true);
      expect(fileProcessorsStarted()).toBe(startedBefore + 2);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);
}

test("a processor that keeps working logs nothing and is reused", async () => {
  useFileProcessorBackend("worker");
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const startedBefore = fileProcessorsStarted();
    expect((await prepare("a.md")).ok).toBe(true);
    expect((await prepare("b.md")).ok).toBe(true);
    expect(fileProcessorsStarted()).toBe(startedBefore + 1);
    expect(loggedLines(errors)).toHaveLength(0);
  } finally {
    errors.mockRestore();
  }
}, 30_000);
