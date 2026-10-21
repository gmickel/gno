import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path build the temporary collection.
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import {
  MAX_REINDEX_PATHS,
  resolveReindexPaths,
} from "../../src/core/reindex-paths";
import { safeRm } from "../helpers/cleanup";

let root = "";
let collection: Collection;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-reindex-paths-"));
  const docs = join(root, "docs");
  await mkdir(join(docs, "private"), { recursive: true });
  await writeFile(join(docs, "a.md"), "# A\n");
  await writeFile(join(docs, "private", "credentials.md"), "# secret\n");
  // A dangling link that points outside the collection.
  await symlink(join(root, "outside", "gone"), join(docs, "escape"));
  collection = {
    name: "notes",
    path: docs,
    pattern: "**/*",
    include: [],
    exclude: ["private"],
  };
});

afterEach(async () => {
  await safeRm(root);
});

const rejection = (paths: string[]) =>
  resolveReindexPaths(collection, paths).then(
    () => "accepted",
    (error: Error) => error.message
  );

test("a listed path the collection's rules exclude is rejected", async () => {
  expect(await rejection(["private/credentials.md"])).toStartWith(
    "INVALID_PATH: private/credentials.md is not part of collection notes"
  );
});

test("a missing file under a dangling symlink to outside the root is rejected", async () => {
  expect(await rejection(["escape/missing.md"])).toStartWith(
    "INVALID_PATH: escape/missing.md resolves outside collection notes"
  );
});

test("eligible paths, including a deleted one, are accepted", async () => {
  expect(await resolveReindexPaths(collection, ["a.md", "gone.md"])).toEqual([
    "a.md",
    "gone.md",
  ]);
});

test("a directory is rejected with a message that says so", async () => {
  await mkdir(join(root, "docs", "sub"));
  expect(await rejection(["sub"])).toBe(
    "INVALID_PATH: sub is a directory; list the files in it, or reindex the whole collection"
  );
});

test("more than MAX_REINDEX_PATHS paths are rejected before any is resolved", async () => {
  const paths = Array.from(
    { length: MAX_REINDEX_PATHS + 1 },
    (_, i) => `doc-${i}.md`
  );
  expect(await rejection(paths)).toStartWith(
    `INVALID_INPUT: paths lists ${MAX_REINDEX_PATHS + 1} paths (at most ${MAX_REINDEX_PATHS})`
  );
  expect(
    await resolveReindexPaths(collection, paths.slice(0, MAX_REINDEX_PATHS))
  ).toHaveLength(MAX_REINDEX_PATHS);
});
