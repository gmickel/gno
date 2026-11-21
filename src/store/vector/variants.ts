/** Exact-input storage. Synchronous methods throw and compose with DB transactions. */
import type { Database } from "bun:sqlite";

import type { VectorOwnerInput, VectorVariantIdentity } from "./types";

import { formatDocForEmbedding } from "../../pipeline/contextual";
import { markMirrorClean } from "./partition-index";
import { provenOwners, vectorProofKey } from "./proof-cache";
import { decodeEmbedding } from "./sqlite-vec";

export const SELECTED_VECTOR_PARTITION_PREFIX = "vector_selected_partition:";

/**
 * Index hint for collection-scoped scans of `documents`. With statistics
 * from ANALYZE, SQLite can prefer a full scan of documents for a small
 * collection; the collection index keeps the scan proportional to the
 * collection. Empty when unscoped or when the index does not exist.
 */
export function collectionScanHint(
  db: Database,
  collection: string | undefined
): string {
  if (!collection) return "";
  return db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get("idx_documents_collection")
    ? " INDEXED BY idx_documents_collection"
    : "";
}

/**
 * Index hint that makes `content_chunks` a key lookup by mirror. Statistics
 * gathered while the table held a row or two make a scan look cheaper, and
 * the scan then runs once per selected document over every collection's
 * chunks. The primary key index serves both the mirror lookup and the
 * `(mirror_hash, seq)` cursor range.
 */
export function chunkKeyHint(db: Database): string {
  const pk = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_index_list('content_chunks') WHERE origin = 'pk'"
    )
    .get();
  return pk ? ` INDEXED BY "${pk.name.replaceAll('"', '""')}"` : "";
}

/** Covering index hint for document-driven `vector_owners` lookups (migration 037). */
export function ownerDocPartHint(db: Database): string {
  if (
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_vector_owners_doc_part")
  ) {
    return " INDEXED BY idx_vector_owners_doc_part";
  }
  return "";
}

/**
 * Document-keyed index hint for `vector_owners`: prefers migration 037's
 * covering index, else falls back to the primary key index so stale stats
 * never trigger a table scan or Bloom filter.
 */
function ownerDocOrPkHint(db: Database): string {
  const covering = ownerDocPartHint(db);
  if (covering) return covering;
  const pk = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_index_list('vector_owners') WHERE origin = 'pk'"
    )
    .get();
  return pk ? ` INDEXED BY "${pk.name.replaceAll('"', '""')}"` : "";
}

/** Covering index hint for partition-driven `vector_owners` scans (migration 037). */
export function ownerPartitionVariantHint(db: Database): string {
  return db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get("idx_vector_owners_partition_variant")
    ? " INDEXED BY idx_vector_owners_partition_variant"
    : "";
}

/** Unique `(partition_id, variant_id)` index hint on `vector_variants`. */
export function variantPartitionIdHint(db: Database): string {
  const indexes = db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_index_list('vector_variants')"
    )
    .all();
  for (const { name } of indexes) {
    const cols = db
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_index_info('${name.replaceAll("'", "''")}') ORDER BY seqno`
      )
      .all()
      .map((row) => row.name);
    if (
      cols.length === 2 &&
      cols[0] === "partition_id" &&
      cols[1] === "variant_id"
    ) {
      return ` INDEXED BY "${name.replaceAll('"', '""')}"`;
    }
  }
  return "";
}

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
      ...(identity.fork ? [identity.fork] : []),
    ])
  );
}

export function vectorPartitionId(
  model: string,
  fingerprint: string,
  dimensions: number
): string {
  return embeddingInputHash(JSON.stringify([model, fingerprint, dimensions]));
}

