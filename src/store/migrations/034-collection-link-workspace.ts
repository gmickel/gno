/**
 * Store each collection's effective link workspace (derived from the
 * filesystem at config sync) so query-time link resolution, status output
 * and graph projection fingerprints read one consistent membership.
 */
import type { Migration } from "./runner";

const COLUMNS: Array<[string, string]> = [
  ["real_path", "TEXT"],
  ["workspace_root", "TEXT"],
  [
    "workspace_source",
    "TEXT NOT NULL DEFAULT 'none' CHECK (workspace_source IN ('none', 'detected', 'configured', 'disabled', 'unavailable'))",
  ],
  ["workspace_nested", "TEXT"],
];

const existingColumns = (db: Parameters<Migration["up"]>[0]): Set<string> =>
  new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(collections)")
      .all()
      .map((row) => row.name)
  );

export const migration: Migration = {
  version: 34,
  name: "collection_link_workspace",

  up(db): void {
    const columns = existingColumns(db);
    for (const [name, definition] of COLUMNS) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE collections ADD COLUMN ${name} ${definition}`);
      }
    }
  },

  down(db): void {
    const columns = existingColumns(db);
    for (const [name] of [...COLUMNS].reverse()) {
      if (columns.has(name)) {
        db.exec(`ALTER TABLE collections DROP COLUMN ${name}`);
      }
    }
  },
};
