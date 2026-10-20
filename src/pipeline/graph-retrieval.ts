/**
 * Bounded graph expansion for hybrid retrieval.
 *
 * @module src/pipeline/graph-retrieval
 */

import type { DocumentAccessCheck } from "../core/access-hook";
import type { MetadataPredicate } from "../core/typed-metadata";
import type {
  ChunkRow,
  DocumentRow,
  DocumentEligibilityOptions,
  GraphEdgeConfidence,
  GraphLink,
  StorePort,
} from "../store/types";
import type { FusionCandidate, ReadableDocumentsCheck } from "./types";

import { typedMetadataFilterReason } from "./filters";
import { isWithinTemporalRange } from "./temporal";

export interface GraphRetrievalMeta {
  attempted: boolean;
  enabled: boolean;
  seedCount: number;
  candidateCount: number;
  maxCandidates: number;
  edgeConfidence: Record<GraphEdgeConfidence, number>;
  fallbackReasons: string[];
}

export interface GraphRetrievalResult {
  candidates: Array<{ mirrorHash: string; seq: number; sourceDocid?: string }>;
  meta: GraphRetrievalMeta;
}

const GRAPH_SEED_LIMIT = 5;
const GRAPH_CANDIDATE_LIMIT = 20;
const GRAPH_NODE_LIMIT = 2000;
const GRAPH_EDGE_LIMIT = 10000;
/**
 * Bound on resolving again without newly hidden documents. A round that
 * hides nothing new ends the loop, and each later round moves an affected
 * link down at least one of its dozen match ranks, so this is never reached.
 */
const GRAPH_RESOLUTION_ROUNDS = 16;

const EMPTY_EDGE_CONFIDENCE: Record<GraphEdgeConfidence, number> = {
  explicit: 0,
  inferred: 0,
  ambiguous: 0,
  similarity: 0,
};

const sourceRelPath = (doc: DocumentRow): string =>
  doc.recordSourcePath ?? doc.relPath;

const confidenceWeight = (confidence: GraphEdgeConfidence): number => {
  switch (confidence) {
    case "explicit":
      return 1;
    case "inferred":
      return 0.65;
    case "ambiguous":
      return 0.35;
    case "similarity":
      return 0.25;
  }
};

const matchesDocumentFilters = (
  doc: DocumentRow,
  options: {
    since?: string;
    until?: string;
    categories?: string[];
    author?: string;
    filter?: MetadataPredicate;
    relPathPrefix?: string;
  }
): boolean => {
  if (typedMetadataFilterReason(doc, options.filter)) return false;
  if (
    !isWithinTemporalRange(doc.sourceMtime, {
      since: options.since,
      until: options.until,
    })
  ) {
    return false;
  }
  if (
    options.author &&
    !doc.author?.toLowerCase().includes(options.author.toLowerCase())
  ) {
    return false;
  }
  if (options.categories?.length) {
    const allowed = new Set(options.categories.map((c) => c.toLowerCase()));
    const contentTypeMatch = doc.contentType
      ? allowed.has(doc.contentType.toLowerCase())
      : false;
    const categoryMatch = (doc.categories ?? []).some((c) =>
      allowed.has(c.toLowerCase())
    );
    if (!contentTypeMatch && !categoryMatch) {
      return false;
    }
  }
  return true;
};

const filterDocsByTags = async (
  store: StorePort,
  docs: DocumentRow[],
  options: { tagsAll?: string[]; tagsAny?: string[] }
): Promise<DocumentRow[]> => {
  if (!options.tagsAll?.length && !options.tagsAny?.length) {
    return docs;
  }

  const tagsResult = await store.getTagsBatch(docs.map((doc) => doc.id));
  if (!tagsResult.ok) {
    return [];
  }

  return docs.filter((doc) => {
    const docTags = new Set(
      (tagsResult.value.get(doc.id) ?? []).map((tag) => tag.tag)
    );
    if (options.tagsAll?.length) {
      const hasAll = options.tagsAll.every((tag) => docTags.has(tag));
      if (!hasAll) {
        return false;
      }
    }
    if (options.tagsAny?.length) {
      const hasAny = options.tagsAny.some((tag) => docTags.has(tag));
      if (!hasAny) {
        return false;
      }
    }
    return true;
  });
};

