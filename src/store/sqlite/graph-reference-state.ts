import type { Database } from "bun:sqlite";

import type {
  GraphProjectionState,
  GraphReferenceDocument,
  GraphReferenceInventory,
  GraphReferenceStore,
} from "../types";

import { buildWikiMatchExpression } from "../../core/graph-resolver";
import { normalizeWikiName } from "../../core/links";

const SNAPSHOT_COLUMNS = `document_id AS documentId, collection, rel_path AS relPath,
  docid, uri, title, mirror_hash AS mirrorHash, source_hash AS sourceHash,
  content_type AS contentType`;

/** Raw references preserve resolver precedence; resolution belongs to ingestion.
 * Keep old snapshots through deletion/rename until the affected closure is consumed.
 * No second parsed-link inventory: use doc_links alongside these frontmatter rows. */
export function createGraphReferenceStore(db: Database): GraphReferenceStore {
  function state(
    version: number,
    configFingerprint: string
  ): GraphProjectionState {
    const row = db
      .query<
        {
          epoch: number;
          version: number | null;
          configFingerprint: string | null;
          dirty: number;
          inProgress: number;
        },
        []
      >(`SELECT epoch, version, config_fingerprint AS configFingerprint, dirty, in_progress AS inProgress
      FROM graph_projection_state WHERE id = 1`)
      .get();
    if (!row)
      throw new Error("Missing graph projection state; rebuild required");
    return {
      ...row,
      dirty: row.dirty !== 0,
      inProgress: row.inProgress !== 0,
      complete:
        row.dirty === 0 &&
        row.inProgress === 0 &&
        row.version === version &&
        row.configFingerprint === configFingerprint,
    };
  }
  return {
    state,
    begin(version, configFingerprint) {
      if (!Number.isSafeInteger(version) || version < 1 || !configFingerprint)
        throw new Error("Invalid graph projection identity");
      return db.transaction(() => {
        const previous = state(version, configFingerprint);
        if (
          previous.version !== version ||
          previous.configFingerprint !== configFingerprint
        )
          db.run("DELETE FROM graph_reference_documents");
        db.run(
          `UPDATE graph_projection_state SET epoch = epoch + 1, dirty = 1, in_progress = 1, version = ?, config_fingerprint = ? WHERE id = 1`,
          [version, configFingerprint]
        );
        return state(version, configFingerprint).epoch;
      })();
    },
    readInventory() {
      const docs = db
        .query<GraphReferenceDocument, []>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM graph_reference_documents ORDER BY document_id`
        )
        .all();
      const refs = db
        .query<{ sourceId: number; edgeType: string; target: string }, []>(
          `SELECT source_doc_id AS sourceId, edge_type AS edgeType, target FROM graph_frontmatter_references ORDER BY source_doc_id, ordinal`
        )
        .all();
      const inventories = new Map<number, GraphReferenceInventory>(
        docs.map((document) => [
          document.documentId,
          { document, references: [] },
        ])
      );
      for (const ref of refs)
        inventories
          .get(ref.sourceId)
          ?.references.push({ edgeType: ref.edgeType, target: ref.target });
      return [...inventories.values()];
    },
    incomingLinkSources(identities) {
      if (identities.length === 0) return [];
      const targets = identities.map((d) => ({
        collection: d.collection,
        rel_path: d.relPath,
        title: d.title,
        wiki_title: normalizeWikiName(
          d.title ?? d.relPath.split("/").pop() ?? d.relPath
        ),
        wiki_rel: normalizeWikiName(d.relPath),
        wiki_stem: normalizeWikiName(d.relPath.replace(/\.[^/.]+$/, "")),
      }));
      return db
        .query<{ sourceId: number }, [string]>(`
        WITH targets AS (
          SELECT json_extract(value, '$.collection') AS collection,
            json_extract(value, '$.rel_path') AS rel_path,
            json_extract(value, '$.title') AS title,
            json_extract(value, '$.wiki_title') AS wiki_title,
            json_extract(value, '$.wiki_rel') AS wiki_rel,
            json_extract(value, '$.wiki_stem') AS wiki_stem
          FROM json_each(?)
        )
        SELECT DISTINCT dl.source_doc_id AS sourceId
        FROM doc_links dl JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
        JOIN targets t ON (
          (t.collection = COALESCE(dl.target_collection, src.collection) AND (
            (dl.link_type = 'markdown' AND dl.target_ref_norm = t.rel_path) OR
            (dl.link_type = 'wiki' AND ${buildWikiMatchExpression("t", "dl.target_ref_norm")})
          )) OR
          (dl.link_type = 'wiki' AND dl.target_ref_norm IN (t.wiki_title, t.wiki_rel, t.wiki_stem))
          OR (dl.link_type = 'markdown' AND t.collection = src.collection AND dl.target_ref_norm = t.rel_path)
        )
        ORDER BY dl.source_doc_id
      `)
        .all(JSON.stringify(targets))
        .map((row) => row.sourceId);
    },
    writeInventory({ document: d, references }) {
      db.transaction(() => {
        db.run("UPDATE graph_projection_state SET dirty = 1 WHERE id = 1");
        db.run(
          `INSERT INTO graph_reference_documents
          (document_id, collection, rel_path, docid, uri, title, mirror_hash, source_hash, content_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET collection=excluded.collection, rel_path=excluded.rel_path,
          docid=excluded.docid, uri=excluded.uri, title=excluded.title, mirror_hash=excluded.mirror_hash,
          source_hash=excluded.source_hash, content_type=excluded.content_type`,
          [
            d.documentId,
            d.collection,
            d.relPath,
            d.docid,
            d.uri,
            d.title,
            d.mirrorHash,
            d.sourceHash,
            d.contentType,
          ]
        );
        db.run(
          "DELETE FROM graph_frontmatter_references WHERE source_doc_id = ?",
          [d.documentId]
        );
        for (const [ordinal, ref] of references.entries()) {
          db.run(
            "INSERT INTO graph_frontmatter_references(source_doc_id, ordinal, edge_type, target) VALUES (?, ?, ?, ?)",
            [d.documentId, ordinal, ref.edgeType, ref.target]
          );
        }
      })();
    },
    complete(expectedEpoch) {
      db.transaction(() => {
        const row = db
          .query<{ epoch: number; version: number | null }, []>(
            "SELECT epoch, version FROM graph_projection_state WHERE id = 1"
          )
          .get();
        if (!row?.version || row.epoch !== expectedEpoch)
          throw new Error("Graph inputs changed during projection");
        const missing = db
          .query<{ id: number }, []>(`SELECT d.id FROM documents d
          LEFT JOIN graph_reference_documents r ON r.document_id = d.id
          WHERE d.active = 1 AND (r.document_id IS NULL
          OR r.collection IS NOT d.collection OR r.rel_path IS NOT d.rel_path
          OR r.docid IS NOT d.docid OR r.uri IS NOT d.uri OR r.title IS NOT d.title
          OR r.mirror_hash IS NOT d.mirror_hash OR r.source_hash IS NOT d.source_hash
          OR r.content_type IS NOT d.content_type) LIMIT 1`)
          .get();
        if (missing)
          throw new Error("Graph reference inventory is incomplete or stale");
        db.run(
          "DELETE FROM graph_reference_documents WHERE document_id NOT IN (SELECT id FROM documents WHERE active = 1)"
        );
        db.run(
          "UPDATE graph_projection_state SET dirty = 0, in_progress = 0 WHERE id = 1"
        );
      })();
    },
  };
}
