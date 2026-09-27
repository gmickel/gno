/**
 * File processor disposal (fn-198): a child processor busy in a long
 * synchronous step is stopped at once, and the file fails without hanging.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/mkdir have no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import {
  activeFileProcessorPid,
  disposeFileProcessor,
  useFileProcessorBackend,
} from "../../src/ingestion/file-processor";
import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

let adapter: SqliteAdapter;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gno-processor-dispose-"));
  adapter = new SqliteAdapter();
  expect((await adapter.open(join(tmpDir, "test.db"), "porter")).ok).toBe(true);
});

afterEach(async () => {
  useFileProcessorBackend(null);
  await adapter.close();
  await safeRm(tmpDir);
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "disposing the processor kills a busy child at once and fails its file",
  async () => {
    useFileProcessorBackend("child");
    const root = join(tmpDir, "docs");
    await mkdir(root, { recursive: true });
    const rows = Array.from(
      { length: 80_000 },
      (_, row) => `| row ${row} | \`code ${row}\` | [[n${row}]] | 1.5 |`
    );
    await Bun.write(
      join(root, "big-table.md"),
      ["| a | b | c | d |", "| --- | --- | --- | --- |", ...rows].join("\n")
    );
    const collection: Collection = {
      name: "docs",
      path: root,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    expect((await adapter.syncCollections([collection])).ok).toBe(true);

    const syncing = new SyncService().syncCollection(collection, adapter, {
      limits: { timeoutMs: 60_000 },
    });
    let pid: number | null = null;
    for (let tries = 0; tries < 200 && pid === null; tries += 1) {
      await Bun.sleep(25);
      pid = activeFileProcessorPid();
    }
    expect(pid).not.toBeNull();
    // Let the child load and enter the long code-region step.
    await Bun.sleep(1500);

    const stoppedAt = performance.now();
    disposeFileProcessor();
    while (pidAlive(pid ?? 0) && performance.now() - stoppedAt < 1000) {
      await Bun.sleep(10);
    }

    expect(pidAlive(pid ?? 0)).toBe(false);
    const result = await syncing;
    expect(result.errors).toEqual([
      expect.objectContaining({ relPath: "big-table.md" }),
    ]);
  },
  30_000
);