const chooseCandidateSeq = (
  doc: DocumentRow,
  chunks: ChunkRow[],
  preferredSeqByHash: Map<string, number>,
  lang?: string
): number | null => {
  if (!doc.mirrorHash) {
    return null;
  }

  const preferredSeq = preferredSeqByHash.get(doc.mirrorHash);
  if (preferredSeq !== undefined) {
    const preferredChunk = chunks.find((chunk) => chunk.seq === preferredSeq);
    if (preferredChunk && (!lang || preferredChunk.language === lang)) {
      return preferredSeq;
    }
  }

  const chunk = lang
    ? chunks.find((candidate) => candidate.language === lang)
    : chunks[0];
  return chunk?.seq ?? null;
};

const createMeta = (
  overrides: Partial<GraphRetrievalMeta> = {}
): GraphRetrievalMeta => ({
  attempted: false,
  enabled: false,
  seedCount: 0,
  candidateCount: 0,
  maxCandidates: GRAPH_CANDIDATE_LIMIT,
  edgeConfidence: { ...EMPTY_EDGE_CONFIDENCE },
  fallbackReasons: [],
  ...overrides,
});

const addEdgeCandidate = (
  scores: Map<string, number>,
  link: GraphLink,
  neighborDocid: string,
  seedRank: number,
  edgeConfidence: Record<GraphEdgeConfidence, number>
): void => {
  edgeConfidence[link.confidence] += 1;
  const seedWeight = 1 / seedRank;
  const edgeWeight =
    link.confidence === "similarity"
      ? Math.max(0, Math.min(1, link.weight))
      : Math.max(1, link.weight);
  const score = confidenceWeight(link.confidence) * edgeWeight * seedWeight;
  const current = scores.get(neighborDocid) ?? 0;
  scores.set(neighborDocid, current + score);
};

/**
 * Ids of the documents `readable` does not allow; a document that is no
 * longer active counts as unreadable. Null when the lookup fails.
 */
const unreadableDocumentIds = async (
  store: StorePort,
  documents: Array<{ id: number; docid: string }>,
  readable: ReadableDocumentsCheck
): Promise<number[] | null> => {
  if (documents.length === 0) return [];
  const rows = await store.getDocumentsByDocids(
    documents.map((doc) => doc.docid),
    { activeOnly: true }
  );
  if (!rows.ok) return null;
  const ids = new Set(documents.map((doc) => doc.id));
  const allowed = await readable(rows.value.filter((doc) => ids.has(doc.id)));
  return documents.filter((doc) => !allowed.has(doc.id)).map((doc) => doc.id);
};

const loadGraphLinks = async (
  store: StorePort,
  seedDocumentIds: number[],
  options: {
    collection?: string;
    collections?: string[];
    includeSimilar?: boolean;
    readable?: ReadableDocumentsCheck;
  }
): Promise<
  { ok: true; links: GraphLink[] } | { ok: false; reason: string }
