/**
 * fn-207 R2: a session import child is bounded by a timeout, killed when its
 * resident shuts down, and exits when its parent dies.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises — mkdir is a directory-structure op
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";

import {
  importInChildProcess,
  killImportChildren,
} from "../../src/sessions/import-child";
import { addSessionSource, initSessionArchive } from "../../src/sessions/setup";
import { safeRm } from "../helpers/cleanup";
import {
  snapshotSessionEnv,
  tempDir,
  writeSyntheticCodexRollouts,
} from "./helpers";

let root: string;
let config: Config;
let configPath: string;
const restoreEnv = snapshotSessionEnv();

beforeEach(async () => {
  root = await tempDir("gno-import-child-lifecycle-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  const sourceRoot = join(root, "sources", "codex");
  await mkdir(sourceRoot, { recursive: true });
  // Large enough (~6 s to import) that an import is still running when it is
  // interrupted.
  await writeSyntheticCodexRollouts(sourceRoot, 400, 200);
  configPath = join(root, "archive.yml");
  await initSessionArchive({
    configPath,
    indexName: "sessions",
    archiveRoot: join(root, "archive"),
    collection: "sessions",
  });
  config = await addSessionSource({
    configPath,
    id: "codex-test",
    harness: "codex",
    path: sourceRoot,
    collection: "sessions",
  });
});

afterEach(async () => {
  restoreEnv();
  await safeRm(root);
});

const request = () => ({
  config,
  configPath,
  indexName: "sessions",
  sourceId: "codex-test",
  dryRun: false,
});

test("an import that overruns its timeout is killed", async () => {
  const started = Date.now();
  const error = await importInChildProcess(request(), {
    timeoutMs: 300,
  }).then(
    () => null,
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("session import timed out");
  expect(Date.now() - started).toBeLessThan(5_000);
}, 30_000);

test("resident shutdown kills a running import child", async () => {
  const importing = importInChildProcess(request());
  await Bun.sleep(500);
  const started = Date.now();
  killImportChildren();
  const error = await importing.then(
    () => null,
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(Error);
  expect(Date.now() - started).toBeLessThan(5_000);
}, 30_000);

test.skipIf(process.platform !== "linux")(
  "an import child exits when its parent is SIGKILLed",
  async () => {
    // Stand-in resident: runs one import in a child, then is SIGKILLed.
    const script = `const { importInChildProcess } = await import(${JSON.stringify(
      join(import.meta.dir, "../../src/sessions/import-child.ts")
    )}); void importInChildProcess(${JSON.stringify(request())}).catch(() => {}); await Bun.sleep(600000);`;
    const parent = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      env: process.env as Record<string, string>,
      stdout: "ignore",
      stderr: "ignore",
    });
    const childOf = async (pid: number): Promise<number | null> => {
      const children = await Bun.file(
        `/proc/${pid}/task/${pid}/children`
      ).text();
      const first = children.trim().split(/\s+/)[0];
      return first ? Number(first) : null;
    };
    let child: number | null = null;
    for (let i = 0; i < 50 && child === null; i += 1) {
      await Bun.sleep(100);
      child = await childOf(parent.pid).catch(() => null);
    }
    expect(child).not.toBeNull();
    await Bun.sleep(500);
    parent.kill("SIGKILL");
    await parent.exited;
    const alive = () => {
      try {
        process.kill(child as number, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Well before the import would have finished on its own.
    const deadline = Date.now() + 2_000;
    while (alive() && Date.now() < deadline) await Bun.sleep(50);
    const stillAlive = alive();
    if (stillAlive) process.kill(child as number, "SIGKILL");
    expect(stillAlive).toBe(false);
  },
  60_000
);
