/** Exact-input storage. Synchronous methods throw and compose with DB transactions. */
import type { Database } from "bun:sqlite";

import type { VectorOwnerInput, VectorVariantIdentity } from "./types";

import { formatDocForEmbedding } from "../../pipeline/contextual";
import { decodeEmbedding, encodeEmbedding } from "./sqlite-vec";

export function embeddingInputHash(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

export function vectorVariantFingerprint(
  identity: VectorVariantIdentity
): string {
  return embeddingInputHash(
    JSON.stringify([
      "embedding-input-v1",
      identity.model,
      identity.modelFingerprint,
      identity.contextSize,
      identity.truncationPolicy,
    ])
  );
}

interface OwnerRow {
  documentId: number;
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
}

interface VariantRow {
  variant_id: number;
  input_hash: string;
  embedding: Uint8Array;
}

export class VectorVariantStore {
  readonly partitionId: string;
  readonly tableName: string;
  readonly fingerprint: string;
  readonly identity: Readonly<VectorVariantIdentity>;

  constructor(
    private readonly db: Database,
    identity: VectorVariantIdentity,
    readonly searchAvailable: boolean
  ) {
    if (
      !identity.model ||
      !identity.modelFingerprint ||
      !identity.truncationPolicy ||
      !Number.isSafeInteger(identity.contextSize) ||
      identity.contextSize < 1 ||
      !Number.isSafeInteger(identity.dimensions) ||
      identity.dimensions < 1
    ) {
      throw new Error("Invalid embedding variant identity");
    }
    this.identity = Object.freeze({ ...identity });
    this.fingerprint = vectorVariantFingerprint(identity);
    this.partitionId = embeddingInputHash(
      JSON.stringify([identity.model, this.fingerprint, identity.dimensions])
    );
    this.tableName = `vec_v1_${this.partitionId}`;
    db.transaction(() => {
      db.run(
        `INSERT OR IGNORE INTO vector_partitions
        (partition_id, version, model, fingerprint, dimensions) VALUES (?, 1, ?, ?, ?)`,
        [
          this.partitionId,
          identity.model,
          this.fingerprint,
          identity.dimensions,
        ]
      );
      if (searchAvailable) {
        const existing = db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE name = ?"
          )
          .get(this.tableName);
        if (!existing)
          db.run(
            "UPDATE vector_partitions SET state = 'shadow', activated_epoch = NULL WHERE partition_id = ?",
            [this.partitionId]
          );
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
          variant_id INTEGER PRIMARY KEY,
          embedding FLOAT[${identity.dimensions}] distance_metric=cosine
        )`);
      }
    }).immediate();
  }

  epoch(): number {
    return this.db
      .query<{ epoch: number }, []>(
        "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
      )
      .get()!.epoch;
  }

  private input(row: OwnerRow): VectorOwnerInput {
    const formattedInput = formatDocForEmbedding(
      row.text,
      row.title ?? undefined,
      this.identity.model
    );
    return {
      documentId: row.documentId,
      mirrorHash: row.mirrorHash,
      seq: row.seq,
      formattedInput,
      inputHash: embeddingInputHash(formattedInput),
    };
  }

  /** Current active input; never accepts historical legacy origin as proof. */
  current(documentId: number, seq: number): VectorOwnerInput | null {
    const row = this.db
      .query<OwnerRow, [number, number]>(`
      SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, c.seq, c.text, d.title
      FROM documents d JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      WHERE d.id = ? AND c.seq = ? AND d.active = 1
    `)
      .get(documentId, seq);
    return row ? this.input(row) : null;
  }

  private variant(input: VectorOwnerInput): VariantRow | null {
    return this.db
      .query<VariantRow, [string, string]>(`
      SELECT variant_id, input_hash, embedding FROM vector_variants
      WHERE partition_id = ? AND input_hash = ?
    `)
      .get(this.partitionId, input.inputHash);
  }

  /** Returns a proven reusable vector, even before this owner has a binding. */
  reusable(
    input: VectorOwnerInput
  ): { variantId: number; embedding: Float32Array } | null {
    this.validate(input);
    const row = this.variant(input);
    return row
      ? { variantId: row.variant_id, embedding: decodeEmbedding(row.embedding) }
      : null;
  }

  private validate(input: VectorOwnerInput): void {
    const current = this.current(input.documentId, input.seq);
    if (
      !current ||
      current.mirrorHash !== input.mirrorHash ||
      current.formattedInput !== input.formattedInput ||
      current.inputHash !== input.inputHash
    ) {
      throw new Error("Stale or invalid vector owner input");
    }
  }

  private assertWritable(): void {
    if (
      !this.searchAvailable &&
      this.db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE name = ?"
        )
        .get(this.tableName)
    ) {
      throw new Error(
        "Cannot mutate an existing variant index without sqlite-vec"
      );
    }
  }

  /** Atomic batch: validates current owners, stores variants, materializes vec0, binds owners. */
  write(
    rows: { owner: VectorOwnerInput; embedding?: Float32Array }[]
  ): number[] {
    this.assertWritable();
    return this.db
      .transaction(() =>
        rows.map(({ owner, embedding }) => {
          this.validate(owner);
          if (
            embedding &&
            (embedding.length !== this.identity.dimensions ||
              !embedding.every(Number.isFinite))
          )
            throw new Error("Invalid vector dimensions or values");
          let row = this.variant(owner);
          if (!row) {
            if (!embedding)
              throw new Error("Exact input variant needs embedding");
            this.db.run(
              `INSERT INTO vector_variants(partition_id, input_hash, embedding)
          VALUES (?, ?, ?)`,
              [this.partitionId, owner.inputHash, encodeEmbedding(embedding)]
            );
            row = this.variant(owner)!;
          }
          if (this.searchAvailable) {
            this.db.run(`DELETE FROM ${this.tableName} WHERE variant_id = ?`, [
              row.variant_id,
            ]);
            this.db.run(
              `INSERT INTO ${this.tableName}(variant_id, embedding) VALUES (?, ?)`,
              [row.variant_id, row.embedding]
            );
          }
          this.db.run(
            `INSERT INTO vector_owners(document_id, mirror_hash, seq, partition_id, variant_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, seq, partition_id) DO UPDATE SET
        mirror_hash = excluded.mirror_hash, variant_id = excluded.variant_id`,
            [
              owner.documentId,
              owner.mirrorHash,
              owner.seq,
              this.partitionId,
              row.variant_id,
            ]
          );
          return row.variant_id;
        })
      )
      .immediate();
  }

  /** Resolve only correct current active owners, never every document sharing a mirror. */
  owners(variantId: number): VectorOwnerInput[] {
    const variant = this.db
      .query<VariantRow, [string, number]>(`
      SELECT variant_id, input_hash, embedding FROM vector_variants
      WHERE partition_id = ? AND variant_id = ?
    `)
      .get(this.partitionId, variantId);
    if (!variant) return [];
    const rows = this.db
      .query<
        { document_id: number; seq: number; mirror_hash: string },
        [string, number]
      >(`
      SELECT document_id, seq, mirror_hash FROM vector_owners WHERE partition_id = ? AND variant_id = ?
    `)
      .all(this.partitionId, variantId);
    return rows.flatMap((row) => {
      const current = this.current(row.document_id, row.seq);
      return current &&
        current.mirrorHash === row.mirror_hash &&
        current.inputHash === variant.input_hash
        ? [current]
        : [];
    });
  }

  /** Resumable owner cursor; repeat from start after epoch changes or a completed pass. */
  pending(
    options: {
      limit?: number;
      after?: { documentId: number; seq: number };
    } = {}
  ): VectorOwnerInput[] {
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid pending limit");
    const statement = this.db.prepare<OwnerRow, [number, number, number]>(`
      SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, c.seq, c.text, d.title
      FROM documents d JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      WHERE d.active = 1 AND (d.id > ? OR (d.id = ? AND c.seq > ?)) ORDER BY d.id, c.seq
    `);
    const rows = statement.iterate(
      options.after?.documentId ?? -1,
      options.after?.documentId ?? -1,
      options.after?.seq ?? -1
    );
    const pending: VectorOwnerInput[] = [];
    try {
      for (const row of rows) {
        const input = this.input(row);
        const binding = this.db
          .query<
            { input_hash: string; mirror_hash: string },
            [number, number, string]
          >(`
        SELECT v.input_hash, o.mirror_hash FROM vector_owners o
        JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
        WHERE o.document_id = ? AND o.seq = ? AND o.partition_id = ?
      `)
          .get(input.documentId, input.seq, this.partitionId);
        if (
          binding?.input_hash !== input.inputHash ||
          binding.mirror_hash !== input.mirrorHash
        )
          pending.push(input);
        if (pending.length === limit) break;
      }
    } finally {
      // Early cursor exit must not leave a cached Bun statement mid-iteration.
      statement.finalize();
    }
    return pending;
  }

  /** Activation is fenced by a caller-observed epoch and complete current coverage. */
  activate(expectedEpoch: number): void {
    this.db
      .transaction(() => {
        if (this.epoch() !== expectedEpoch)
          throw new Error("Variant mutation epoch changed");
        if (this.pending({ limit: 1 }).length)
          throw new Error("Variant coverage incomplete");
        if (!this.searchAvailable) throw new Error("Variant index unavailable");
        const mismatch = this.db
          .query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM vector_variants v LEFT JOIN ${this.tableName} x
        ON x.variant_id = v.variant_id WHERE v.partition_id = ?
          AND (x.variant_id IS NULL OR x.embedding != v.embedding)
      `)
          .get(this.partitionId)!.count;
        const orphans = this.db
          .query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM ${this.tableName} x WHERE NOT EXISTS
        (SELECT 1 FROM vector_variants v WHERE v.variant_id = x.variant_id AND v.partition_id = ?)
      `)
          .get(this.partitionId)!.count;
        if (mismatch || orphans) throw new Error("Variant index inconsistent");
        this.db.run(
          `UPDATE vector_partitions SET state = 'active', activated_epoch = ? WHERE partition_id = ?`,
          [expectedEpoch, this.partitionId]
        );
      })
      .immediate();
  }

  /**
   * Durable authority after initial promotion, independent of later mutations.
   * Retrieval uses this marker plus current owner validation; an incomplete
   * epoch must never force valid owners back to legacy vectors. Availability
   * remains a separate capability, not permission to change authority.
   */
  hasActivated(): boolean {
    return !!this.db
      .query<{ active: number }, [string]>(`
      SELECT 1 AS active FROM vector_partitions WHERE partition_id = ?
        AND state = 'active' AND activated_epoch IS NOT NULL
    `)
      .get(this.partitionId);
  }

  /** Current-epoch completeness receipt only; never a blanket retrieval gate. */
  isActive(): boolean {
    if (!this.searchAvailable) return false;
    return !!this.db
      .query<{ active: number }, [string]>(`
      SELECT 1 AS active FROM vector_partitions WHERE partition_id = ?
        AND state = 'active' AND activated_epoch = (SELECT epoch FROM vector_variant_epoch WHERE id = 1)
    `)
      .get(this.partitionId);
  }

  /** Repair materialization after storage-only backfill; never changes legacy authority. */
  syncIndex(): void {
    if (!this.searchAvailable) throw new Error("Variant index unavailable");
    this.db
      .transaction(() => {
        this.db.exec(`DELETE FROM ${this.tableName}`);
        const rows = this.db
          .query<VariantRow, [string]>(
            "SELECT variant_id, input_hash, embedding FROM vector_variants WHERE partition_id = ?"
          )
          .iterate(this.partitionId);
        for (const row of rows) {
          this.db.run(
            `INSERT INTO ${this.tableName}(variant_id, embedding) VALUES (?, ?)`,
            [row.variant_id, row.embedding]
          );
        }
      })
      .immediate();
  }

  /** Explicit owner release and last-valid-owner GC share the vec0 transaction. */
  release(documentId: number): void {
    this.assertWritable();
    this.db
      .transaction(() => {
        this.db.run(
          "DELETE FROM vector_owners WHERE document_id = ? AND partition_id = ?",
          [documentId, this.partitionId]
        );
        this.collectGarbage();
      })
      .immediate();
  }

  collectGarbage(): number {
    this.assertWritable();
    return this.db
      .transaction(() => {
        let removed = 0;
        const rows = this.db
          .query<{ variant_id: number }, [string]>(
            "SELECT variant_id FROM vector_variants WHERE partition_id = ?"
          )
          .all(this.partitionId);
        for (const { variant_id: id } of rows) {
          if (this.owners(id).length) continue;
          if (this.searchAvailable)
            this.db.run(`DELETE FROM ${this.tableName} WHERE variant_id = ?`, [
              id,
            ]);
          this.db.run(
            "DELETE FROM vector_owners WHERE partition_id = ? AND variant_id = ?",
            [this.partitionId, id]
          );
          this.db.run(
            "DELETE FROM vector_variants WHERE partition_id = ? AND variant_id = ?",
            [this.partitionId, id]
          );
          removed++;
        }
        return removed;
      })
      .immediate();
  }
}

export async function createVectorVariantStore(
  db: Database,
  identity: VectorVariantIdentity
): Promise<VectorVariantStore> {
  let searchAvailable = false;
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    searchAvailable = true;
  } catch {
    // Storage remains usable offline; activation waits for a materialized index.
  }
  return new VectorVariantStore(db, identity, searchAvailable);
}
