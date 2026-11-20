import type { VectorVariantStore } from "../store/vector/variants";
import type { EmbedBacklogDeps } from "./backlog";

import { getVectorStatsDatabase } from "../store/vector/stats";

/** Active chunks in scope; the collection predicate is added only when set. */
function activeChunkScope(collection: string | undefined) {
  return {
    from: `FROM documents d
    JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
    WHERE d.active = 1${collection ? " AND d.collection = ?" : ""}`,
    params: collection ? [collection] : [],
  };
}

function forcedDatabase(deps: EmbedBacklogDeps) {
  const db = getVectorStatsDatabase(deps.statsPort);
  if (!db)
    throw new Error("Forced variants require document ownership storage");
  return db;
}

/**
 * Counts and execution enumerate the same exact current owner partition,
 * limited in SQL to `deps.collection` when one is set.
 */
export function variantBacklogPage(
  deps: EmbedBacklogDeps,
  store: VectorVariantStore,
  limit: number,
  after?: { documentId: number; seq: number }
) {
  const collection = deps.collection || undefined;
  if (!deps.force) return store.pending({ limit, after, collection });
  // Same guard as before: forced passes need document ownership storage.
  forcedDatabase(deps);
  return store.currentPage({ limit, after, collection });
}

/** Owners a complete variantBacklogPage pass would return, without paging. */
export function countVariantBacklog(deps: EmbedBacklogDeps): number {
  const store = deps.variantStore;
  if (!store) throw new Error("Verified variant identity required");
  const collection = deps.collection || undefined;
  if (!deps.force) return store.countPending({ collection });
  // Every active chunk in scope has a current owner input, so a forced pass
  // returns exactly one owner per row.
  const scope = activeChunkScope(collection);
  return forcedDatabase(deps)
    .query<{ n: number }, string[]>(`SELECT count(*) AS n ${scope.from}`)
    .get(...scope.params)!.n;
}
