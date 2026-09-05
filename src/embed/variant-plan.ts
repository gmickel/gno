import type { VectorVariantStore } from "../store/vector/variants";
import type { EmbedBacklogDeps } from "./backlog";

import { getVectorStatsDatabase } from "../store/vector/stats";

/** Counts and execution enumerate the same exact current owner partition. */
export function variantBacklogPage(
  deps: EmbedBacklogDeps,
  store: VectorVariantStore,
  limit: number,
  after?: { documentId: number; seq: number }
) {
  if (!deps.force) return store.pending({ limit, after });
  const db = getVectorStatsDatabase(deps.statsPort);
  if (!db)
    throw new Error("Forced variants require document ownership storage");
  const rows = db
    .query<
      { documentId: number; seq: number },
      [number, number, number, number]
    >(`
    SELECT d.id AS documentId, c.seq FROM documents d
    JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
    WHERE d.active = 1 AND (d.id > ? OR (d.id = ? AND c.seq > ?))
    ORDER BY d.id, c.seq LIMIT ?
  `)
    .all(
      after?.documentId ?? -1,
      after?.documentId ?? -1,
      after?.seq ?? -1,
      limit
    );
  return rows.flatMap((row) => {
    const owner = store.current(row.documentId, row.seq);
    return owner ? [owner] : [];
  });
}

export function countVariantBacklog(deps: EmbedBacklogDeps): number {
  const store = deps.variantStore;
  if (!store) throw new Error("Verified variant identity required");
  const db = getVectorStatsDatabase(deps.statsPort);
  let after: { documentId: number; seq: number } | undefined;
  let count = 0;
  while (true) {
    const owners = variantBacklogPage(deps, store, 256, after);
    if (!owners.length) return count;
    for (const owner of owners) {
      if (
        !deps.collection ||
        db
          ?.query(
            "SELECT 1 FROM documents WHERE id = ? AND collection = ? AND active = 1"
          )
          .get(owner.documentId, deps.collection)
      )
        count += 1;
    }
    const last = owners.at(-1)!;
    after = { documentId: last.documentId, seq: last.seq };
  }
}
