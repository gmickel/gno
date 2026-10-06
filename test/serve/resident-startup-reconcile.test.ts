/**
 * fn-205: a resident `gno serve` reconciles its collections with the disk at
 * startup, so notes added, edited or deleted while no resident ran reach the
 * index without a manual sync. `gno daemon` keeps its own initial sync.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises mkdir/unlink: directory creation and file removal, no Bun equivalent.
import { mkdir, unlink } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ResidentRuntime } from "../../src/serve/resident-runtime";

import { saveConfigToPath } from "../../src/config";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { handleResidentRead } from "../../src/serve/resident-request";
import { startResidentRuntime } from "../../src/serve/resident-runtime";
import { handleSearch } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";
import { snapshotSessionEnv, tempDir } from "../sessions/helpers";

let root: string;
let notes: string;
let configPath: string;
let runtime: ResidentRuntime | undefined;
const restoreEnv = snapshotSessionEnv();

beforeEach(async () => {
  root = await tempDir("gno-resident-startup-reconcile-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  notes = join(root, "notes");
  configPath = join(root, "index.yml");
  await mkdir(notes, { recursive: true });
  await Bun.write(join(notes, "kept.md"), "# Kept\n\nzebra kept\n");
  await Bun.write(join(notes, "edited.md"), "# Edited\n\nzebra before\n");
  await Bun.write(join(notes, "deleted.md"), "# Deleted\n\nzebra deleted\n");
  const config: Config = {
    version: "1.0",
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [
      {
        name: "notes",
        path: notes,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
  await saveConfigToPath(config, configPath);
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  restoreEnv();
  await safeRm(root);
});

async function start(mode: "serve" | "daemon"): Promise<ResidentRuntime> {
  const started = await startResidentRuntime({
    configPath,
    index: "startup-reconcile",
    offline: true,
    mode,
  });
  if (!started.success) throw new Error(started.error);
  runtime = started.runtime;
  return started.runtime;
}

async function hits(resident: ResidentRuntime, query: string) {
  const res = await handleResidentRead(
    resident,
    new Request("http://127.0.0.1/api"),
    () =>
      handleSearch(
        resident.ctxHolder.current,
        new Request("http://127.0.0.1/api/search", {
          method: "POST",
          body: JSON.stringify({ query, limit: 20 }),
        })
      )
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Array<{ uri: string }> };
  return body.results.map(({ uri }) => uri).sort();
}

async function changeWhileStopped(): Promise<void> {
  const first = await start("serve");
  await first.syncAll({ triggerEmbed: false });
  expect(await hits(first, "zebra")).toEqual([
    "gno://notes/deleted.md",
    "gno://notes/edited.md",
    "gno://notes/kept.md",
  ]);
  await first.dispose();
  runtime = undefined;

  await Bun.write(join(notes, "added-one.md"), "# Added\n\nzebra quokka\n");
  await Bun.write(join(notes, "added-two.md"), "# Added\n\nzebra quokka\n");
  await Bun.write(join(notes, "edited.md"), "# Edited\n\nzebra after\n");
  await unlink(join(notes, "deleted.md"));
}

const CONVERGED = [
  "gno://notes/added-one.md",
  "gno://notes/added-two.md",
  "gno://notes/edited.md",
  "gno://notes/kept.md",
];

test("serve indexes adds, edits and deletes made while no resident ran", async () => {
  await changeWhileStopped();
  const resident = await start("serve");

  const deadline = Date.now() + 15_000;
  let seen = await hits(resident, "zebra");
  while (JSON.stringify(seen) !== JSON.stringify(CONVERGED)) {
    if (Date.now() > deadline) break;
    await Bun.sleep(100);
    seen = await hits(resident, "zebra");
  }
  expect(seen).toEqual(CONVERGED);
  expect(await hits(resident, "quokka")).toEqual([
    "gno://notes/added-one.md",
    "gno://notes/added-two.md",
  ]);
  expect(await hits(resident, "after")).toEqual(["gno://notes/edited.md"]);
  expect(await hits(resident, "before")).toEqual([]);
}, 30_000);

test("daemon mode leaves the startup sync to its own initial sync", async () => {
  await changeWhileStopped();
  const resident = await start("daemon");
  await Bun.sleep(1_500);
  // Nothing reconciled without `syncAll` (the daemon command runs it unless
  // --no-sync-on-start).
  expect(await hits(resident, "quokka")).toEqual([]);
  await resident.syncAll({ triggerEmbed: false });
  expect(await hits(resident, "zebra")).toEqual(CONVERGED);
}, 30_000);