> => {
  const readable = options.readable;
  if (typeof store.getGraphNeighborsForSeeds === "function") {
    // With `readable`, links resolve over the readable documents only: the
    // documents that decided a resolution are checked, and resolution runs
    // again without any the caller may not read.
    const hidden = new Set<number>();
    const checked = new Set<number>();
    for (let round = 0; round < GRAPH_RESOLUTION_ROUNDS; round += 1) {
      const neighborsResult = await store.getGraphNeighborsForSeeds({
        seedDocumentIds,
        collection: options.collection,
        collections: options.collections,
        limitEdges: GRAPH_EDGE_LIMIT,
        ...(readable ? { hiddenDocumentIds: [...hidden] } : {}),
      });
      if (!neighborsResult.ok) {
        return { ok: false, reason: "graph_query_failed" };
      }
      if (!readable) return { ok: true, links: neighborsResult.value.links };
      const unchecked = (
        neighborsResult.value.meta.resolutionDocuments ?? []
      ).filter((doc) => !checked.has(doc.id));
      const unreadable = await unreadableDocumentIds(
        store,
        unchecked,
        readable
      );
      if (unreadable === null) {
        return { ok: false, reason: "graph_query_failed" };
      }
      if (unreadable.length === 0) {
        return { ok: true, links: neighborsResult.value.links };
      }
      for (const doc of unchecked) checked.add(doc.id);
      for (const id of unreadable) hidden.add(id);
    }
    return { ok: false, reason: "graph_query_failed" };
  }

  // The full-graph fallback cannot leave hidden documents out of resolution.
  if (readable || typeof store.getGraph !== "function") {
    return { ok: false, reason: "graph_unavailable" };
  }

  // Compatibility fallback for mocks/adapters without the scoped method.
  const graphResult = await store.getGraph({
    collection: options.collection,
    limitNodes: GRAPH_NODE_LIMIT,
    limitEdges: GRAPH_EDGE_LIMIT,
    includeSimilar: options.includeSimilar ?? false,
    linkedOnly: true,
  });
  if (!graphResult.ok) {
    return { ok: false, reason: "graph_query_failed" };
  }
  return { ok: true, links: graphResult.value.links };
};

/**
 * Expand top retrieval candidates through one-hop graph neighbors.
 */
