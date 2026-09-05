/** Immutable raw hydration owned by one retrieval request, never by a model.
 * Create at the request boundary and release in finally (or on abort). No read
 * transaction survives a store call. Already-started stages keep their values.
 */
import type {
  ChunkRow,
  DocumentRow,
  StorePort,
  StoreResult,
} from "../store/types";

import { getContentBatch } from "../store/content-batch";
import { err, ok } from "../store/types";

type BatchCache<T> = Map<string, Promise<StoreResult<T | undefined>>>;
type DocumentOptions = Parameters<StorePort["getDocumentsByMirrorHashes"]>[1];

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Each caller owns its Map; cached rows are detached, recursively frozen data.
 * The StorePort-compatible types let existing consumers read these snapshots.
 * Consumers that need to mutate a row/array must copy it first.
 */
async function loadBatch<T>(
  cache: BatchCache<T>,
  keys: string[],
  load: (missing: string[]) => Promise<StoreResult<Map<string, T>>>
): Promise<StoreResult<Map<string, T>>> {
  const unique = [...new Set(keys)];
  const missing = unique.filter((key) => !cache.has(key));
  if (missing.length > 0) {
    // Defer the store call until every pending key is published, including when
    // a lightweight adapter throws synchronously instead of returning a result.
    const batch = Promise.resolve().then(async () => {
      const result = await load(missing);
      if (!result.ok) return result;
      const snapshots = new Map<string, T>();
      for (const key of missing) {
        if (result.value.has(key)) {
          snapshots.set(
            key,
            freezeDeep(structuredClone(result.value.get(key)!))
          );
        }
      }
      return ok(snapshots);
    });
    for (const key of missing) {
      const pending = batch.then(
        (result): StoreResult<T | undefined> => {
          if (!result.ok) {
            if (cache.get(key) === pending) cache.delete(key);
            return result;
          }
          return ok(result.value.get(key));
        },
        (error: unknown) => {
          if (cache.get(key) === pending) cache.delete(key);
          throw error;
        }
      );
      cache.set(key, pending);
    }
  }
  // Capture the promises before yielding: release clears ownership, not work.
  const pending = unique.map((key) => cache.get(key)!);
  const results = await Promise.all(pending);
  const values = new Map<string, T>();
  for (const [index, result] of results.entries()) {
    if (!result.ok) return result;
    if (result.value !== undefined) values.set(unique[index]!, result.value);
  }
  return ok(values);
}

export class RequestHydration {
  private store: StorePort | null;
  private readonly chunks: BatchCache<ChunkRow[]> = new Map();
  private readonly content: BatchCache<string> = new Map();
  private readonly documents: BatchCache<DocumentRow[]> = new Map();
  private readonly signal?: AbortSignal;

  constructor(store: StorePort, signal?: AbortSignal) {
    this.store = store;
    this.signal = signal;
    if (signal?.aborted) this.release();
    else signal?.addEventListener("abort", this.release, { once: true });
  }

  /** Idempotent. Returned snapshots and pending loads remain valid; new loads
   * fail. Abort does not cancel a store operation another active stage needs.
   */
  readonly release = (): void => {
    this.signal?.removeEventListener("abort", this.release);
    this.store = null;
    this.chunks.clear();
    this.content.clear();
    this.documents.clear();
  };

  getChunksBatch(
    hashes: string[]
  ): Promise<StoreResult<Map<string, ChunkRow[]>>> {
    const store = this.store;
    if (!store)
      return Promise.resolve(err("QUERY_FAILED", "Hydration request released"));
    return loadBatch(this.chunks, hashes, (missing) =>
      store.getChunksBatch(missing)
    );
  }

  getContentBatch(hashes: string[]): Promise<StoreResult<Map<string, string>>> {
    const store = this.store;
    if (!store)
      return Promise.resolve(err("QUERY_FAILED", "Hydration request released"));
    return loadBatch(this.content, hashes, (missing) =>
      getContentBatch(store, missing)
    );
  }

  async getContent(hash: string): Promise<StoreResult<string | null>> {
    const store = this.store;
    if (!store) return err("QUERY_FAILED", "Hydration request released");
    const result = await loadBatch(this.content, [hash], async () => {
      const content = await store.getContent(hash);
      if (!content.ok) return content;
      return ok(new Map(content.value === null ? [] : [[hash, content.value]]));
    });
    return result.ok ? ok(result.value.get(hash) ?? null) : result;
  }

  async getDocumentsByMirrorHashes(
    hashes: string[],
    options?: DocumentOptions
  ): Promise<StoreResult<DocumentRow[]>> {
    const store = this.store;
    if (!store) return err("QUERY_FAILED", "Hydration request released");
    // Capture caller-owned options before any asynchronous read. Collection
    // and activity are part of the lookup identity; titles never key by hash.
    const scope = { ...options };
    // Cache the exact lookup, retaining the adapter's ordering (including SQL
    // batch boundaries). Regrouping by content hash would reorder documents.
    const requested = [...hashes];
    const identity = JSON.stringify([
      scope.collection ?? null,
      scope.activeOnly ?? null,
      requested,
    ]);
    const result = await loadBatch(this.documents, [identity], async () => {
      const rows = await store.getDocumentsByMirrorHashes(requested, scope);
      return rows.ok ? ok(new Map([[identity, rows.value]])) : rows;
    });
    return result.ok ? ok([...(result.value.get(identity) ?? [])]) : result;
  }
}
