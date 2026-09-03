/**
 * Persisted stage markers for staged indexing (fn-132 R4).
 *
 * @module test/embed/stage-state
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  clearIndexStage,
  findInterruptedStage,
  formatInterruptedStage,
  INDEX_STAGE_STATE_KEY,
  markIndexStageFinished,
  markIndexStageRunning,
  readIndexStageState,
} from "../../src/embed/stage-state";

function openMetaDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
  return db;
}

const at = (iso: string) => () => new Date(iso);

describe("index stage state", () => {
  test("reads empty when no marker or a malformed marker is stored", () => {
    const db = openMetaDb();
    expect(findInterruptedStage(readIndexStageState(db))).toBeNull();

    db.run("INSERT INTO schema_meta (key, value) VALUES (?, ?)", [
      INDEX_STAGE_STATE_KEY,
      "{not json",
    ]);
    expect(readIndexStageState(db)).toEqual({ version: 1 });

    db.run("UPDATE schema_meta SET value = ? WHERE key = ?", [
      JSON.stringify({ lexical: { state: "running" } }),
      INDEX_STAGE_STATE_KEY,
    ]);
    expect(readIndexStageState(db).lexical).toBeUndefined();
  });

  test("a stage left running is reported as interrupted; finished stages are not", () => {
    const db = openMetaDb();
    markIndexStageRunning(db, "lexical", {
      now: at("2026-09-03T06:00:00.000Z"),
    });
    markIndexStageFinished(db, "lexical", "completed", {
      now: at("2026-09-03T06:00:01.000Z"),
    });
    markIndexStageRunning(db, "embed", {
      collection: "notes",
      now: at("2026-09-03T06:00:02.000Z"),
    });

    expect(findInterruptedStage(readIndexStageState(db))).toEqual({
      stage: "embed",
      state: "interrupted",
      startedAt: "2026-09-03T06:00:02.000Z",
      pid: process.pid,
      collection: "notes",
    });

    markIndexStageFinished(db, "embed", "failed", {
      now: at("2026-09-03T06:00:03.000Z"),
    });
    const state = readIndexStageState(db);
    expect(findInterruptedStage(state)).toBeNull();
    expect(state.embed).toMatchObject({
      state: "failed",
      startedAt: "2026-09-03T06:00:02.000Z",
      finishedAt: "2026-09-03T06:00:03.000Z",
      collection: "notes",
    });
    expect(state.lexical?.state).toBe("completed");
  });

  test("clearing a stage drops its marker and leaves the other stage alone", () => {
    const db = openMetaDb();
    markIndexStageRunning(db, "lexical");
    markIndexStageFinished(db, "lexical", "completed");
    markIndexStageRunning(db, "embed");
    expect(findInterruptedStage(readIndexStageState(db))?.stage).toBe("embed");

    clearIndexStage(db, "embed");
    const state = readIndexStageState(db);
    expect(state.embed).toBeUndefined();
    expect(state.lexical?.state).toBe("completed");
    expect(findInterruptedStage(state)).toBeNull();

    // Clearing an absent stage is a no-op.
    clearIndexStage(db, "embed");
    expect(readIndexStageState(db)).toEqual(state);
  });

  test("embed wins over lexical when both markers are running", () => {
    const db = openMetaDb();
    markIndexStageRunning(db, "lexical");
    markIndexStageRunning(db, "embed");
    expect(findInterruptedStage(readIndexStageState(db))?.stage).toBe("embed");
  });

  test("preamble names the stage, pid, start time and the resume behaviour", () => {
    const line = formatInterruptedStage({
      stage: "embed",
      state: "interrupted",
      startedAt: "2026-09-03T06:00:02.000Z",
      pid: 4242,
    });
    expect(line).toContain("pid 4242");
    expect(line).toContain("2026-09-03T06:00:02.000Z");
    expect(line).toContain("interrupted during the embed stage");
    expect(line).toContain("without re-embedding completed chunks");
  });
});
