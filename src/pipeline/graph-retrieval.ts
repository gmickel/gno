/**
 * Bounded graph expansion for hybrid retrieval.
 *
 * @module src/pipeline/graph-retrieval
 */

import type {
  ChunkRow,
  DocumentRow,
  GraphEdgeConfidence,
  GraphLink,
  StorePort,
} from "../store/types";
import type { FusionCandidate } from "./types";

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
  candidates: Array<{ mirrorHash: string; seq: number }>;
  meta: GraphRetrievalMeta;
}

const GRAPH_SEED_LIMIT = 5;
const GRAPH_CANDIDATE_LIMIT = 20;
const GRAPH_NODE_LIMIT = 2000;
const GRAPH_EDGE_LIMIT = 10000;

const EMPTY_EDGE_CONFIDENCE: Record<GraphEdgeConfidence, number> = {
  explicit: 0,
  inferred: 0,
  ambiguous: 0,
  similarity: 0,
};

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
  }
): boolean => {
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
 * Expand top retrieval candidates through one-hop graph neighbors.
 */
export async function expandGraphCandidates(
  store: StorePort,
  fusedCandidates: FusionCandidate[],
  options: {
    collection?: string;
    includeSimilar?: boolean;
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
  } = {}
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
  if (typeof store.getGraph !== "function") {
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
  const seedDocsResult = await store.getDocumentsByMirrorHashes(seedHashes, {
    collection: options.collection,
    activeOnly: true,
  });
  if (!seedDocsResult.ok || seedDocsResult.value.length === 0) {
    meta.fallbackReasons.push("graph_seed_lookup_empty");
    return { candidates: [], meta };
  }

  const seedByDocid = new Map<string, { doc: DocumentRow; rank: number }>();
  const seedDocids = new Set<string>();
  for (const doc of seedDocsResult.value) {
    if (!doc.mirrorHash) {
      continue;
    }
    const rank =
      seedCandidates.findIndex(
        (candidate) => candidate.mirrorHash === doc.mirrorHash
      ) + 1;
    if (rank <= 0) {
      continue;
    }
    seedByDocid.set(doc.docid, { doc, rank });
    seedDocids.add(doc.docid);
  }
  meta.seedCount = seedDocids.size;
  if (seedDocids.size === 0) {
    meta.fallbackReasons.push("graph_seed_lookup_empty");
    return { candidates: [], meta };
  }

  const graphResult = await store.getGraph({
    collection: options.collection,
    limitNodes: GRAPH_NODE_LIMIT,
    limitEdges: GRAPH_EDGE_LIMIT,
    includeSimilar: options.includeSimilar ?? false,
    linkedOnly: true,
  });
  if (!graphResult.ok) {
    meta.fallbackReasons.push("graph_query_failed");
    return { candidates: [], meta };
  }
  if (graphResult.value.links.length === 0) {
    meta.fallbackReasons.push("graph_empty");
    return { candidates: [], meta };
  }

  const neighborScores = new Map<string, number>();
  const edgeConfidence = { ...EMPTY_EDGE_CONFIDENCE };
  for (const link of graphResult.value.links) {
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
    .slice(0, maxCandidates)
    .map(([docid]) => docid);
  if (rankedNeighborDocids.length === 0) {
    meta.fallbackReasons.push("graph_no_new_candidates");
    return { candidates: [], meta };
  }

  const docsResult = await store.getDocumentsByDocids(rankedNeighborDocids, {
    collection: options.collection,
    activeOnly: true,
  });
  if (!docsResult.ok) {
    meta.fallbackReasons.push("graph_neighbor_lookup_failed");
    return { candidates: [], meta };
  }

  const metadataFilteredDocs = docsResult.value.filter(
    (doc) => doc.mirrorHash && matchesDocumentFilters(doc, options)
  );
  const docs = await filterDocsByTags(store, metadataFilteredDocs, options);
  const hashes = docs
    .map((doc) => doc.mirrorHash)
    .filter((hash): hash is string => Boolean(hash));
  const chunksResult = await store.getChunksBatch(hashes);
  if (!chunksResult.ok) {
    meta.fallbackReasons.push("graph_neighbor_chunks_failed");
    return { candidates: [], meta };
  }

  const docByDocid = new Map(docs.map((doc) => [doc.docid, doc]));
  const candidates = rankedNeighborDocids
    .map((docid) => docByDocid.get(docid))
    .filter((doc): doc is DocumentRow => Boolean(doc?.mirrorHash))
    .map((doc) => {
      const mirrorHash = doc.mirrorHash as string;
      const seq = chooseCandidateSeq(
        doc,
        chunksResult.value.get(mirrorHash) ?? [],
        preferredSeqByHash,
        options.lang
      );
      return seq === null ? null : { mirrorHash, seq };
    })
    .filter(
      (candidate): candidate is { mirrorHash: string; seq: number } =>
        candidate !== null
    );

  meta.enabled = candidates.length > 0;
  meta.candidateCount = candidates.length;
  if (candidates.length === 0) {
    meta.fallbackReasons.push("graph_neighbor_lookup_empty");
  }

  return { candidates, meta };
}
