/** Native-free startup; dimensions are discovered only when vector work needs them. */
import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../../llm/types";
import type { VectorIndexPort } from "./types";

import { getStoredEmbeddingDimensions } from "./freshness";
import { bindVectorIndexDatabase, createVectorIndexPort } from "./sqlite-vec";

export async function createLazyVectorIndex(
  db: Database,
  model: string,
  embedPort: EmbeddingPort
): Promise<VectorIndexPort> {
  const stored = getStoredEmbeddingDimensions(db, model);
  let current: VectorIndexPort | undefined;
  let loading: Promise<VectorIndexPort> | undefined;
  let dirty = false;
  const create = async (dimensions: number): Promise<VectorIndexPort> => {
    const result = await createVectorIndexPort(db, { model, dimensions });
    if (!result.ok) throw new Error(result.error.message);
    current = result.value;
    current.vecDirty ||= dirty;
    return current;
  };
  if (stored !== undefined) return create(stored);
  const get = (): Promise<VectorIndexPort> => {
    if (current) return Promise.resolve(current);
    loading ??= (async () => {
      const result = await embedPort.init();
      if (!result.ok) throw new Error(result.error.message);
      return create(embedPort.dimensions());
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };
  return bindVectorIndexDatabase(
    {
      model,
      get dimensions() {
        return current?.dimensions ?? embedPort.dimensions();
      },
      get searchAvailable() {
        return current?.searchAvailable ?? true;
      },
      get loadError() {
        return current?.loadError;
      },
      get guidance() {
        return current?.guidance;
      },
      get vecDirty() {
        return current?.vecDirty ?? dirty;
      },
      set vecDirty(value) {
        dirty = value;
        if (current) current.vecDirty = value;
      },
      async upsertVectors(rows) {
        return (await get()).upsertVectors(rows);
      },
      async upsertVectorsChecked(rows, checkpoint) {
        const port = await get();
        if (!port.upsertVectorsChecked)
          throw new Error("Atomic vector checkpoint unavailable");
        return port.upsertVectorsChecked(rows, checkpoint);
      },
      async deleteVectorsForMirror(hash) {
        return (await get()).deleteVectorsForMirror(hash);
      },
      async searchNearest(embedding, k, options) {
        return (await get()).searchNearest(embedding, k, options);
      },
      async searchNearestBatch(embeddings, limits, options) {
        const port = await get();
        if (port.searchNearestBatch) {
          return port.searchNearestBatch(embeddings, limits, options);
        }
        const results = [];
        for (let i = 0; i < embeddings.length; i++) {
          const res = await port.searchNearest(
            embeddings[i]!,
            limits[i]!,
            options
          );
          if (!res.ok) return res;
          results.push(res.value);
        }
        return { ok: true as const, value: results };
      },
      async rebuildVecIndex() {
        return (await get()).rebuildVecIndex();
      },
      async syncVecIndex() {
        return (await get()).syncVecIndex();
      },
    },
    db
  );
}
