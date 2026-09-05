/** Durable unresolved references and conservative projection recovery. */
import type { Migration } from "./runner";

export const migration: Migration = {
  version: 29,
  name: "graph_reference_state",
  up(db): void {
    db.exec(`
-- Graph reference inventory (migration 029). Parsed links remain in doc_links.
-- Snapshots deliberately survive document deletion: closure needs old identities.
-- Missing inventory, changed version/config, or dirty state requires full recovery.
-- Begin persists dirty before projection. Complete only after successful edge writes,
-- unchanged input epoch, and coverage of every active source; compose in a transaction.
CREATE TABLE graph_projection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0,
  version INTEGER,
  config_fingerprint TEXT,
  in_progress INTEGER NOT NULL DEFAULT 0 CHECK (in_progress IN (0, 1)),
  dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1))
);
INSERT INTO graph_projection_state(id) VALUES (1);
CREATE TABLE graph_reference_documents (
  document_id INTEGER PRIMARY KEY,
  collection TEXT NOT NULL, rel_path TEXT NOT NULL, docid TEXT NOT NULL,
  uri TEXT NOT NULL, title TEXT, mirror_hash TEXT, source_hash TEXT NOT NULL,
  content_type TEXT
);
CREATE INDEX idx_graph_reference_uri ON graph_reference_documents(uri);
CREATE INDEX idx_graph_reference_path ON graph_reference_documents(collection, rel_path);
CREATE INDEX idx_graph_reference_title ON graph_reference_documents(title);
CREATE TABLE graph_frontmatter_references (
  source_doc_id INTEGER NOT NULL REFERENCES graph_reference_documents(document_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  edge_type TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY(source_doc_id, ordinal)
);
CREATE INDEX idx_graph_reference_target ON graph_frontmatter_references(target);
`);
    for (const table of ["documents", "doc_links"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const changed =
          table === "documents" && operation === "UPDATE"
            ? " WHEN " +
              [
                "collection",
                "rel_path",
                "docid",
                "uri",
                "title",
                "mirror_hash",
                "source_hash",
                "content_type",
                "active",
              ]
                .map((column) => `OLD.${column} IS NOT NEW.${column}`)
                .join(" OR ")
            : "";
        db.exec(`CREATE TRIGGER graph_input_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table}${changed} BEGIN
          UPDATE graph_projection_state SET epoch = epoch + 1, dirty = 1 WHERE id = 1;
          END`);
      }
    }
    for (const table of [
      "graph_reference_documents",
      "graph_frontmatter_references",
    ]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER graph_inventory_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
          UPDATE graph_projection_state SET dirty = 1, in_progress = 1 WHERE id = 1; END`);
      }
    }
  },
};
