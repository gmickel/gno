/**
 * Per-connection input-hash proof cache keyed on `vector_variant_epoch.epoch`.
 *
 * Every mutation to `documents`, `content_chunks`, `vector_owners`, or
 * `vector_variants` increments `vector_variant_epoch.epoch` via migration 028
 * triggers, so proofs survive unrelated writes (`retrieval_traces`,
 * `llm_cache`, `egress_audit_receipts`, `vector_runtime_callers`) while still
 * invalidating across connections whenever document titles or chunk text change.
 *
 * When a caller is already inside an uncommitted outer transaction
 * (`inOuterTransaction === true`), a call-local Map is returned so a later
 * `ROLLBACK` can never poison the connection-shared cache.
 *
 * @module src/store/vector/proof-cache
 */
import type { Database } from "bun:sqlite";

const MAX_CACHED_PROOFS = 100_000;

const proofCaches = new WeakMap<
  Database,
  { epoch: number; proofs: Map<string, boolean> }
>();

export function vectorProofKey(
  model: string,
  documentId: number,
  mirrorHash: string,
  seq: number,
  inputHash: string
): string {
  return `${model}\0${documentId}\0${mirrorHash}\0${seq}\0${inputHash}`;
}

export function provenOwners(
  db: Database,
  inOuterTransaction: boolean
): Map<string, boolean> {
  if (inOuterTransaction) {
    return new Map<string, boolean>();
  }
  const row = db
    .query<{ epoch: number }, []>(
      "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
    )
    .get();
  if (!row) {
    return new Map<string, boolean>();
  }
  let cache = proofCaches.get(db);
  if (cache?.epoch !== row.epoch || cache.proofs.size > MAX_CACHED_PROOFS) {
    cache = { epoch: row.epoch, proofs: new Map() };
    proofCaches.set(db, cache);
  }
  return cache.proofs;
}
