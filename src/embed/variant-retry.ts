import type { EmbeddingPort } from "../llm/types";
import type { VectorOwnerInput } from "../store/vector/types";
import type { VectorVariantStore } from "../store/vector/variants";

import { err, ok } from "../store/types";
import { embedTextsWithRecovery } from "./batch";
import {
  chunkRetryKey,
  isUpsertLockContention,
  upsertVectorsWithContentionRetry,
} from "./retry";

function isCurrent(
  store: VectorVariantStore,
  owner: VectorOwnerInput
): boolean {
  const current = store.current(owner.documentId, owner.seq);
  return (
    current?.mirrorHash === owner.mirrorHash &&
    current.inputHash === owner.inputHash &&
    current.formattedInput === owner.formattedInput
  );
}

/** Exact inputs are inferred once; successful current owners checkpoint atomically. */
export async function embedVariantBatch(params: {
  store: VectorVariantStore;
  embedPort: EmbeddingPort;
  owners: VectorOwnerInput[];
  identityStillCurrent: () => boolean;
  delays?: number[];
}): Promise<{
  embedded: number;
  errors: number;
  contentionErrors: number;
  retryOwners: VectorOwnerInput[];
}> {
  const { store, embedPort, identityStillCurrent } = params;
  const empty = {
    embedded: 0,
    errors: 0,
    contentionErrors: 0,
    retryOwners: [] as VectorOwnerInput[],
  };
  if (!identityStillCurrent()) return empty;
  const owners = [
    ...new Map(
      params.owners.map((owner) => [chunkRetryKey(owner), owner])
    ).values(),
  ].filter((owner) => isCurrent(store, owner));
  const inputs = new Map<string, string>();
  const reusable = new Set<string>();
  for (const owner of owners) {
    if (store.reusable(owner)) reusable.add(owner.inputHash);
    else inputs.set(owner.inputHash, owner.formattedInput);
  }
  const keys = [...inputs.keys()];
  const result = await embedTextsWithRecovery(embedPort, [...inputs.values()]);
  if (!identityStillCurrent()) return empty;
  const current = owners.filter((owner) => isCurrent(store, owner));
  const vectors = new Map<string, Float32Array>();
  if (result.ok) {
    for (const [index, key] of keys.entries()) {
      const vector = result.value.vectors[index];
      if (vector) vectors.set(key, new Float32Array(vector));
    }
  }
  const retryOwners = current.filter(
    (owner) => !reusable.has(owner.inputHash) && !vectors.has(owner.inputHash)
  );
  const rows = current
    .filter(
      (owner) => reusable.has(owner.inputHash) || vectors.has(owner.inputHash)
    )
    .map((owner) => ({ owner, embedding: vectors.get(owner.inputHash) }));
  if (!rows.length) return { ...empty, retryOwners };
  let written = 0;
  const persisted = await upsertVectorsWithContentionRetry(
    {
      upsertVectors: () => {
        try {
          // A contention wait may allow document or runtime mutations. Revalidate each attempt.
          if (!identityStillCurrent()) return Promise.resolve(ok(undefined));
          const valid = rows.filter(({ owner }) => isCurrent(store, owner));
          store.write(valid);
          written = valid.length;
          return Promise.resolve(ok(undefined));
        } catch (cause) {
          return Promise.resolve(
            err(
              "QUERY_FAILED",
              cause instanceof Error ? cause.message : String(cause),
              cause
            )
          );
        }
      },
    },
    [],
    params.delays
  );
  if (!persisted.ok)
    return {
      ...empty,
      retryOwners,
      errors: isUpsertLockContention(persisted.error) ? 0 : rows.length,
      contentionErrors: isUpsertLockContention(persisted.error)
        ? rows.length
        : 0,
    };
  return { ...empty, embedded: written, retryOwners };
}
