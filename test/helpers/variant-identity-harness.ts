/** Current variant writer around the immutable ingestion identity oracle. */
import type { EmbeddingPort } from "../../src/llm/types";

import {
  hash,
  model,
  openHarness,
  vector,
  type Owner,
} from "../../evals/fixtures/acceptance/ingestion-identity/oracle";
import { embedBacklog } from "../../src/embed/backlog";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { createVectorStatsPort } from "../../src/store/vector/stats";

export async function openVariantIdentityHarness(verified = true) {
  const harness = await openHarness();
  const db = harness.store.getRawDb();
  const port: EmbeddingPort = {
    modelUri: model,
    init: async () => ({ ok: true, value: undefined }),
    dimensions: () => 8,
    getIdentity: () =>
      verified
        ? {
            contextSize: 512,
            truncationPolicy: "complete-synthetic-fixture",
            modelFingerprint: "synthetic-identity-weights-v1",
            runtimeFingerprint: "deterministic-test-port-v1",
          }
        : undefined,
    embed: async (input) => {
      harness.calls.push({ input, model });
      return { ok: true, value: vector(input) };
    },
    embedBatch: async (inputs) => ({
      ok: true,
      value: inputs.map((input) => {
        harness.calls.push({ input, model });
        return vector(input);
      }),
    }),
    dispose: async () => {},
  };
  const index = await createVectorIndexPort(db, { model, dimensions: 8 });
  if (!index.ok) {
    await harness.close();
    throw new Error(index.error.message);
  }
  return {
    ...harness,
    async embed(): Promise<number> {
      const before = harness.calls.length;
      const result = await embedBacklog({
        embedPort: port,
        statsPort: createVectorStatsPort(db),
        vectorIndex: index.value,
        modelUri: model,
      });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.errors || result.value.syncError)
        throw new Error(JSON.stringify(result.value));
      return harness.calls.length - before;
    },
    snapshot(): Owner[] {
      if (!verified) {
        const provenance = new Map(
          harness.calls.map((call) => [
            JSON.stringify(vector(call.input)),
            hash(call.input),
          ])
        );
        return harness.snapshot().map((owner) => ({
          ...owner,
          inputHash: provenance.get(JSON.stringify(owner.embedding)) ?? null,
        }));
      }
      const rows = db
        .query<
          Omit<Owner, "embedding" | "model"> & { embedding: Uint8Array | null },
          [string]
        >(`
        SELECT d.rel_path AS path, d.title, d.mirror_hash AS mirror,
          c.text AS chunk, c.seq, v.input_hash AS inputHash, v.embedding
        FROM documents d JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
        LEFT JOIN vector_owners o ON o.document_id = d.id AND o.seq = c.seq
          AND o.mirror_hash = d.mirror_hash
        LEFT JOIN vector_variants v ON v.variant_id = o.variant_id
        LEFT JOIN vector_partitions p ON p.partition_id = v.partition_id
        WHERE d.active = 1 AND (p.model = ? OR p.model IS NULL)
        ORDER BY d.rel_path, c.seq
      `)
        .all(model);
      return rows.map((row) => ({
        ...row,
        model,
        embedding: row.embedding
          ? Array.from(new Float32Array(row.embedding.slice().buffer))
          : null,
      }));
    },
  };
}