export async function expandGraphCandidates(
  store: StorePort,
  fusedCandidates: FusionCandidate[],
  options: {
    collection?: string;
    /**
     * Graph allowlist (plural request scope). Neighbours must belong to one of
     * these collections; defaults to `[collection]` when unset.
     */
    collections?: string[];
    includeSimilar?: boolean;
    eligibility?: DocumentEligibilityOptions;
    limit?: number;
    candidateLimit?: number;
    disabled?: boolean;
    lang?: string;
    tagsAll?: string[];
    tagsAny?: string[];
    since?: string;
    until?: string;
    categories?: string[];
    author?: string;
    filter?: MetadataPredicate;
    relPathPrefix?: string;
    /**
     * The documents a scoped caller may read. Links resolve over these alone,
     * before targets are chosen, matches counted and neighbours scored, so a
     * hidden document never takes a link or changes its confidence.
     */
    readable?: ReadableDocumentsCheck;
    /**
     * Access hook check (gateway access mode, so always with
     * `accessScoped`): neighbours it does not allow are dropped before
     * ranking.
     */
    access?: DocumentAccessCheck;
    /**
     * The request is confined to a caller's readable corpus: seeds come only
     * from the allowlist, edge counts cover only eligible neighbours, and "no
     * usable neighbour" has one fallback reason, so a link to a document the
     * caller may not read cannot be told apart from no link at all.
     */
    accessScoped?: boolean;
  } = {},
  hydration: Pick<
    StorePort,
    "getChunksBatch" | "getDocumentsByMirrorHashes"
  > = store
): Promise<GraphRetrievalResult> {
  const maxCandidates = Math.max(
    1,
    Math.min(
      GRAPH_CANDIDATE_LIMIT,
      options.candidateLimit ?? options.limit ?? GRAPH_CANDIDATE_LIMIT
    )
  );
  const meta = createMeta({ maxCandidates });

  if (options.disabled) {
    meta.fallbackReasons.push("graph_disabled");
    return { candidates: [], meta };
  }
  if (fusedCandidates.length === 0) {
    meta.fallbackReasons.push("graph_no_seed_candidates");
    return { candidates: [], meta };
  }
  const hasScopedNeighbors =
    typeof store.getGraphNeighborsForSeeds === "function";
  const hasFullGraph = typeof store.getGraph === "function";
  if (!hasScopedNeighbors && !hasFullGraph) {
    meta.fallbackReasons.push("graph_unavailable");
    return { candidates: [], meta };
  }

  meta.attempted = true;
  const seedCandidates = fusedCandidates.slice(0, GRAPH_SEED_LIMIT);
  const seedHashes = [...new Set(seedCandidates.map((c) => c.mirrorHash))];
  const preferredSeqByHash = new Map<string, number>();
  for (const candidate of fusedCandidates) {
    if (!preferredSeqByHash.has(candidate.mirrorHash)) {
      preferredSeqByHash.set(candidate.mirrorHash, candidate.seq);
    }
  }
  const seedDocsResult = await hydration.getDocumentsByMirrorHashes(
    seedHashes,
    {
      collection: options.collection,
      activeOnly: true,
    }
  );
  if (!seedDocsResult.ok || seedDocsResult.value.length === 0) {
    meta.fallbackReasons.push("graph_seed_lookup_empty");
    return { candidates: [], meta };
  }

  const graphAllowlist = options.collections
    ? new Set(options.collections)
    : options.collection
      ? new Set([options.collection])
      : undefined;
  const rankedSeedDocs: Array<{ doc: DocumentRow; rank: number }> = [];
  for (const doc of seedDocsResult.value) {
    if (!doc.mirrorHash || typedMetadataFilterReason(doc, options.filter)) {
      continue;
    }
    // A hidden document sharing a seed's content must not seed (or count).
    if (
      options.accessScoped &&
      graphAllowlist &&
      !graphAllowlist.has(doc.collection)
    ) {
      continue;
    }
    if (
      options.relPathPrefix !== undefined &&
      sourceRelPath(doc) !== options.relPathPrefix &&
      !sourceRelPath(doc).startsWith(`${options.relPathPrefix}/`)
    ) {
      continue;
    }
    const rank =
      seedCandidates.findIndex(
        (candidate) =>
          candidate.mirrorHash === doc.mirrorHash &&
          (candidate.documentId === undefined ||
            candidate.documentId === doc.id)
      ) + 1;
    if (rank <= 0) {
      continue;
    }
    rankedSeedDocs.push({ doc, rank });
  }
  rankedSeedDocs.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.doc.id - right.doc.id ||
      left.doc.docid.localeCompare(right.doc.docid)
  );

  const seedByDocid = new Map<string, { doc: DocumentRow; rank: number }>();
  for (const seed of rankedSeedDocs) {
    if (seedByDocid.size >= GRAPH_SEED_LIMIT) {
      break;
    }
    if (!seedByDocid.has(seed.doc.docid)) {
      seedByDocid.set(seed.doc.docid, seed);
    }
  }
  const seedDocids = new Set(seedByDocid.keys());
  meta.seedCount = seedByDocid.size;
  if (seedByDocid.size === 0) {
    meta.fallbackReasons.push("graph_seed_lookup_empty");
    return { candidates: [], meta };
  }

  const seedDocumentIds = [...seedByDocid.values()].map(({ doc }) => doc.id);
  const linksResult = await loadGraphLinks(store, seedDocumentIds, {
    collection: options.collection,
    collections: options.collections,
    includeSimilar: options.includeSimilar,
    readable: options.readable,
  });
  if (!linksResult.ok) {
    meta.fallbackReasons.push(linksResult.reason);
    return { candidates: [], meta };
  }
  if (linksResult.links.length === 0) {
    meta.fallbackReasons.push(
      options.accessScoped ? "graph_no_new_candidates" : "graph_empty"
    );
    return { candidates: [], meta };
  }

  const neighborScores = new Map<string, number>();
  const edgeConfidence = { ...EMPTY_EDGE_CONFIDENCE };
  for (const link of linksResult.links) {
    const sourceSeed = seedByDocid.get(link.source);
    const targetSeed = seedByDocid.get(link.target);
    if (sourceSeed && !seedDocids.has(link.target)) {
      addEdgeCandidate(
        neighborScores,
        link,
        link.target,
        sourceSeed.rank,
        edgeConfidence
      );
    }
    if (targetSeed && !seedDocids.has(link.source)) {
      addEdgeCandidate(
        neighborScores,
        link,
        link.source,
        targetSeed.rank,
        edgeConfidence
      );
    }
  }
  meta.edgeConfidence = edgeConfidence;

  const rankedNeighborDocids = [...neighborScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([docid]) => docid);
  if (rankedNeighborDocids.length === 0) {
    meta.fallbackReasons.push("graph_no_new_candidates");
    return { candidates: [], meta };
  }

  // A plural allowlist hydrates across its collections; scope is enforced on
  // each neighbour's own collection below, never widened past the allowlist.
  const plural = options.collections !== undefined;
  const docsResult = await store.getDocumentsByDocids(rankedNeighborDocids, {
    eligibility:
      plural && options.eligibility
        ? { ...options.eligibility, collection: undefined }
        : options.eligibility,
    collection: plural ? undefined : options.collection,
    activeOnly: true,
  });
  if (!docsResult.ok) {
    meta.fallbackReasons.push("graph_neighbor_lookup_failed");
    return { candidates: [], meta };
  }

  const metadataFilteredDocs = docsResult.value.filter(
    (doc) =>
      doc.mirrorHash &&
      (!graphAllowlist || graphAllowlist.has(doc.collection)) &&
      (options.relPathPrefix === undefined ||
        sourceRelPath(doc) === options.relPathPrefix ||
        sourceRelPath(doc).startsWith(`${options.relPathPrefix}/`)) &&
      matchesDocumentFilters(doc, options)
  );
  let docs = await filterDocsByTags(store, metadataFilteredDocs, options);
  if (options.access) {
    const allowed = await options.access(docs);
    docs = docs.filter((doc) => allowed.has(doc.id));
  }
  if (options.accessScoped) {
    // Count only edges to neighbours that survived every filter.
    const kept = new Set(docs.map((doc) => doc.docid));
    const keptConfidence = { ...EMPTY_EDGE_CONFIDENCE };
    for (const link of linksResult.links) {
      const neighbour = seedByDocid.has(link.source)
        ? link.target
        : seedByDocid.has(link.target)
          ? link.source
          : null;
      if (neighbour && kept.has(neighbour) && !seedDocids.has(neighbour)) {
        keptConfidence[link.confidence] += 1;
      }
    }
    meta.edgeConfidence = keptConfidence;
  }
  const docByDocid = new Map(docs.map((doc) => [doc.docid, doc]));
  const rankedDocs = rankedNeighborDocids
    .map((docid) => docByDocid.get(docid))
    .filter((doc): doc is DocumentRow => Boolean(doc?.mirrorHash))
    .slice(0, maxCandidates);
  const hashes = rankedDocs
    .map((doc) => doc.mirrorHash)
    .filter((hash): hash is string => Boolean(hash));
  const chunksResult = await hydration.getChunksBatch(hashes);
  if (!chunksResult.ok) {
    meta.fallbackReasons.push("graph_neighbor_chunks_failed");
    return { candidates: [], meta };
  }

  const candidates = rankedDocs
    .map((doc) => {
      const mirrorHash = doc.mirrorHash as string;
      const seq = chooseCandidateSeq(
        doc,
        chunksResult.value.get(mirrorHash) ?? [],
        preferredSeqByHash,
        options.lang
      );
      return seq === null
        ? null
        : {
            mirrorHash,
            seq,
            ...(fusedCandidates.some(
              (candidate) => candidate.documentId !== undefined
            )
              ? { sourceDocid: doc.docid }
              : {}),
          };
    })
    .filter(
      (candidate): candidate is { mirrorHash: string; seq: number } =>
        candidate !== null
    );

  meta.enabled = candidates.length > 0;
  meta.candidateCount = candidates.length;
  if (candidates.length === 0) {
    meta.fallbackReasons.push(
      options.accessScoped
        ? "graph_no_new_candidates"
        : "graph_neighbor_lookup_empty"
    );
  }

  return { candidates, meta };
}
