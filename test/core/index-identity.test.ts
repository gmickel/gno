import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  buildUri,
  getIndexDbPath,
  type ResolvedDirs,
} from "../../src/app/constants";
import {
  canonicalizeIndexName,
  indexNamesMatch,
  isValidIndexName,
  resolveIndexDbFilename,
} from "../../src/app/index-name";
import { CONFIG_VERSION, ConfigSchema } from "../../src/config/types";
import {
  indexesMatch,
  resolveEffectiveIndex,
} from "../../src/core/indexed-reference";
import { SqliteAdapter } from "../../src/store";
import { openScopedIndexStore } from "../../src/store/sqlite/scoped-index";
import { safeRm } from "../helpers/cleanup";

const tempRoots: string[] = [];

async function createDirs(): Promise<ResolvedDirs> {
  const root = await mkdtemp(join(tmpdir(), "gno-index-identity-"));
  tempRoots.push(root);
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
  };
  await mkdir(dirs.data, { recursive: true });
  return dirs;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await safeRm(root);
  }
});

describe("cross-platform index identity", () => {
  test.each([
    ["é", "e\u0301"],
    ["Å", "Å"],
    ["Work", "work"],
    ["aß", "aSS"],
    ["aſ", "aS"],
    ["aΣ", "aς"],
  ])("collapses %s and %s to one identity", (left, right) => {
    expect(canonicalizeIndexName(left)).toBe(canonicalizeIndexName(right));
    expect(indexNamesMatch(left, right)).toBe(true);
    expect(indexesMatch(left, right)).toBe(true);
  });

  test("uses one deterministic filename for equivalent new names", async () => {
    const dirs = await createDirs();

    expect(getIndexDbPath("é", dirs)).toBe(getIndexDbPath("e\u0301", dirs));
    expect(getIndexDbPath("Å", dirs)).toBe(getIndexDbPath("Å", dirs));
    expect(getIndexDbPath("Work", dirs)).toBe(getIndexDbPath("work", dirs));
    expect(basename(getIndexDbPath("Work", dirs))).toBe("index-work.sqlite");
  });

  test("bounds expanded identities at the portable filename limit", async () => {
    const dirs = await createDirs();
    const exactBoundary = `${"\u0958".repeat(40)}é`;
    const expandedBoundary = canonicalizeIndexName(exactBoundary);
    expect(new TextEncoder().encode(expandedBoundary).byteLength).toBe(242);
    expect(isValidIndexName(exactBoundary)).toBe(true);

    const dbPath = getIndexDbPath(exactBoundary, dirs);
    expect(new TextEncoder().encode(basename(dbPath)).byteLength).toBe(255);
    await Bun.write(dbPath, "portable-boundary");
    expect(await Bun.file(dbPath).exists()).toBe(true);
    expect(getIndexDbPath(exactBoundary, dirs)).toBe(dbPath);

    const expandedTooFar = "\u0958".repeat(41);
    expect(
      new TextEncoder().encode(
        expandedTooFar
          .normalize("NFC")
          .toLowerCase()
          .toUpperCase()
          .toLowerCase()
      ).byteLength
    ).toBeGreaterThan(242);
    expect(isValidIndexName(expandedTooFar)).toBe(false);
    expect(() => getIndexDbPath(expandedTooFar, dirs)).toThrow(
      "portable database filename limit"
    );
  });

  test("detects a long canonical filename plus its shorter legacy alias", () => {
    const legacyName = `${"\u0958".repeat(40)}é`;
    const canonicalName = canonicalizeIndexName(legacyName);
    const canonicalFilename = `index-${canonicalName}.sqlite`;
    const legacyFilename = `index-${legacyName}.sqlite`;

    expect(resolveIndexDbFilename(legacyName, [canonicalFilename])).toBe(
      canonicalFilename
    );
    expect(() =>
      resolveIndexDbFilename(legacyName, [canonicalFilename, legacyFilename])
    ).toThrow("multiple database files share its canonical identity");
  });

  test("preserves one existing mixed-case filename for every alias", async () => {
    const dirs = await createDirs();
    const legacyPath = join(dirs.data, "index-Work.sqlite");
    await Bun.write(legacyPath, "legacy");

    expect(getIndexDbPath("Work", dirs)).toBe(legacyPath);
    expect(getIndexDbPath("work", dirs)).toBe(legacyPath);
  });

  test("fails closed for multiple Linux files with one identity", () => {
    expect(() =>
      resolveIndexDbFilename("work", ["index-Work.sqlite", "index-work.sqlite"])
    ).toThrow("multiple database files share its canonical identity");
  });

  test("rejects an empty index instead of treating it as default", async () => {
    expect(() => indexesMatch("", "default")).toThrow("Invalid index name:");

    const activeStore = new SqliteAdapter();
    const config = ConfigSchema.parse({ version: CONFIG_VERSION });
    let rejection: unknown;
    try {
      await openScopedIndexStore({
        activeStore,
        activeIndexName: undefined,
        requestedIndexName: "",
        config,
        configPath: null,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(TypeError);
    expect((rejection as Error).message).toContain("Invalid index name:");
  });

  test("routes equivalent URI index spellings as one index", () => {
    const mixedExplicit = resolveEffectiveIndex([
      "gno://notes/one.md?index=Work",
      "gno://notes/two.md?index=work",
    ]);
    expect(mixedExplicit).toEqual({
      ok: true,
      value: { indexName: "Work" },
    });

    const mixedWithActive = resolveEffectiveIndex(
      ["gno://notes/one.md?index=e%CC%81", "notes/two.md"],
      "é"
    );
    expect(mixedWithActive).toEqual({
      ok: true,
      value: { indexName: "e\u0301" },
    });

    expect(buildUri("notes", "one.md", { indexName: "Default" })).toBe(
      "gno://notes/one.md"
    );
  });
});
