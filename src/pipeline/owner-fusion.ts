import type { StorePort } from "../store/types";
import type { RankedInput } from "./fusion";
import type { RequestHydration } from "./hydration";
import type { HybridSearchOptions } from "./types";

import { evaluateRetrievalEligibility } from "./filters";

export class OwnerMetadataError extends Error {}

/** Materialize legacy lexical/graph owner domains only when variant retrieval is active. */
export async function resolveFusionOwners(
  inputs: RankedInput[],
  store: StorePort,
  hydration: RequestHydration,
  query: string,
  options: HybridSearchOptions
): Promise<RankedInput[]> {
  if (
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
  const documents = await hydration.getDocumentsByMirrorHashes(hashes, {
    collection: options.collection,
    activeOnly: true,
  });
  const chunks = await hydration.getChunksBatch(hashes);
  if (!documents.ok || !chunks.ok)
    throw new OwnerMetadataError("Vector owner metadata unavailable");
  let memoryIds: Set<number> | undefined;
  if (options.memoryFilter) {
    memoryIds = new Set();
    for (const collection of new Set(
      documents.value.map((doc) => doc.collection)
    )) {
      const eligible = await store.listMemoryEligibleDocuments({
        collection,
        scopes: options.memoryFilter.scopes,
        excludeSuperseded: options.memoryFilter.excludeSuperseded,
      });
      if (!eligible.ok)
        throw new OwnerMetadataError("Memory owner metadata unavailable");
      for (const doc of eligible.value) memoryIds.add(doc.id);
    }
  }
  const owners = new Map<string, number[]>();
  for (const doc of documents.value) {
    if (!doc.mirrorHash || (memoryIds && !memoryIds.has(doc.id))) continue;
    const eligibility = await evaluateRetrievalEligibility(
      store,
      query,
      doc,
      chunks.value.get(doc.mirrorHash),
      options
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
        .filter(
          (id) => result.documentId === undefined || result.documentId === id
        )
        .map((documentId) => ({ ...result, documentId }));
    }),
  }));
}
