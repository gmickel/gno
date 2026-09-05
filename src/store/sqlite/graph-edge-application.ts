import type { Database } from "bun:sqlite";

import type { DocEdgeConfidence, DocEdgeSource } from "../types";

export interface DesiredGraphEdge {
  sourceId: number;
  targetId: number;
  edgeType: string;
  confidence: DocEdgeConfidence;
  source: DocEdgeSource;
}

/** Apply an exact scoped set without replacing retained edge identities/timestamps.
 * Synchronous staging and application run in one transaction, including nested
 * projection transactions. The temporary table is connection-local scratch only. */
export function applyGraphEdges(
  db: Database,
  edges: DesiredGraphEdge[],
  sources: DocEdgeSource[],
  sourceIds?: number[]
): number {
  return db.transaction(() => {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS graph_edge_application (
      src_doc_id INTEGER NOT NULL, dst_doc_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL, confidence TEXT NOT NULL, source TEXT NOT NULL,
      PRIMARY KEY(src_doc_id, dst_doc_id, edge_type, source)
    )`);
    db.run("DELETE FROM graph_edge_application");
    const stage = db.query(`INSERT INTO graph_edge_application
      (src_doc_id, dst_doc_id, edge_type, confidence, source) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(src_doc_id, dst_doc_id, edge_type, source) DO UPDATE SET confidence=excluded.confidence`);
    for (const edge of edges)
      stage.run(
        edge.sourceId,
        edge.targetId,
        edge.edgeType,
        edge.confidence,
        edge.source
      );
    const same =
      "s.src_doc_id=e.src_doc_id AND s.dst_doc_id=e.dst_doc_id AND s.edge_type=e.edge_type AND s.source=e.source";
    db.run(
      `DELETE FROM doc_edges AS e
      WHERE e.source IN (SELECT value FROM json_each(?))
      ${sourceIds ? "AND e.src_doc_id IN (SELECT value FROM json_each(?))" : ""}
      AND NOT EXISTS (SELECT 1 FROM graph_edge_application s WHERE ${same})`,
      sourceIds
        ? [JSON.stringify(sources), JSON.stringify(sourceIds)]
        : [JSON.stringify(sources)]
    );
    db.run(`UPDATE doc_edges AS e SET confidence=(
      SELECT s.confidence FROM graph_edge_application s WHERE ${same})
      WHERE e.src_doc_id IN (SELECT src_doc_id FROM graph_edge_application)
      AND EXISTS (SELECT 1 FROM graph_edge_application s WHERE ${same} AND s.confidence IS NOT e.confidence)`);
    db.run(`INSERT INTO doc_edges(src_doc_id, dst_doc_id, edge_type, confidence, source)
      SELECT s.src_doc_id, s.dst_doc_id, s.edge_type, s.confidence, s.source
      FROM graph_edge_application s
      WHERE NOT EXISTS (SELECT 1 FROM doc_edges e WHERE ${same})
      ORDER BY s.rowid`);
    // Bun run().changes includes trigger side effects; SQLite changes() does not.
    return (
      db.query<{ count: number }, []>("SELECT changes() AS count").get()
        ?.count ?? 0
    );
  })();
}