/** Storage stays usable without sqlite-vec; search and activation need it. */
export async function loadSqliteVec(db: Database): Promise<boolean> {
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

interface OwnerRow {
  documentId: number;
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
}

interface CandidateRow extends OwnerRow {
  boundHash: string | null;
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
    readonly searchAvailable: boolean,
    /** Readable label of the runtime that creates the partition. */
    provenance?: string
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
    this.partitionId = vectorPartitionId(
      identity.model,
      this.fingerprint,
      identity.dimensions
    );
    this.tableName = `vec_v1_${this.partitionId}`;
    db.transaction(() => {
      db.run(
        `INSERT OR IGNORE INTO vector_partitions
        (partition_id, version, model, fingerprint, dimensions, provenance,
          base_fingerprint, fork)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
        [
          this.partitionId,
          identity.model,
          this.fingerprint,
          identity.dimensions,
          provenance ?? null,
          vectorVariantFingerprint({ ...identity, fork: undefined }),
          identity.fork ?? null,
        ]
      );
      if (searchAvailable) {
        if (
          !db
            .query("SELECT 1 FROM sqlite_master WHERE name = ?")
            .get(this.tableName)
        ) {
          db.run(
            "UPDATE vector_variant_epoch SET epoch = epoch + 1 WHERE id = 1"
          );
          // A new, empty mirror is stale for any variants already stored.
          this.setMirrorMark(1);
        }
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
          variant_id INTEGER PRIMARY KEY,
          embedding FLOAT[${identity.dimensions}] distance_metric=cosine
        )`);
      }
    }).immediate();
  }

  /** Persist only after embedding has resolved the actual runtime identity. */
  selectForEmbedding(): void {
    this.db.run(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [SELECTED_VECTOR_PARTITION_PREFIX + this.identity.model, this.partitionId]
    );
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
      .transaction(() => this.keepingMirrorMark(() => this.writeRows(rows)))
      .immediate();
  }

  private writeRows(
    rows: { owner: VectorOwnerInput; embedding?: Float32Array }[]
  ): number[] {
    if (rows.length === 0) return [];
    for (const { embedding } of rows) {
      if (
        embedding &&
        (embedding.length !== this.identity.dimensions ||
          !embedding.every(Number.isFinite))
      ) {
        throw new Error("Invalid vector dimensions or values");
      }
    }

    // Batch-validate all owners in one SQL query instead of N per-row lookups.
    const uniquePairs = new Map<string, [number, number]>();
    for (const { owner } of rows) {
      const key = `${owner.documentId}:${owner.seq}`;
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, [owner.documentId, owner.seq]);
      }
    }
    const fetchedOwners = this.db
      .query<OwnerRow, [string]>(`
        WITH req AS (
          SELECT
            json_extract(value, '$[0]') AS document_id,
            json_extract(value, '$[1]') AS seq
          FROM json_each(?)
        )
        SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, c.seq, c.text, d.title
        FROM req r
        JOIN documents d ON d.id = r.document_id AND d.active = 1
        JOIN content_chunks c ON c.mirror_hash = d.mirror_hash AND c.seq = r.seq
      `)
      .all(JSON.stringify([...uniquePairs.values()]));
    const currentByKey = new Map<string, VectorOwnerInput>();
    for (const row of fetchedOwners) {
      currentByKey.set(`${row.documentId}:${row.seq}`, this.input(row));
    }
    for (const { owner } of rows) {
      const current = currentByKey.get(`${owner.documentId}:${owner.seq}`);
      if (
        !current ||
        current.mirrorHash !== owner.mirrorHash ||
        current.formattedInput !== owner.formattedInput ||
        current.inputHash !== owner.inputHash
      ) {
        throw new Error("Stale or invalid vector owner input");
      }
    }

    const selectVariant = this.db.query<
      { variant_id: number; embedding: Uint8Array },
      [string, string]
    >(
      "SELECT variant_id, embedding FROM vector_variants WHERE partition_id = ? AND input_hash = ?"
    );
    const insertVariant = this.db.query<
      { variant_id: number },
      [string, string, Uint8Array]
    >(
      "INSERT INTO vector_variants(partition_id, input_hash, embedding) VALUES (?, ?, ?) RETURNING variant_id"
    );
    const updateVariant = this.db.query<unknown, [Uint8Array, number, string]>(
      "UPDATE vector_variants SET embedding = ? WHERE variant_id = ? AND partition_id = ?"
    );
    const deleteVec = this.searchAvailable
      ? this.db.query<unknown, [number]>(
          `DELETE FROM ${this.tableName} WHERE variant_id = ?`
        )
      : null;
    const insertVec = this.searchAvailable
      ? this.db.query<unknown, [number, Uint8Array]>(
          `INSERT INTO ${this.tableName}(variant_id, embedding) VALUES (?, ?)`
        )
      : null;
    const upsertOwner = this.db.query<
      unknown,
      [number, string, number, string, number]
    >(
      `INSERT INTO vector_owners(document_id, mirror_hash, seq, partition_id, variant_id)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, seq, partition_id) DO UPDATE SET
       mirror_hash = excluded.mirror_hash, variant_id = excluded.variant_id`
    );

    const variantIds: number[] = [];
    for (const { owner, embedding } of rows) {
      const existing = selectVariant.get(this.partitionId, owner.inputHash);
      let variantId: number;
      if (!existing) {
        if (!embedding) throw new Error("Exact input variant needs embedding");
        const blob = new Uint8Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength
        );
        variantId = insertVariant.get(
          this.partitionId,
          owner.inputHash,
          blob
        )!.variant_id;
        if (insertVec) {
          try {
            insertVec.run(variantId, blob);
          } catch (cause) {
            // A dirty vec0 mirror can retain an orphan row for a reused
            // SQLite rowid after deletion; replace only on collision.
            if (
              deleteVec &&
              cause instanceof Error &&
              cause.message.includes("UNIQUE")
            ) {
              deleteVec.run(variantId);
              insertVec.run(variantId, blob);
            } else {
              throw cause;
            }
          }
        }
      } else if (embedding) {
        variantId = existing.variant_id;
        const blob = new Uint8Array(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength
        );
        updateVariant.run(blob, variantId, this.partitionId);
        if (deleteVec && insertVec) {
          deleteVec.run(variantId);
          insertVec.run(variantId, blob);
        }
      } else {
        variantId = existing.variant_id;
        if (deleteVec && insertVec) {
          deleteVec.run(variantId);
          insertVec.run(variantId, existing.embedding);
        }
      }
      upsertOwner.run(
        owner.documentId,
        owner.mirrorHash,
        owner.seq,
        this.partitionId,
        variantId
      );
      variantIds.push(variantId);
    }
    return variantIds;
  }

  /** Resolve only correct current active owners, never every document sharing a mirror. */
  owners(variantId: number): VectorOwnerInput[] {
    const variant = this.db
      .query<{ input_hash: string }, [string, number]>(
        "SELECT input_hash FROM vector_variants WHERE partition_id = ? AND variant_id = ?"
      )
      .get(this.partitionId, variantId);
    if (!variant) return [];
    const rows = this.db
      .query<OwnerRow, [string, number]>(`
        SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, c.seq, c.text, d.title
        FROM vector_owners o
        JOIN documents d ON d.id = o.document_id AND d.active = 1
          AND d.mirror_hash = o.mirror_hash
        JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
        WHERE o.partition_id = ? AND o.variant_id = ?
      `)
      .all(this.partitionId, variantId);
    const matched: VectorOwnerInput[] = [];
    for (const row of rows) {
      const current = this.input(row);
      if (current.inputHash === variant.input_hash) {
        matched.push(current);
      }
    }
    return matched;
  }

  /**
   * Active chunk rows with this partition's binding, optionally limited to
   * one collection, as columns `documentId, mirrorHash, title, seq, text,
   * boundHash` that `columns` and `where` refer to. The collection predicate
   * is added only when requested: activation and unscoped passes need the
   * whole index, and some callers' schemas have no collection column.
   */
  private candidates(
    collection: string | undefined,
    columns: string,
    where = ""
  ): { sql: string; params: (string | number)[] } {
    return {
      // CROSS JOIN keeps documents as the outer loop and the index hints keep
      // every join a key/covering-index lookup even with stale statistics.
      // A single correlated subquery joining vector_owners and vector_variants
      // checks mirror_hash in the covering index and prevents SQLite from
      // building a whole-table Bloom filter on LEFT JOIN under stale stats.
      sql: `SELECT ${columns} FROM (
        SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, d.title AS title,
          c.seq AS seq, c.text AS text,
          (SELECT v.input_hash
            FROM vector_owners o${ownerDocOrPkHint(this.db)}
            CROSS JOIN vector_variants v${variantPartitionIdHint(this.db)}
              ON v.partition_id = o.partition_id AND v.variant_id = o.variant_id
            WHERE o.document_id = d.id AND o.seq = c.seq
              AND o.partition_id = ? AND o.mirror_hash = d.mirror_hash
          ) AS boundHash
        FROM documents d${collectionScanHint(this.db, collection)}
        CROSS JOIN content_chunks c${chunkKeyHint(this.db)} ON c.mirror_hash = d.mirror_hash
        WHERE d.active = 1${collection ? " AND d.collection = ?" : ""}
      ) WHERE 1${where}`,
      params: [this.partitionId, ...(collection ? [collection] : [])],
    };
  }

  /** Rows with no current binding: pending without formatting or hashing. */
  private static readonly UNBOUND = " AND boundHash IS NULL";
  /** Rows whose binding matches the mirror: only the input hash can differ. */
  private static readonly BOUND = " AND boundHash IS NOT NULL";

  /** Bound rows whose current input no longer matches their variant (title or format change). */
  private *staleBound(
    collection: string | undefined,
    proofs: Map<string, boolean>
  ): Generator<true> {
    const { sql, params } = this.candidates(
      collection,
      "documentId, mirrorHash, seq, text, title, boundHash",
      VectorVariantStore.BOUND
    );
    const statement = this.db.prepare<
      OwnerRow & { boundHash: string },
      (string | number)[]
    >(sql);
    try {
      for (const row of statement.iterate(...params)) {
        const key = vectorProofKey(
          this.identity.model,
          row.documentId,
          row.mirrorHash,
          row.seq,
          row.boundHash
        );
        let valid = proofs.get(key);
        if (valid === undefined) {
          valid = this.input(row).inputHash === row.boundHash;
          proofs.set(key, valid);
        }
        if (!valid) yield true;
      }
    } finally {
      // Early exit must not leave a cached Bun statement mid-iteration.
      statement.finalize();
    }
  }

  /**
   * Number of owners pending() would return across a complete pass. Unbound
   * rows are counted in SQL; only bound rows are formatted and hashed. Both
   * reads share one snapshot so a concurrent writer cannot hide a row.
   */
  countPending(options: { collection?: string } = {}): number {
    const collection = options.collection || undefined;
    const inOuterTx = this.db.inTransaction;
    const { sql, params } = this.candidates(
      collection,
      "count(*) AS n",
      VectorVariantStore.UNBOUND
    );
    return this.db
      .transaction(() => {
        const proofs = provenOwners(this.db, inOuterTx);
        let count = this.db
          .query<{ n: number }, (string | number)[]>(sql)
          .get(...params)!.n;
        for (const _ of this.staleBound(collection, proofs)) count += 1;
        return count;
      })
      .deferred();
  }

  /**
   * Active chunk rows with their binding in `(document id, seq)` order,
   * resuming after `after`. The cursor document's remaining chunks and the
   * later documents are two statements, so each is a range on its index
   * (`content_chunks` primary key, then the collection index or rowid) and a
   * large document is never rescanned from its first chunk.
   */
  private *ownerRows(
    collection: string | undefined,
    after: { documentId: number; seq: number } | undefined
  ): Generator<CandidateRow> {
    const columns = "documentId, mirrorHash, seq, text, title, boundHash";
    const parts = after
      ? [
          {
            where: " AND documentId = ? AND seq > ? ORDER BY seq",
            params: [after.documentId, after.seq],
          },
          {
            where: " AND documentId > ? ORDER BY documentId, seq",
            params: [after.documentId],
          },
        ]
      : [{ where: " ORDER BY documentId, seq", params: [] as number[] }];
    for (const part of parts) {
      const { sql, params } = this.candidates(collection, columns, part.where);
      const statement = this.db.prepare<CandidateRow, (string | number)[]>(sql);
      try {
        yield* statement.iterate(...params, ...part.params);
      } finally {
        // Early exit must not leave a cached Bun statement mid-iteration.
        statement.finalize();
      }
    }
  }

  /**
   * Runs reads in one deferred transaction: every statement sees the same
   * snapshot, so a write committed between the two cursor statements cannot
   * make a page look like the end of the backlog.
   */
  private snapshot<T>(read: () => T): T {
    return this.db.transaction(read).deferred();
  }

  /** The row needs embedding: no current binding, or its input changed. */
  private isPending(
    row: CandidateRow,
    proofs?: Map<string, boolean>,
    input?: VectorOwnerInput
  ): boolean {
    if (row.boundHash === null) return true;
    const key = vectorProofKey(
      this.identity.model,
      row.documentId,
      row.mirrorHash,
      row.seq,
      row.boundHash
    );
    const cached = proofs?.get(key);
    if (cached !== undefined) return !cached;
    const valid = (input ?? this.input(row)).inputHash === row.boundHash;
    proofs?.set(key, valid);
    return !valid;
  }

  /**
   * Same answer as `pending({ limit: 1 }).length > 0`. Walks owners in order
   * and stops at the first pending one; unbound rows are not hashed.
   */
  hasPending(options: { collection?: string } = {}): boolean {
    const inOuterTx = this.db.inTransaction;
    return this.snapshot(() => {
      const proofs = provenOwners(this.db, inOuterTx);
      for (const row of this.ownerRows(
        options.collection || undefined,
        undefined
      ))
        if (this.isPending(row, proofs)) return true;
      return false;
    });
  }

  /** Resumable owner cursor; repeat from start after epoch changes or a completed pass. */
  pending(
    options: {
      limit?: number;
      after?: { documentId: number; seq: number };
      /** Only owners of active documents in this collection. */
      collection?: string;
    } = {}
  ): VectorOwnerInput[] {
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid pending limit");
    const inOuterTx = this.db.inTransaction;
    return this.snapshot(() => {
      const proofs = provenOwners(this.db, inOuterTx);
      const pending: VectorOwnerInput[] = [];
      for (const row of this.ownerRows(
        options.collection || undefined,
        options.after
      )) {
        if (row.boundHash !== null) {
          const key = vectorProofKey(
            this.identity.model,
            row.documentId,
            row.mirrorHash,
            row.seq,
            row.boundHash
          );
          if (proofs.get(key) === true) continue;
        }
        const input = this.input(row);
        if (this.isPending(row, proofs, input)) pending.push(input);
        if (pending.length === limit) break;
      }
      return pending;
    });
  }

  /**
   * Every current owner input in order (a forced pass), read with its IDs in
   * one statement so a concurrent rechunk cannot empty a page.
   */
  currentPage(options: {
    limit: number;
    after?: { documentId: number; seq: number };
    collection?: string;
  }): VectorOwnerInput[] {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1)
      throw new Error("Invalid page limit");
    return this.snapshot(() => {
      const page: VectorOwnerInput[] = [];
      for (const row of this.ownerRows(
        options.collection || undefined,
        options.after
      )) {
        page.push(this.input(row));
        if (page.length === options.limit) break;
      }
      return page;
    });
  }

  /** Activation is fenced by a caller-observed epoch and complete current coverage. */
  activate(expectedEpoch: number): void {
    this.db
      .transaction(() => {
        if (this.epoch() !== expectedEpoch)
          throw new Error("Variant mutation epoch changed");
        if (this.hasPending()) throw new Error("Variant coverage incomplete");
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
        // The mirror was just verified against every stored variant.
        this.setMirrorMark(0);
        this.db.run(
          `UPDATE vector_partitions SET state = 'active', activated_epoch = ? WHERE partition_id = ?`,
          [expectedEpoch, this.partitionId]
        );
        // A complete runtime-independent partition supersedes the pre-fn-184
        // partitions of its vector space, as the one-time re-key does.
        if (!this.identity.fork)
          this.db.run(
            `UPDATE vector_partitions SET state = 'shadow', activated_epoch = NULL
            WHERE legacy = 1 AND model = ? AND dimensions = ?`,
            [this.identity.model, this.identity.dimensions]
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

  /** Whether this database tracks vec0 mirror freshness (migration 036). */
  private mirrorTracked(): boolean {
    return !!this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("vector_mirror_state");
  }

  /** The partition's mark: 0 clean; 1 or null (no row) dirty. */
  private mirrorMark(): number | null {
    return (
      this.db
        .query<{ dirty: number }, [string]>(
          "SELECT dirty FROM vector_mirror_state WHERE partition_id = ?"
        )
        .get(this.partitionId)?.dirty ?? null
    );
  }

  private setMirrorMark(mark: number | null): void {
    if (!this.mirrorTracked()) return;
    if (mark !== 0)
      this.db.run("DELETE FROM vector_mirror_state WHERE partition_id = ?", [
        this.partitionId,
      ]);
    else markMirrorClean(this.db, this.partitionId);
  }

  /**
   * Runs a store write that keeps vec0 in step. The vector_variants triggers
   * mark the partition dirty on every change; when this write also updated
   * vec0, the mark it found is restored, so only changes made outside the
   * store leave the mirror marked stale.
   */
  private keepingMirrorMark<T>(write: () => T): T {
    if (!this.searchAvailable || !this.mirrorTracked()) return write();
    const before = this.mirrorMark();
    const result = write();
    this.setMirrorMark(before);
    return result;
  }

  /**
   * vec0 mirror freshness for an activated partition: `clean` when no change
   * to stored vectors happened outside the store since the last verified
   * sync or activation, `dirty` otherwise (including never recorded), and
   * `untracked` on databases without migration 036 or without sqlite-vec.
   */
  mirrorState(): "clean" | "dirty" | "untracked" {
    if (!this.searchAvailable || !this.mirrorTracked()) return "untracked";
    // vec0 is a virtual table without triggers, so rows removed or added
    // there directly are caught by comparing row counts (one count each).
    // The mark and both counts are read in one snapshot.
    return this.snapshot(() => {
      if (this.mirrorMark() !== 0) return "dirty";
      const stored = this.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM vector_variants WHERE partition_id = ?"
        )
        .get(this.partitionId)!.n;
      const mirrored = this.db
        .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${this.tableName}`)
        .get()!.n;
      return stored === mirrored ? "clean" : "dirty";
    });
  }

  /** Repair materialization after storage-only backfill; never changes legacy authority. */
  syncIndex(): void {
    if (!this.searchAvailable) throw new Error("Variant index unavailable");
    this.db
      .transaction(() => {
        this.db.exec(`DELETE FROM ${this.tableName}`);
        this.db
          .query(
            `INSERT INTO ${this.tableName}(variant_id, embedding)
             SELECT variant_id, embedding FROM vector_variants WHERE partition_id = ?`
          )
          .run(this.partitionId);
        this.setMirrorMark(0);
      })
      .immediate();
  }

  /** Explicit owner release and last-valid-owner GC share the vec0 transaction. */
  release(documentId: number): void {
    this.assertWritable();
    this.db
      .transaction(() =>
        this.keepingMirrorMark(() => {
          this.db
            .query(
              "DELETE FROM vector_owners WHERE document_id = ? AND partition_id = ?"
            )
            .run(documentId, this.partitionId);
          this.removeUnowned(true);
        })
      )
      .immediate();
  }

  collectGarbage(): number {
    this.assertWritable();
    const inOuterTx = this.db.inTransaction;
    return this.db
      .transaction(() =>
        this.keepingMirrorMark(() => this.removeUnowned(inOuterTx))
      )
      .immediate();
  }

  private removeUnowned(inOuterTx: boolean): number {
    // 1. Collect variants with zero active mirror-matching owners in pure SQL
    // without touching any embedding BLOBs.
    const noActiveOwners = this.db
      .query<{ variant_id: number }, [string]>(`
        SELECT v.variant_id
        FROM vector_variants v
        WHERE v.partition_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM vector_owners o
            JOIN documents d ON d.id = o.document_id AND d.active = 1
              AND d.mirror_hash = o.mirror_hash
            JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
            WHERE o.partition_id = v.partition_id AND o.variant_id = v.variant_id
          )
      `)
      .all(this.partitionId);

    const toRemove: number[] = noActiveOwners.map((row) => row.variant_id);

    // 2. Stream remaining candidates ordered by variant_id (never reading
    // v.embedding), consulting the epoch-keyed proof cache and short-circuiting
    // as soon as a variant has one valid owner.
    const proofs = provenOwners(this.db, inOuterTx);
    const candidateStmt = this.db.prepare<
      OwnerRow & { variant_id: number; input_hash: string },
      [string]
    >(`
      SELECT v.variant_id, v.input_hash,
        d.id AS documentId, d.mirror_hash AS mirrorHash,
        c.seq, c.text, d.title
      FROM vector_variants v
      JOIN vector_owners o${ownerPartitionVariantHint(this.db)}
        ON o.partition_id = v.partition_id AND o.variant_id = v.variant_id
      JOIN documents d ON d.id = o.document_id AND d.active = 1
        AND d.mirror_hash = o.mirror_hash
      JOIN content_chunks c${chunkKeyHint(this.db)}
        ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
      WHERE v.partition_id = ?
      ORDER BY v.variant_id
    `);
    try {
      let currentVariantId: number | null = null;
      let hasValidOwner = false;
      for (const row of candidateStmt.iterate(this.partitionId)) {
        if (row.variant_id !== currentVariantId) {
          if (currentVariantId !== null && !hasValidOwner) {
            toRemove.push(currentVariantId);
          }
          currentVariantId = row.variant_id;
          hasValidOwner = false;
        }
        if (hasValidOwner) continue;
        const key = vectorProofKey(
          this.identity.model,
          row.documentId,
          row.mirrorHash,
          row.seq,
          row.input_hash
        );
        let valid = proofs.get(key);
        if (valid === undefined) {
          valid = this.input(row).inputHash === row.input_hash;
          proofs.set(key, valid);
        }
        if (valid) {
          hasValidOwner = true;
        }
      }
      if (currentVariantId !== null && !hasValidOwner) {
        toRemove.push(currentVariantId);
      }
    } finally {
      candidateStmt.finalize();
    }

    if (toRemove.length === 0) return 0;

    const removeJson = JSON.stringify(toRemove);
    if (this.searchAvailable) {
      this.db
        .query(
          `DELETE FROM ${this.tableName} WHERE variant_id IN (SELECT value FROM json_each(?))`
        )
        .run(removeJson);
    }
    this.db
      .query(
        "DELETE FROM vector_owners WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))"
      )
      .run(this.partitionId, removeJson);
    this.db
      .query(
        "DELETE FROM vector_variants WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))"
      )
      .run(this.partitionId, removeJson);
    return toRemove.length;
  }
}

export async function createVectorVariantStore(
  db: Database,
  identity: VectorVariantIdentity,
  provenance?: string
): Promise<VectorVariantStore> {
  return new VectorVariantStore(
    db,
    identity,
    await loadSqliteVec(db),
    provenance
  );
}
