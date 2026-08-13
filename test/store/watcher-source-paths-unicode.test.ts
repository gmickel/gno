/**
 * Code-point-safe watcher source-path queries for non-BMP directories (gno-27.1).
 *
 * SQLite length()/substr count characters; JS string.length is UTF-16 units.
 * A non-BMP directory prefix must still match direct-child and descendant rows.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { SqliteAdapter, WATCHER_ACTIVE_SOURCE_PATH_MAX } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

if (process.platform === "win32") {
  setDefaultTimeout(15_000);
}

const TEST_MAX = WATCHER_ACTIVE_SOURCE_PATH_MAX;

/** Non-BMP directory segment (U+1F600 GRINNING FACE) — JS length 2, SQLite length 1. */
const NON_BMP_DIR = "\u{1F600}";
const NON_BMP_NESTED = `${NON_BMP_DIR}/nested`;

function doc(
  overrides: Partial<DocumentInput> & { relPath: string }
): DocumentInput {
  return {
    collection: "notes",
    sourceHash: `hash_${overrides.collection ?? "notes"}_${overrides.relPath}`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("watcher source paths: non-BMP directory prefixes", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-watcher-unicode-"));
    adapter = new SqliteAdapter();
    await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    await adapter.syncCollections([
      {
        name: "notes",
        path: "/notes",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function expectDirect(
    dirRelPath: string,
    max = TEST_MAX
  ): Promise<string[]> {
    const result = await adapter.listActiveDirectChildSourcePaths(
      "notes",
      dirRelPath,
      max
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  async function expectDescendants(
    dirRelPath: string,
    max = TEST_MAX
  ): Promise<string[]> {
    const result = await adapter.listActiveDescendantSourcePaths(
      "notes",
      dirRelPath,
      max
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  test("plain sources under non-BMP directory: direct children, descendants, order", async () => {
    // JS "😀/".length === 3 (UTF-16), SQLite length("😀/") === 2 (code points).
    const prefix = `${NON_BMP_DIR}/`;
    expect(prefix.length).toBe(3);
    expect(prefix.codePointAt(0)).toBe(0x1f_600);

    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}/zeta.md` }));
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}/alpha.md` }));
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_NESTED}/deep.md` }));
    await adapter.upsertDocument(doc({ relPath: "ascii/keep.md" }));
    // Prefix-sharing sibling that must never match (dir + extra code unit edge).
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}x/nope.md` }));

    expect(await expectDirect(NON_BMP_DIR)).toEqual([
      `${NON_BMP_DIR}/alpha.md`,
      `${NON_BMP_DIR}/zeta.md`,
    ]);
    expect(await expectDirect(NON_BMP_NESTED)).toEqual([
      `${NON_BMP_NESTED}/deep.md`,
    ]);

    // Lexicographic ASC: nested/ sorts before zeta.md.
    expect(await expectDescendants(NON_BMP_DIR)).toEqual([
      `${NON_BMP_DIR}/alpha.md`,
      `${NON_BMP_NESTED}/deep.md`,
      `${NON_BMP_DIR}/zeta.md`,
    ]);
    expect(await expectDescendants(NON_BMP_NESTED)).toEqual([
      `${NON_BMP_NESTED}/deep.md`,
    ]);
    // Sibling with shared visual prefix but different path is excluded.
    expect(await expectDescendants(`${NON_BMP_DIR}x`)).toEqual([
      `${NON_BMP_DIR}x/nope.md`,
    ]);
  });

  test("record-container physical source under non-BMP directory", async () => {
    const container = `${NON_BMP_DIR}/export.jsonl`;
    await adapter.upsertDocument(
      doc({
        relPath: ".gno/records/h/one.md",
        recordKey: "one",
        recordSourcePath: container,
        sourceExt: ".jsonl",
        sourceMime: "application/jsonl",
      })
    );
    await adapter.upsertDocument(
      doc({
        relPath: ".gno/records/h/two.md",
        recordKey: "two",
        recordSourcePath: container,
        sourceExt: ".jsonl",
        sourceMime: "application/jsonl",
      })
    );
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}/plain.md` }));
    await adapter.upsertDocument(
      doc({ relPath: `${NON_BMP_NESTED}/nested.md` })
    );

    expect(await expectDirect(NON_BMP_DIR)).toEqual([
      container,
      `${NON_BMP_DIR}/plain.md`,
    ]);
    // Lexicographic ASC: nested/ sorts before plain.md.
    expect(await expectDescendants(NON_BMP_DIR)).toEqual([
      container,
      `${NON_BMP_NESTED}/nested.md`,
      `${NON_BMP_DIR}/plain.md`,
    ]);
  });

  test("non-BMP descendant overflow still fails closed (no truncated success)", async () => {
    const max = 2;
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}/a.md` }));
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_DIR}/b.md` }));
    await adapter.upsertDocument(doc({ relPath: `${NON_BMP_NESTED}/c.md` }));

    const overflow = await adapter.listActiveDescendantSourcePaths(
      "notes",
      NON_BMP_DIR,
      max
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) {
      return;
    }
    expect(overflow.error.code).toBe("OVERFLOW");
    expect("value" in overflow).toBe(false);

    const ok = await adapter.listActiveDescendantSourcePaths(
      "notes",
      NON_BMP_DIR,
      3
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual([
        `${NON_BMP_DIR}/a.md`,
        `${NON_BMP_DIR}/b.md`,
        `${NON_BMP_NESTED}/c.md`,
      ]);
    }
  });
});
