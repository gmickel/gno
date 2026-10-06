/**
 * fn-208: every resident read refreshes the config; an unchanged file is not
 * re-read and re-parsed each time, while edits and broken files still apply.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises mkdir: directory creation, no Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { loadConfig, saveConfigToPath } from "../../src/config";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import { safeRm } from "../helpers/cleanup";
import { snapshotSessionEnv, tempDir } from "../sessions/helpers";

let root: string;
let configPath: string;
let runtime: ResidentRuntime | undefined;
const restoreEnv = snapshotSessionEnv();

const collection = (name: string): Collection => ({
  name,
  path: join(root, name),
  pattern: "**/*.md",
  include: [],
  exclude: [],
});

const configWith = (...names: string[]): Config => ({
  version: "1.0",
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: names.map(collection),
  contexts: [],
});

beforeEach(async () => {
  root = await tempDir("gno-config-refresh-stamp-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "index.yml");
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  await saveConfigToPath(configWith("alpha"), configPath);
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  restoreEnv();
  await safeRm(root);
});

test("an unchanged config file is read once; an edit or a broken file is not missed", async () => {
  let loads = 0;
  const started = await startResidentRuntime(
    { configPath, index: "stamp", offline: true },
    {
      loadConfig: (path) => {
        loads += 1;
        return loadConfig(path);
      },
    }
  );
  if (!started.success) throw new Error(started.error);
  runtime = started.runtime;
  const refresh = () => (runtime as ResidentRuntime).refreshConfig?.();

  await refresh();
  const afterFirst = loads;
  for (let i = 0; i < 5; i += 1) await refresh();
  expect(loads).toBe(afterFirst);

  await saveConfigToPath(configWith("alpha", "beta"), configPath);
  await refresh();
  expect(loads).toBe(afterFirst + 1);
  expect(runtime.config.collections.map(({ name }) => name).sort()).toEqual([
    "alpha",
    "beta",
  ]);

  await Bun.write(configPath, "version: [not valid\n");
  const failed = async (): Promise<boolean> =>
    await Promise.resolve(refresh()).then(
      () => false,
      () => true
    );
  expect(await failed()).toBe(true);
  // Still an error on the next request, never the stale config.
  expect(await failed()).toBe(true);
});
