import type { Database } from "bun:sqlite";

import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no temp-directory, OS, or path utilities.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { buildEligibleDocumentQuery } from "../../src/store/sqlite/eligibility";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import { safeRm } from "../helpers/cleanup";

// GNO keeps no planner statistics, so SQLite treated the near-universal
// `idx_documents_active` as a peer of selective indexes and chose it for
// `<column> = ? AND active = 1` lookups (fn-192).
const MIRROR_HASH_INDEX =
  "USING INDEX idx_documents_mirror_hash (mirror_hash=?)";
const DOCUMENT_STEP = /^(SEARCH|SCAN) (documents|d)\b/;

const adapter = new SqliteAdapter();
let directory: string;
let db: Database;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "document-active-plans-"));
  const opened = await adapter.open(
    join(directory, "index.sqlite"),
    "unicode61"
  );
  expect(opened.ok).toBe(true);
  db = adapter.getRawDb();
});

afterAll(async () => {
  await adapter.close();
  await safeRm(directory);
});

const planOf = (sql: string): string[] =>
  db
    .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail);

/** SQL on `documents` that `run` sends through this connection. */
async function capturedDocumentSql(
  run: () => Promise<unknown>
): Promise<string[]> {
  const seen: string[] = [];
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  const record = (sql: string) => {
    if (/\bFROM documents\b/.test(sql)) seen.push(sql);
  };
  db.query = ((sql: string) => {
    record(sql);
    return query(sql);
  }) as typeof db.query;
  db.prepare = ((sql: string) => {
    record(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    await run();
  } finally {
    // Drop the instance overrides; the prototype methods apply again.
    Reflect.deleteProperty(db, "query");
    Reflect.deleteProperty(db, "prepare");
  }
  return seen;
}

test("migrated index has no idx_documents_active", () => {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_active'"
    )
    .get();
  expect(row).toBeNull();
});

// Shapes whose only competing index was idx_documents_active.
const shapes: { name: string; sql: string }[] = [
  {
    name: "mirror_hash equality lookup (adapter, legacy vectors)",
    sql: "SELECT id, rel_path, title FROM documents WHERE mirror_hash = ? AND active = 1",
  },
  {
    name: "mirror_hash IN lookup (links)",
    sql: "SELECT docid, uri, title, collection, rel_path, mirror_hash FROM documents WHERE mirror_hash IN (?, ?, ?) AND active = 1",
  },
  {
    name: "correlated active-chunk EXISTS (embed, vector stats)",
    sql: "SELECT COUNT(*) FROM content_chunks c WHERE EXISTS (SELECT 1 FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1)",
  },
  {
    name: "correlated title subquery (embed, vector stats)",
    sql: "SELECT c.seq, (SELECT d.title FROM documents d WHERE d.mirror_hash = c.mirror_hash AND d.active = 1 ORDER BY d.id LIMIT 1) FROM content_chunks c",
  },
  {
    name: "mirror_hash join (embed retry)",
    sql: "SELECT c.seq FROM content_chunks c JOIN documents d ON d.mirror_hash = c.mirror_hash AND d.active = 1 WHERE c.mirror_hash = ?",
  },
];

test.each(shapes)("$name plans on the mirror_hash index", ({ sql }) => {
  const documentSteps = planOf(sql).filter((step) => DOCUMENT_STEP.test(step));
  expect(documentSteps).toHaveLength(1);
  expect(documentSteps[0]).toContain(MIRROR_HASH_INDEX);
});

// Collection-scoped mirror_hash lookups, planned from the SQL the code
// emits: unpinned, the planner walks the collection (every row in a
// one-collection index) instead of probing the hash.
const pinned: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: "vector stats backlog with collection",
    run: async () => {
      const stats = createVectorStatsPort(db);
      await stats.countBacklog("model", "fp", { collection: "notes" });
      await stats.getBacklog("model", "fp", { collection: "notes" });
      await stats.getBacklog("model", "fp", {
        collection: "notes",
        after: { mirrorHash: "a", seq: 0 },
      });
    },
  },
  {
    name: "documents by mirror hash with collection",
    run: () =>
      adapter.getDocumentsByMirrorHashes(["a", "b"], { collection: "notes" }),
  },
  {
    name: "eligibility with allowed mirror hashes and collection",
    run: () => {
      const eligible = buildEligibleDocumentQuery({
        allowedMirrorHashes: ["a", "b"],
        collection: "notes",
      });
      return Promise.resolve(db.query(eligible.sql));
    },
  },
];

test.each(pinned)("$name plans on the mirror_hash index", async ({ run }) => {
  const lookups = (await capturedDocumentSql(run)).filter((sql) =>
    /collection = \?/.test(sql)
  );
  expect(lookups.length).toBeGreaterThan(0);
  for (const sql of lookups) {
    const plan = planOf(sql);
    expect(
      plan.filter(
        (step) => DOCUMENT_STEP.test(step) && step.includes("collection=?")
      )
    ).toEqual([]);
    expect(plan.join("\n")).toContain(MIRROR_HASH_INDEX);
  }
});
