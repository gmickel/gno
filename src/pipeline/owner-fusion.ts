import type { StorePort, TagRow } from "../store/types";
import type { RankedInput } from "./fusion";
import type { RequestHydration } from "./hydration";
import type { HybridSearchOptions } from "./types";

import {
  compileDocumentFilters,
  evaluateRetrievalEligibility,
} from "./filters";

export class OwnerMetadataError extends Error {}

/** Materialize legacy lexical/graph owner domains only when variant retrieval is active. */
export async function resolveFusionOwners(
  inputs: RankedInput[],
  store: StorePort,
  hydration: RequestHydration,
  query: string,
  options: HybridSearchOptions,
  forceResolve = false
): Promise<RankedInput[]> {
  if (
    !forceResolve &&
    !inputs.some((input) =>
      input.results.some((result) => result.documentId !== undefined)
    )
  )
    return inputs;
  const hashes = [
    ...new Set(
      inputs.flatMap((input) =>
        input.results.map((result) => result.mirrorHash)
      )
    ),
  ];
  if (hashes.length === 0) return inputs;
  const [documents, chunks] = await Promise.all([
    hydration.getDocumentsByMirrorHashes(hashes, {
      collection: options.collection,
      collections: options.collections,
      activeOnly: true,
    }),
    hydration.getChunksBatch(hashes),
  ]);
  if (!documents.ok || !chunks.ok)
    throw new OwnerMetadataError("Vector owner metadata unavailable");

  let memoryIds: Set<number> | undefined;
  const needsTags = Boolean(options.tagsAll?.length || options.tagsAny?.length);
  const candidateDocs = documents.value.filter((doc) =>
    Boolean(doc.mirrorHash)
  );

  const memoryPromise = options.memoryFilter
    ? Promise.all(
        [...new Set(documents.value.map((doc) => doc.collection))].map(
          (collection) =>
            store.listMemoryEligibleDocuments({
              collection,
              scopes: options.memoryFilter!.scopes,
              excludeSuperseded: options.memoryFilter!.excludeSuperseded,
            })
        )
      )
    : undefined;

  const tagsPromise =
    needsTags &&
    candidateDocs.length > 0 &&
    typeof store.getTagsBatch === "function"
      ? store.getTagsBatch(candidateDocs.map((doc) => doc.id))
      : undefined;

  const [memoryResults, tagsResult] = await Promise.all([
    memoryPromise,
    tagsPromise,
  ]);

  if (memoryResults) {
    memoryIds = new Set();
    for (const eligible of memoryResults) {
      if (!eligible.ok)
        throw new OwnerMetadataError("Memory owner metadata unavailable");
      for (const doc of eligible.value) memoryIds.add(doc.id);
    }
  }

  let prefetchedTags: Map<number, TagRow[]> | null | undefined;
  if (tagsPromise) {
    prefetchedTags = tagsResult?.ok ? tagsResult.value : null;
  }

  const compiledFilters = compileDocumentFilters(query, options);
  const docids = new Map(documents.value.map((doc) => [doc.id, doc.docid]));
  const owners = new Map<string, number[]>();
  for (const doc of documents.value) {
    if (!doc.mirrorHash || (memoryIds && !memoryIds.has(doc.id))) continue;
    const eligibility = await evaluateRetrievalEligibility(
      store,
      query,
      doc,
      chunks.value.get(doc.mirrorHash),
      options,
      undefined,
      compiledFilters,
      prefetchedTags
    );
    for (const chunk of eligibility.chunks) {
      const key = `${doc.mirrorHash}:${chunk.seq}`;
      const ids = owners.get(key) ?? [];
      ids.push(doc.id);
      owners.set(key, ids);
    }
  }
  return inputs.map((input) => ({
    ...input,
    results: input.results.flatMap((result) => {
      const ids = owners.get(`${result.mirrorHash}:${result.seq}`) ?? [];
      return ids
        .filter((id) => {
          if (result.documentId !== undefined) return result.documentId === id;
          if (result.sourceDocid !== undefined)
            return result.sourceDocid === docids.get(id);
          // Older custom stores without provenance cannot lend a rank to ambiguous owners.
          return ids.length === 1;
        })
        .map((documentId) => ({ ...result, documentId }));
    }),
  }));
}
