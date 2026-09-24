import { expect, test } from "bun:test";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";

import { watchedCollections } from "../../src/sessions/config";

const collection = (name: string, path: string): Collection =>
  ({ name, path, pattern: "**/*" }) as Collection;

const config = (collections: Collection[], archiveRoot?: string): Config =>
  ({
    version: "1.0",
    collections,
    contexts: [],
    ...(archiveRoot
      ? { sessions: { index: "sessions", archiveRoot, sources: [] } }
      : {}),
  }) as unknown as Config;

test("the resident watcher never follows session archive collections", () => {
  const root = join("/", "srv", "archive");
  const notes = collection("notes", join("/", "srv", "notes"));
  const sibling = collection("sibling", join("/", "srv", "archive-other"));
  const work = collection("work", join(root, "work"));
  expect(watchedCollections(config([notes, work, sibling], root))).toEqual([
    notes,
    sibling,
  ]);
  expect(watchedCollections(config([notes, work]))).toEqual([notes, work]);
});

test("every serve watcher update goes through watchedCollections", async () => {
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: "src/serve" })) {
    const source = await Bun.file(`src/serve/${path}`).text();
    for (const match of source.matchAll(/updateCollections\(\s*([^,)]+)/g)) {
      const argument = match[1]?.trim() ?? "";
      if (
        path !== "watch-service.ts" &&
        !argument.startsWith("watchedCollections(")
      ) {
        offenders.push(`${path}: ${argument}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
