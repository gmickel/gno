import type { EmbeddingPort } from "../llm/types";
import type { VectorOwnerInput } from "../store/vector/types";
import type { VectorVariantStore } from "../store/vector/variants";

import { err, ok } from "../store/types";
import { embedTextsWithRecovery } from "./batch";
import {
  type AcquireWriteTurn,
  chunkRetryKey,
  inWriteTurn,
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

function filterCurrentOwners(
  store: VectorVariantStore,
  owners: VectorOwnerInput[]
): VectorOwnerInput[] {
  if (owners.length === 0) return [];
  if (typeof store.filterCurrent === "function") {
    return store.filterCurrent(owners);
  }
  return owners.filter((owner) => isCurrent(store, owner));
}

export interface PreparedVariantBatch {
  owners: VectorOwnerInput[];
  inputs: Map<string, string>;
  reusable: Set<string>;
  sharedFromInFlight: Map<string, string>;
}

export interface VariantBatchOutcome {
  embedded: number;
  errors: number;
  contentionErrors: number;
  retryOwners: VectorOwnerInput[];
  deferred?: boolean;
}

export function prepareVariantBatch(params: {
  store: VectorVariantStore;
  owners: VectorOwnerInput[];
  force?: boolean;
  inFlightHashes?: ReadonlySet<string>;
}): PreparedVariantBatch {
  const { store } = params;
  const deduped = [
    ...new Map(
      params.owners.map((owner) => [chunkRetryKey(owner), owner])
    ).values(),
  ];

  let owners: VectorOwnerInput[];
  const reusable = new Set<string>();
  const inputs = new Map<string, string>();
  const sharedFromInFlight = new Map<string, string>();

  if (!params.force && typeof store.findReusableHashes === "function") {
    const found = store.findReusableHashes(deduped);
    owners = found.current;
    for (const hash of found.reusableHashes) {
      reusable.add(hash);
    }
    for (const owner of owners) {
      if (reusable.has(owner.inputHash)) continue;
      if (params.inFlightHashes?.has(owner.inputHash)) {
        sharedFromInFlight.set(owner.inputHash, owner.formattedInput);
      } else {
        inputs.set(owner.inputHash, owner.formattedInput);
      }
    }
  } else {
    owners = filterCurrentOwners(store, deduped);
    for (const owner of owners) {
      const canReuse =
        !params.force &&
        (typeof store.hasReusable === "function"
          ? store.hasReusable(owner)
          : Boolean(store.reusable(owner)));
      if (canReuse) {
        reusable.add(owner.inputHash);
      } else if (!params.force && params.inFlightHashes?.has(owner.inputHash)) {
        sharedFromInFlight.set(owner.inputHash, owner.formattedInput);
      } else {
        inputs.set(owner.inputHash, owner.formattedInput);
      }
    }
  }

  return { owners, inputs, reusable, sharedFromInFlight };
}

export async function commitVariantBatch(params: {
  store: VectorVariantStore;
  owners: VectorOwnerInput[];
  reusable: ReadonlySet<string>;
  vectors: ReadonlyMap<string, Float32Array>;
  identityStillCurrent: () => boolean;
  delays?: number[];
  acquireWriteTurn?: AcquireWriteTurn;
}): Promise<VariantBatchOutcome> {
  const { store, owners, reusable, vectors, identityStillCurrent } = params;
  const empty: VariantBatchOutcome = {
    embedded: 0,
    errors: 0,
    contentionErrors: 0,
    retryOwners: [],
  };
  if (!identityStillCurrent()) return empty;

  const failedOwners: VectorOwnerInput[] = [];
  const rows: { owner: VectorOwnerInput; embedding?: Float32Array }[] = [];
  for (const owner of owners) {
    const vec = vectors.get(owner.inputHash);
    if (vec !== undefined || reusable.has(owner.inputHash)) {
      rows.push({ owner, embedding: vec });
    } else {
      failedOwners.push(owner);
    }
  }
  // Recheck isCurrent post-inference only for failed retryOwners; writeCurrent
  // validates and filters successful rows atomically inside the write txn.
  const retryOwners = filterCurrentOwners(store, failedOwners);
  if (!rows.length) return { ...empty, retryOwners };

  let written = 0;
  const turn = await inWriteTurn(params.acquireWriteTurn, () =>
    upsertVectorsWithContentionRetry(
      {
        upsertVectors: () => {
          try {
            // A contention wait may allow document or runtime mutations. Revalidate each attempt.
            if (!identityStillCurrent()) return Promise.resolve(ok(undefined));
            if (typeof store.writeCurrent === "function") {
              written = store.writeCurrent(rows).length;
            } else {
              const valid = rows.filter(({ owner }) => isCurrent(store, owner));
              store.write(valid);
              written = valid.length;
            }
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
    )
  );
  if (turn.deferred) return { ...empty, deferred: true };
  const persisted = turn.value;
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

/** Exact inputs are inferred once; successful current owners checkpoint atomically. */
export async function embedVariantBatch(params: {
  store: VectorVariantStore;
  embedPort: EmbeddingPort;
  owners: VectorOwnerInput[];
  identityStillCurrent: () => boolean;
  delays?: number[];
  force?: boolean;
  /** Gate held only around the checkpoint write, never around inference. */
  acquireWriteTurn?: AcquireWriteTurn;
  /** Called with the text count of each provider request (see `embedTextsWithRecovery`). */
  onSubmit?: (texts: number) => void;
}): Promise<VariantBatchOutcome> {
  const { store, embedPort, identityStillCurrent } = params;
  const empty: VariantBatchOutcome = {
    embedded: 0,
    errors: 0,
    contentionErrors: 0,
    retryOwners: [],
  };
  if (!identityStillCurrent()) return empty;
  const prepared = prepareVariantBatch({
    store,
    owners: params.owners,
    force: params.force,
  });
  const keys = [...prepared.inputs.keys()];
  const result = await embedTextsWithRecovery(
    embedPort,
    [...prepared.inputs.values()],
    {
      onSubmit: params.onSubmit,
    }
  );
  if (!identityStillCurrent()) return empty;
  const vectors = new Map<string, Float32Array>();
  if (result.ok) {
    for (const [index, key] of keys.entries()) {
      const vector = result.value.vectors[index];
      if (vector) vectors.set(key, new Float32Array(vector));
    }
  }
  return commitVariantBatch({
    store,
    owners: prepared.owners,
    reusable: prepared.reusable,
    vectors,
    identityStillCurrent,
    delays: params.delays,
    acquireWriteTurn: params.acquireWriteTurn,
  });
}
