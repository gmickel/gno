/** Conservative input invalidation for providers without verified variants. */
import type { Database } from "bun:sqlite";

import { formatDocForEmbedding } from "../../pipeline/contextual";

type TitleRow = { title: string | null };
export type LegacyTitleSnapshot = Map<string, (string | null)[]>;

function activeTitle(db: Database, mirror: string): TitleRow | null {
  return db
    .query<TitleRow, [string]>(`
    SELECT title FROM documents WHERE mirror_hash = ? AND active = 1
    ORDER BY id LIMIT 1
  `)
    .get(mirror);
}

/** Must be captured within the same transaction as the document mutation. */
export function snapshotLegacyTitles(
  db: Database,
  mirrors: (string | null | undefined)[]
): LegacyTitleSnapshot {
  const snapshot: LegacyTitleSnapshot = new Map();
  for (const mirror of new Set(mirrors)) {
    if (!mirror) continue;
    const active = activeTitle(db, mirror);
    // All inactive titles must agree before a restored source can reuse an
    // unproven legacy row. There is no persisted legacy input provenance.
    const titles = active
      ? [active.title]
      : db
          .query<TitleRow, [string]>(
            "SELECT DISTINCT title FROM documents WHERE mirror_hash = ?"
          )
          .all(mirror)
          .map((row) => row.title);
    snapshot.set(mirror, titles);
  }
  return snapshot;
}

/** Only legacy vectors are invalidated; canonical chunks and variants survive. */
export function reconcileLegacyTitles(
  db: Database,
  before: LegacyTitleSnapshot
): void {
  for (const [mirror, titles] of before) {
    const next = activeTitle(db, mirror);
    // Retain vectors when the final owner disappears, for identical restore.
    if (!next || (titles.length === 1 && titles[0] === next.title)) continue;
    const rows = db
      .query<{ seq: number; model: string; text: string }, [string]>(`
      SELECT v.seq, v.model, c.text FROM content_vectors v
      JOIN content_chunks c ON c.mirror_hash = v.mirror_hash AND c.seq = v.seq
      WHERE v.mirror_hash = ?
    `)
      .all(mirror);
    for (const row of rows) {
      const input = formatDocForEmbedding(
        row.text,
        next.title ?? undefined,
        row.model
      );
      if (
        titles.length &&
        titles.every(
          (title) =>
            formatDocForEmbedding(row.text, title ?? undefined, row.model) ===
            input
        )
      )
        continue;
      db.run(
        "DELETE FROM content_vectors WHERE mirror_hash = ? AND seq = ? AND model = ?",
        [mirror, row.seq, row.model]
      );
    }
  }
}
