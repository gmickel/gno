/**
 * SQLite implementation of StorePort.
 * Uses bun:sqlite for database operations.
 *
 * Note: bun:sqlite is synchronous but we use async for interface consistency.
 *
 * @module src/store/sqlite/adapter
 */

// CRITICAL: Import setup FIRST to configure custom SQLite before any Database use
import "./setup";
import { Database } from "bun:sqlite";

import type { Collection, Context, FtsTokenizer } from "../../config/types";
import type {
  ChunkInput,
  ChunkRow,
  CleanupStats,
  CollectionRow,
  ContextRow,
  DocumentInput,
  DocumentRow,
  FtsResult,
  FtsSearchOptions,
  IndexStatus,
  IngestErrorInput,
  IngestErrorRow,
  MigrationResult,
  StorePort,
  StoreResult,
  TagCount,
  TagRow,
  TagSource,
  UpsertDocumentResult,
} from "../types";
import type { SqliteDbProvider } from "./types";

import { buildUri, deriveDocid } from "../../app/constants";
import { migrations, runMigrations } from "../migrations";
import { err, ok } from "../types";
import { loadFts5Snowball } from "./fts5-snowball";

// ─────────────────────────────────────────────────────────────────────────────
// FTS5 Query Escaping
// ─────────────────────────────────────────────────────────────────────────────

/** Whitespace regex for splitting FTS5 tokens */
const WHITESPACE_REGEX = /\s+/;

/**
 * Escape a query string for safe FTS5 MATCH.
 * Wraps each token in double quotes to treat as literal terms.
 * Handles special chars: ? * - + ( ) " : ^ etc.
 */
function escapeFts5Query(query: string): string {
  // Split on whitespace, filter empty, quote each token
  return query
    .split(WHITESPACE_REGEX)
    .filter((t) => t.length > 0)
    .map((token) => {
      // Escape internal double quotes by doubling them
      const escaped = token.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Regex to strip .sqlite extension from db path */
const SQLITE_EXT_REGEX = /\.sqlite$/;

/** Regex to strip index- prefix from db name */
const INDEX_PREFIX_REGEX = /^index-/;

export class SqliteAdapter implements StorePort, SqliteDbProvider {
  private db: Database | null = null;
  private dbPath = "";
  private ftsTokenizer: FtsTokenizer = "unicode61";
  private configPath = ""; // Set by CLI layer for status output
  private txDepth = 0; // Transaction nesting depth
  private txCounter = 0; // Savepoint counter for unique names

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async open(
    dbPath: string,
    ftsTokenizer: FtsTokenizer
  ): Promise<StoreResult<MigrationResult>> {
    try {
      this.db = new Database(dbPath, { create: true });
      this.dbPath = dbPath;
      this.ftsTokenizer = ftsTokenizer;

      // Enable pragmas for performance and safety
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");

      // CI mode: trade durability for speed (no fsync, memory journal)
      // Safe for tests since we don't need crash recovery
      if (process.env.CI) {
        this.db.exec("PRAGMA journal_mode = MEMORY");
        this.db.exec("PRAGMA synchronous = OFF");
        this.db.exec("PRAGMA temp_store = MEMORY");
      } else {
        this.db.exec("PRAGMA journal_mode = WAL");
      }

      // Load fts5-snowball extension if using snowball tokenizer
      if (ftsTokenizer.startsWith("snowball")) {
        const snowballResult = loadFts5Snowball(this.db);
        if (!snowballResult.loaded) {
          this.db.close();
          this.db = null;
          return err(
            "EXTENSION_LOAD_FAILED",
            `Failed to load fts5-snowball: ${snowballResult.error}`
          );
        }
      }

      // Run migrations
      const result = runMigrations(this.db, migrations, ftsTokenizer);
      if (!result.ok) {
        this.db.close();
        this.db = null;
        return result;
      }

      return result;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Failed to open database";
      return err("CONNECTION_FAILED", message, cause);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Run an async function within a single SQLite transaction.
   * Uses SAVEPOINT for nesting safety.
   *
   * Note: bun:sqlite's Database#transaction is synchronous, so we use
   * explicit BEGIN/COMMIT to support async callbacks.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<StoreResult<T>> {
    const db = this.ensureOpen();

    const isOuter = this.txDepth === 0;
    const savepoint = `sp_${++this.txCounter}`;

    try {
      if (isOuter) {
        // IMMEDIATE reduces lock churn for bulk writes
        db.exec("BEGIN IMMEDIATE");
      } else {
        db.exec(`SAVEPOINT ${savepoint}`);
      }

      this.txDepth += 1;
      const value = await fn();
      this.txDepth -= 1;

      if (isOuter) {
        db.exec("COMMIT");
      } else {
        db.exec(`RELEASE ${savepoint}`);
      }

      return ok(value);
    } catch (cause) {
      this.txDepth = Math.max(0, this.txDepth - 1);

      try {
        if (isOuter) {
          db.exec("ROLLBACK");
        } else {
          db.exec(`ROLLBACK TO ${savepoint}`);
          db.exec(`RELEASE ${savepoint}`);
        }
      } catch {
        // Ignore rollback failures; report original error
      }

      const message =
        cause instanceof Error ? cause.message : "Transaction failed";
      return err("TRANSACTION_FAILED", message, cause);
    }
  }

  /**
   * Set config path for status output (called by CLI layer).
   */
  setConfigPath(configPath: string): void {
    this.configPath = configPath;
  }

  /**
   * Get raw SQLite database handle for vector operations.
   * Part of SqliteDbProvider interface - use with isSqliteDbProvider() type guard.
   */
  getRawDb(): Database {
    return this.ensureOpen();
  }

  private ensureOpen(): Database {
    if (!this.db) {
      throw new Error("Database not open");
    }
    return this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Config Sync
  // ─────────────────────────────────────────────────────────────────────────

  async syncCollections(collections: Collection[]): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Get existing collection names
        const existing = new Set(
          db
            .query<{ name: string }, []>("SELECT name FROM collections")
            .all()
            .map((r) => r.name)
        );

        const incoming = new Set(collections.map((c) => c.name));

        // Delete removed collections
        for (const name of existing) {
          if (!incoming.has(name)) {
            db.run("DELETE FROM collections WHERE name = ?", [name]);
          }
        }

        // Upsert collections
        const stmt = db.prepare(`
          INSERT INTO collections (name, path, pattern, include, exclude, update_cmd, language_hint, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(name) DO UPDATE SET
            path = excluded.path,
            pattern = excluded.pattern,
            include = excluded.include,
            exclude = excluded.exclude,
            update_cmd = excluded.update_cmd,
            language_hint = excluded.language_hint,
            synced_at = datetime('now')
        `);

        for (const c of collections) {
          stmt.run(
            c.name,
            c.path,
            c.pattern,
            c.include.length > 0 ? JSON.stringify(c.include) : null,
            c.exclude.length > 0 ? JSON.stringify(c.exclude) : null,
            c.updateCmd ?? null,
            c.languageHint ?? null
          );
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to sync collections",
        cause
      );
    }
  }

  async syncContexts(contexts: Context[]): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Delete all and re-insert (contexts are small)
        db.run("DELETE FROM contexts");

        const stmt = db.prepare(`
          INSERT INTO contexts (scope_type, scope_key, text, synced_at)
          VALUES (?, ?, ?, datetime('now'))
        `);

        for (const c of contexts) {
          stmt.run(c.scopeType, c.scopeKey, c.text);
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to sync contexts",
        cause
      );
    }
  }

  async getCollections(): Promise<StoreResult<CollectionRow[]>> {
    try {
      const db = this.ensureOpen();
      const rows = db
        .query<DbCollectionRow, []>("SELECT * FROM collections")
        .all();

      return ok(rows.map(mapCollectionRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get collections",
        cause
      );
    }
  }

  async getContexts(): Promise<StoreResult<ContextRow[]>> {
    try {
      const db = this.ensureOpen();
      const rows = db.query<DbContextRow, []>("SELECT * FROM contexts").all();

      return ok(rows.map(mapContextRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get contexts",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Documents
  // ─────────────────────────────────────────────────────────────────────────

  async upsertDocument(
    doc: DocumentInput
  ): Promise<StoreResult<UpsertDocumentResult>> {
    try {
      const db = this.ensureOpen();
      const docid = deriveDocid(doc.sourceHash);
      const uri = buildUri(doc.collection, doc.relPath);

      db.run(
        `
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, title, mirror_hash,
          converter_id, converter_version, language_hint, active,
          last_error_code, last_error_message, last_error_at, ingest_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(collection, rel_path) DO UPDATE SET
          source_hash = excluded.source_hash,
          source_mime = excluded.source_mime,
          source_ext = excluded.source_ext,
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          docid = excluded.docid,
          uri = excluded.uri,
          title = excluded.title,
          mirror_hash = excluded.mirror_hash,
          converter_id = excluded.converter_id,
          converter_version = excluded.converter_version,
          language_hint = excluded.language_hint,
          active = 1,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message,
          last_error_at = excluded.last_error_at,
          ingest_version = excluded.ingest_version,
          updated_at = datetime('now')
      `,
        [
          doc.collection,
          doc.relPath,
          doc.sourceHash,
          doc.sourceMime,
          doc.sourceExt,
          doc.sourceSize,
          doc.sourceMtime,
          docid,
          uri,
          doc.title ?? null,
          doc.mirrorHash ?? null,
          doc.converterId ?? null,
          doc.converterVersion ?? null,
          doc.languageHint ?? null,
          doc.lastErrorCode ?? null,
          doc.lastErrorMessage ?? null,
          doc.lastErrorCode ? new Date().toISOString() : null,
          doc.ingestVersion ?? null,
        ]
      );

      // Get the row id (either inserted or updated)
      const idRow = db
        .query<{ id: number }, [string, string]>(
          "SELECT id FROM documents WHERE collection = ? AND rel_path = ?"
        )
        .get(doc.collection, doc.relPath);

      if (!idRow) {
        return err("QUERY_FAILED", "Failed to get document id after upsert");
      }

      return ok({ id: idRow.id, docid });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to upsert document",
        cause
      );
    }
  }

  async getDocument(
    collection: string,
    relPath: string
  ): Promise<StoreResult<DocumentRow | null>> {
    try {
      const db = this.ensureOpen();
      const row = db
        .query<DbDocumentRow, [string, string]>(
          "SELECT * FROM documents WHERE collection = ? AND rel_path = ?"
        )
        .get(collection, relPath);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get document",
        cause
      );
    }
  }

  async getDocumentByDocid(
    docid: string
  ): Promise<StoreResult<DocumentRow | null>> {
    try {
      const db = this.ensureOpen();
      const row = db
        .query<DbDocumentRow, [string]>(
          "SELECT * FROM documents WHERE docid = ?"
        )
        .get(docid);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get document by docid",
        cause
      );
    }
  }

  async getDocumentByUri(
    uri: string
  ): Promise<StoreResult<DocumentRow | null>> {
    try {
      const db = this.ensureOpen();
      const row = db
        .query<DbDocumentRow, [string]>("SELECT * FROM documents WHERE uri = ?")
        .get(uri);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get document by uri",
        cause
      );
    }
  }

  async listDocuments(
    collection?: string
  ): Promise<StoreResult<DocumentRow[]>> {
    try {
      const db = this.ensureOpen();

      const rows = collection
        ? db
            .query<DbDocumentRow, [string]>(
              "SELECT * FROM documents WHERE collection = ?"
            )
            .all(collection)
        : db.query<DbDocumentRow, []>("SELECT * FROM documents").all();

      return ok(rows.map(mapDocumentRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to list documents",
        cause
      );
    }
  }

  async listDocumentsPaginated(options: {
    collection?: string;
    limit: number;
    offset: number;
    tagsAll?: string[];
    tagsAny?: string[];
  }): Promise<StoreResult<{ documents: DocumentRow[]; total: number }>> {
    try {
      const db = this.ensureOpen();
      const { collection, limit, offset, tagsAll, tagsAny } = options;

      // Build WHERE conditions and params
      const conditions: string[] = ["d.active = 1"];
      const params: (string | number)[] = [];

      if (collection) {
        conditions.push("d.collection = ?");
        params.push(collection);
      }

      // tagsAny: document has at least one of these tags (OR)
      if (tagsAny && tagsAny.length > 0) {
        const placeholders = tagsAny.map(() => "?").join(",");
        conditions.push(
          `EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag IN (${placeholders}))`
        );
        params.push(...tagsAny);
      }

      // tagsAll: document has all of these tags (AND)
      if (tagsAll && tagsAll.length > 0) {
        for (const tag of tagsAll) {
          conditions.push(
            "EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag = ?)"
          );
          params.push(tag);
        }
      }

      const whereClause = conditions.join(" AND ");

      // Get total count
      // Use COUNT(DISTINCT d.id) to prevent duplicate counting when tag filters match multiple tags
      const countSql = `SELECT COUNT(DISTINCT d.id) as count FROM documents d WHERE ${whereClause}`;
      const countRow = db
        .query<{ count: number }, (string | number)[]>(countSql)
        .get(...params);
      const total = countRow?.count ?? 0;

      // Get paginated documents
      // Use DISTINCT to prevent duplicate rows when tag filters match multiple tags
      const selectSql = `SELECT DISTINCT d.* FROM documents d WHERE ${whereClause} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`;
      const rows = db
        .query<DbDocumentRow, (string | number)[]>(selectSql)
        .all(...params, limit, offset);

      return ok({ documents: rows.map(mapDocumentRow), total });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to list documents",
        cause
      );
    }
  }

  async markInactive(
    collection: string,
    relPaths: string[]
  ): Promise<StoreResult<number>> {
    try {
      const db = this.ensureOpen();

      if (relPaths.length === 0) {
        return ok(0);
      }

      const placeholders = relPaths.map(() => "?").join(",");
      const result = db.run(
        `UPDATE documents SET active = 0, updated_at = datetime('now')
         WHERE collection = ? AND rel_path IN (${placeholders})`,
        [collection, ...relPaths]
      );

      return ok(result.changes);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to mark documents inactive",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Content
  // ─────────────────────────────────────────────────────────────────────────

  async upsertContent(
    mirrorHash: string,
    markdown: string
  ): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      db.run(
        `INSERT INTO content (mirror_hash, markdown)
         VALUES (?, ?)
         ON CONFLICT(mirror_hash) DO NOTHING`,
        [mirrorHash, markdown]
      );

      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to upsert content",
        cause
      );
    }
  }

  async getContent(mirrorHash: string): Promise<StoreResult<string | null>> {
    try {
      const db = this.ensureOpen();

      const row = db
        .query<{ markdown: string }, [string]>(
          "SELECT markdown FROM content WHERE mirror_hash = ?"
        )
        .get(mirrorHash);

      return ok(row?.markdown ?? null);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get content",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chunks
  // ─────────────────────────────────────────────────────────────────────────

  async upsertChunks(
    mirrorHash: string,
    chunks: ChunkInput[]
  ): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Delete existing chunks for this hash
        db.run("DELETE FROM content_chunks WHERE mirror_hash = ?", [
          mirrorHash,
        ]);

        // Insert new chunks
        const stmt = db.prepare(`
          INSERT INTO content_chunks (mirror_hash, seq, pos, text, start_line, end_line, language, token_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const chunk of chunks) {
          stmt.run(
            mirrorHash,
            chunk.seq,
            chunk.pos,
            chunk.text,
            chunk.startLine,
            chunk.endLine,
            chunk.language ?? null,
            chunk.tokenCount ?? null
          );
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to upsert chunks",
        cause
      );
    }
  }

  async getChunks(mirrorHash: string): Promise<StoreResult<ChunkRow[]>> {
    try {
      const db = this.ensureOpen();

      const rows = db
        .query<DbChunkRow, [string]>(
          "SELECT * FROM content_chunks WHERE mirror_hash = ? ORDER BY seq"
        )
        .all(mirrorHash);

      return ok(rows.map(mapChunkRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get chunks",
        cause
      );
    }
  }

  async getChunksBatch(
    mirrorHashes: string[]
  ): Promise<StoreResult<Map<string, ChunkRow[]>>> {
    try {
      // Early return for empty input
      if (mirrorHashes.length === 0) {
        return ok(new Map());
      }

      // Dedupe and filter empty strings
      const uniqueHashes = [
        ...new Set(mirrorHashes.filter((h) => h.trim().length > 0)),
      ];
      if (uniqueHashes.length === 0) {
        return ok(new Map());
      }

      const db = this.ensureOpen();
      const result = new Map<string, ChunkRow[]>();

      // SQLite SQLITE_LIMIT_VARIABLE_NUMBER defaults to 999
      // Reserve 99 for potential future filter params (collection, language, etc.)
      const SQLITE_MAX_PARAMS = 900;

      // Batch queries to respect SQLite parameter limit
      for (let i = 0; i < uniqueHashes.length; i += SQLITE_MAX_PARAMS) {
        const batch = uniqueHashes.slice(i, i + SQLITE_MAX_PARAMS);
        const placeholders = batch.map(() => "?").join(",");
        const sql = `SELECT * FROM content_chunks
                     WHERE mirror_hash IN (${placeholders})
                     ORDER BY mirror_hash, seq`;
        const rows = db.query<DbChunkRow, string[]>(sql).all(...batch);

        // Group by mirrorHash, preserving seq order from ORDER BY
        for (const row of rows) {
          const mapped = mapChunkRow(row);
          const existing = result.get(mapped.mirrorHash) ?? [];
          existing.push(mapped);
          result.set(mapped.mirrorHash, existing);
        }
      }

      return ok(result);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get chunks batch",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FTS Search
  // ─────────────────────────────────────────────────────────────────────────

  async searchFts(
    query: string,
    options: FtsSearchOptions = {}
  ): Promise<StoreResult<FtsResult[]>> {
    try {
      const db = this.ensureOpen();
      const limit = options.limit ?? 20;

      // Build tag filter conditions using EXISTS subqueries
      const tagConditions: string[] = [];
      const params: (string | number)[] = [escapeFts5Query(query)];

      // tagsAny: document has at least one of these tags
      if (options.tagsAny && options.tagsAny.length > 0) {
        const placeholders = options.tagsAny.map(() => "?").join(",");
        tagConditions.push(
          `EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag IN (${placeholders}))`
        );
        params.push(...options.tagsAny);
      }

      // tagsAll: document has all of these tags
      if (options.tagsAll && options.tagsAll.length > 0) {
        for (const tag of options.tagsAll) {
          tagConditions.push(
            "EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag = ?)"
          );
          params.push(tag);
        }
      }

      if (options.collection) {
        params.push(options.collection);
      }
      params.push(limit);

      // Document-level FTS search using documents_fts
      // Uses bm25() for relevance ranking (more negative = better match)
      // Snippet from body column (index 2) with highlight markers
      const sql = `
        SELECT
          d.mirror_hash,
          0 as seq,
          bm25(documents_fts) as score,
          ${options.snippet ? "snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet," : ""}
          d.docid,
          d.uri,
          d.title,
          d.collection,
          d.rel_path,
          d.source_mime,
          d.source_ext,
          d.source_mtime,
          d.source_size,
          d.source_hash
        FROM documents_fts fts
        JOIN documents d ON d.id = fts.rowid AND d.active = 1
        WHERE documents_fts MATCH ?
        ${tagConditions.length > 0 ? `AND ${tagConditions.join(" AND ")}` : ""}
        ${options.collection ? "AND d.collection = ?" : ""}
        ORDER BY bm25(documents_fts)
        LIMIT ?
      `;

      interface FtsRow {
        mirror_hash: string;
        seq: number;
        score: number;
        snippet?: string;
        docid: string;
        uri: string;
        title: string | null;
        collection: string;
        rel_path: string;
        source_mime: string | null;
        source_ext: string | null;
        source_mtime: string | null;
        source_size: number | null;
        source_hash: string | null;
      }

      const rows = db.query<FtsRow, (string | number)[]>(sql).all(...params);

      return ok(
        rows.map((r) => ({
          mirrorHash: r.mirror_hash,
          seq: r.seq,
          score: r.score, // Raw bm25() - smaller (more negative) is better
          snippet: r.snippet,
          docid: r.docid,
          uri: r.uri,
          title: r.title ?? undefined,
          collection: r.collection,
          relPath: r.rel_path,
          sourceMime: r.source_mime ?? undefined,
          sourceExt: r.source_ext ?? undefined,
          sourceMtime: r.source_mtime ?? undefined,
          sourceSize: r.source_size ?? undefined,
          sourceHash: r.source_hash ?? undefined,
        }))
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      // Detect FTS5 syntax errors and return INVALID_INPUT for consistent handling
      const isSyntaxError =
        message.includes("malformed MATCH") ||
        message.includes("fts5: syntax error") ||
        message.includes("fts5:");
      return err(
        isSyntaxError ? "INVALID_INPUT" : "QUERY_FAILED",
        message || "Failed to search FTS",
        cause
      );
    }
  }

  /**
   * Sync a document to documents_fts for full-text search.
   * Must be called after document and content are both upserted.
   * The FTS rowid matches documents.id for efficient JOINs.
   */
  async syncDocumentFts(
    collection: string,
    relPath: string
  ): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Get document with its content
        interface DocWithContent {
          id: number;
          rel_path: string;
          title: string | null;
          markdown: string | null;
        }

        const doc = db
          .query<DocWithContent, [string, string]>(
            `SELECT d.id, d.rel_path, d.title, c.markdown
             FROM documents d
             LEFT JOIN content c ON c.mirror_hash = d.mirror_hash
             WHERE d.collection = ? AND d.rel_path = ? AND d.active = 1`
          )
          .get(collection, relPath);

        if (!doc) {
          return; // Document not found or inactive
        }

        // Delete existing FTS entry for this doc
        db.run("DELETE FROM documents_fts WHERE rowid = ?", [doc.id]);

        // Insert new FTS entry if we have content
        if (doc.markdown) {
          db.run(
            "INSERT INTO documents_fts (rowid, filepath, title, body) VALUES (?, ?, ?, ?)",
            [doc.id, doc.rel_path, doc.title ?? "", doc.markdown]
          );
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to sync document FTS",
        cause
      );
    }
  }

  /**
   * Rebuild entire documents_fts index from scratch.
   * Use after migration or for recovery.
   */
  async rebuildAllDocumentsFts(): Promise<StoreResult<number>> {
    try {
      const db = this.ensureOpen();
      let count = 0;

      const transaction = db.transaction(() => {
        // Clear FTS table
        db.run("DELETE FROM documents_fts");

        // Get all active documents with content
        interface DocWithContent {
          id: number;
          rel_path: string;
          title: string | null;
          markdown: string;
        }

        const docs = db
          .query<DocWithContent, []>(
            `SELECT d.id, d.rel_path, d.title, c.markdown
             FROM documents d
             JOIN content c ON c.mirror_hash = d.mirror_hash
             WHERE d.active = 1 AND d.mirror_hash IS NOT NULL`
          )
          .all();

        // Insert FTS entries
        const stmt = db.prepare(
          "INSERT INTO documents_fts (rowid, filepath, title, body) VALUES (?, ?, ?, ?)"
        );

        for (const doc of docs) {
          stmt.run(doc.id, doc.rel_path, doc.title ?? "", doc.markdown);
          count++;
        }
      });

      transaction();
      return ok(count);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to rebuild documents FTS",
        cause
      );
    }
  }

  /**
   * @deprecated Use syncDocumentFts for document-level FTS.
   * Kept for backwards compat during migration.
   */
  async rebuildFtsForHash(mirrorHash: string): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Get documents using this hash and sync their FTS
        interface DocInfo {
          id: number;
          rel_path: string;
          title: string | null;
        }

        const docs = db
          .query<DocInfo, [string]>(
            "SELECT id, rel_path, title FROM documents WHERE mirror_hash = ? AND active = 1"
          )
          .all(mirrorHash);

        // Get content
        const content = db
          .query<{ markdown: string }, [string]>(
            "SELECT markdown FROM content WHERE mirror_hash = ?"
          )
          .get(mirrorHash);

        if (!content) {
          return;
        }

        // Update FTS for each document using this hash
        for (const doc of docs) {
          db.run("DELETE FROM documents_fts WHERE rowid = ?", [doc.id]);
          db.run(
            "INSERT INTO documents_fts (rowid, filepath, title, body) VALUES (?, ?, ?, ?)",
            [doc.id, doc.rel_path, doc.title ?? "", content.markdown]
          );
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to rebuild FTS",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tags
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set tags for a document.
   * Replaces tags from the given source (frontmatter or user).
   * User tags are never overwritten by frontmatter updates.
   */
  async setDocTags(
    documentId: number,
    tags: string[],
    source: TagSource
  ): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Delete existing tags from this source
        db.run("DELETE FROM doc_tags WHERE document_id = ? AND source = ?", [
          documentId,
          source,
        ]);

        // Insert new tags (skip duplicates from other source)
        if (tags.length > 0) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO doc_tags (document_id, tag, source)
            VALUES (?, ?, ?)
          `);

          for (const tag of tags) {
            stmt.run(documentId, tag, source);
          }
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to set document tags",
        cause
      );
    }
  }

  /**
   * Get all tags for a document.
   */
  async getTagsForDoc(documentId: number): Promise<StoreResult<TagRow[]>> {
    try {
      const db = this.ensureOpen();

      interface DbTagRow {
        tag: string;
        source: "frontmatter" | "user";
      }

      const rows = db
        .query<DbTagRow, [number]>(
          "SELECT tag, source FROM doc_tags WHERE document_id = ? ORDER BY tag"
        )
        .all(documentId);

      return ok(rows);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get tags for document",
        cause
      );
    }
  }

  /**
   * Get tags for multiple documents in a single query.
   * Returns a map of documentId -> TagRow[].
   */
  async getTagsBatch(
    documentIds: number[]
  ): Promise<StoreResult<Map<number, TagRow[]>>> {
    try {
      const db = this.ensureOpen();

      if (documentIds.length === 0) {
        return ok(new Map());
      }

      interface DbTagRow {
        document_id: number;
        tag: string;
        source: "frontmatter" | "user";
      }

      // Use parameterized IN clause to prevent SQL injection
      const placeholders = documentIds.map(() => "?").join(", ");
      const rows = db
        .query<DbTagRow, number[]>(
          `SELECT document_id, tag, source FROM doc_tags
           WHERE document_id IN (${placeholders}) ORDER BY document_id, tag`
        )
        .all(...documentIds);

      // Group by document_id
      const result = new Map<number, TagRow[]>();
      for (const row of rows) {
        const existing = result.get(row.document_id) ?? [];
        existing.push({ tag: row.tag, source: row.source });
        result.set(row.document_id, existing);
      }

      return ok(result);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get tags batch",
        cause
      );
    }
  }

  /**
   * Get tag counts across all active documents.
   * Optionally filter by collection or tag prefix.
   */
  async getTagCounts(options?: {
    collection?: string;
    prefix?: string;
  }): Promise<StoreResult<TagCount[]>> {
    try {
      const db = this.ensureOpen();

      const params: (string | number)[] = [];
      let sql = `
        SELECT dt.tag, COUNT(DISTINCT dt.document_id) as count
        FROM doc_tags dt
        JOIN documents d ON d.id = dt.document_id AND d.active = 1
      `;

      const conditions: string[] = [];

      if (options?.collection) {
        conditions.push("d.collection = ?");
        params.push(options.collection);
      }

      if (options?.prefix) {
        // Normalize prefix: trim trailing slashes to avoid double-slash in LIKE pattern
        const normalizedPrefix = options.prefix.replace(/\/+$/, "");
        // Match tags starting with prefix (for hierarchical browsing)
        // Escape LIKE metacharacters (%, _, \) in prefix
        const escapedPrefix = normalizedPrefix.replace(/[%_\\]/g, "\\$&");
        conditions.push("(dt.tag = ? OR dt.tag LIKE ? ESCAPE '\\')");
        params.push(normalizedPrefix, `${escapedPrefix}/%`);
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }

      sql += " GROUP BY dt.tag ORDER BY count DESC, dt.tag ASC";

      interface DbTagCount {
        tag: string;
        count: number;
      }

      const rows = db
        .query<DbTagCount, (string | number)[]>(sql)
        .all(...params);

      return ok(rows);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get tag counts",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status
  // ─────────────────────────────────────────────────────────────────────────

  async getStatus(): Promise<StoreResult<IndexStatus>> {
    try {
      const db = this.ensureOpen();

      // Get version
      const versionRow = db
        .query<{ value: string }, []>(
          "SELECT value FROM schema_meta WHERE key = 'version'"
        )
        .get();
      const version = versionRow?.value ?? "0";

      // Derive indexName from dbPath (basename without extension)
      const indexName =
        this.dbPath
          .split("/")
          .pop()
          ?.replace(SQLITE_EXT_REGEX, "")
          ?.replace(INDEX_PREFIX_REGEX, "") || "default";

      // Get collection stats with chunk counts
      interface CollectionStat {
        name: string;
        path: string;
        total: number;
        active: number;
        errored: number;
        chunked: number;
        chunk_count: number;
        embedded_count: number;
      }

      const collectionStats = db
        .query<CollectionStat, []>(
          `
          SELECT
            c.name,
            c.path,
            COUNT(DISTINCT d.id) as total,
            SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN d.last_error_code IS NOT NULL THEN 1 ELSE 0 END) as errored,
            SUM(CASE WHEN d.mirror_hash IS NOT NULL THEN 1 ELSE 0 END) as chunked,
            (SELECT COUNT(*) FROM content_chunks cc
             JOIN documents d2 ON d2.mirror_hash = cc.mirror_hash
             WHERE d2.collection = c.name AND d2.active = 1) as chunk_count,
            (SELECT COUNT(*) FROM content_vectors cv
             JOIN documents d3 ON d3.mirror_hash = cv.mirror_hash
             WHERE d3.collection = c.name AND d3.active = 1) as embedded_count
          FROM collections c
          LEFT JOIN documents d ON d.collection = c.name
          GROUP BY c.name, c.path
        `
        )
        .all();

      // Get totals
      const totalsRow = db
        .query<{ total: number; active: number }, []>(
          `
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active
          FROM documents
        `
        )
        .get();

      const chunkCount =
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) as count FROM content_chunks"
          )
          .get()?.count ?? 0;

      // Embedding backlog: chunks from active docs without vectors
      // Uses EXISTS to avoid duplicates when multiple docs share mirror_hash
      const backlogRow = db
        .query<{ count: number }, []>(
          `
          SELECT COUNT(*) as count FROM content_chunks c
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors v
            WHERE v.mirror_hash = c.mirror_hash AND v.seq = c.seq
          )
        `
        )
        .get();

      // Recent errors (last 24h)
      const recentErrorsRow = db
        .query<{ count: number }, []>(
          `
          SELECT COUNT(*) as count FROM ingest_errors
          WHERE occurred_at > datetime('now', '-1 day')
        `
        )
        .get();

      // Last updated (max updated_at from documents)
      const lastUpdatedRow = db
        .query<{ last_updated: string | null }, []>(
          "SELECT MAX(updated_at) as last_updated FROM documents"
        )
        .get();

      // Health check: no recent errors and DB is accessible
      const recentErrors = recentErrorsRow?.count ?? 0;
      const healthy = recentErrors === 0;

      return ok({
        version,
        indexName,
        configPath: this.configPath,
        dbPath: this.dbPath,
        ftsTokenizer: this.ftsTokenizer,
        collections: collectionStats.map((s) => ({
          name: s.name,
          path: s.path,
          totalDocuments: s.total,
          activeDocuments: s.active,
          errorDocuments: s.errored,
          chunkedDocuments: s.chunked,
          totalChunks: s.chunk_count,
          embeddedChunks: s.embedded_count,
        })),
        totalDocuments: totalsRow?.total ?? 0,
        activeDocuments: totalsRow?.active ?? 0,
        totalChunks: chunkCount,
        embeddingBacklog: backlogRow?.count ?? 0,
        recentErrors,
        lastUpdatedAt: lastUpdatedRow?.last_updated ?? null,
        healthy,
      });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get status",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Errors
  // ─────────────────────────────────────────────────────────────────────────

  async recordError(error: IngestErrorInput): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      db.run(
        `INSERT INTO ingest_errors (collection, rel_path, code, message, details_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          error.collection,
          error.relPath,
          error.code,
          error.message,
          error.details ? JSON.stringify(error.details) : null,
        ]
      );

      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to record error",
        cause
      );
    }
  }

  async getRecentErrors(limit = 50): Promise<StoreResult<IngestErrorRow[]>> {
    try {
      const db = this.ensureOpen();

      const rows = db
        .query<DbIngestErrorRow, [number]>(
          "SELECT * FROM ingest_errors ORDER BY occurred_at DESC LIMIT ?"
        )
        .all(limit);

      return ok(rows.map(mapIngestErrorRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get recent errors",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  async cleanupOrphans(): Promise<StoreResult<CleanupStats>> {
    try {
      const db = this.ensureOpen();

      let orphanedContent = 0;
      let orphanedChunks = 0;
      let orphanedVectors = 0;
      let expiredCache = 0;

      const transaction = db.transaction(() => {
        // Delete content not referenced by any active document
        const contentResult = db.run(`
          DELETE FROM content WHERE mirror_hash NOT IN (
            SELECT DISTINCT mirror_hash FROM documents WHERE mirror_hash IS NOT NULL AND active = 1
          )
        `);
        orphanedContent = contentResult.changes;

        // Delete chunks for deleted content
        const chunksResult = db.run(`
          DELETE FROM content_chunks WHERE mirror_hash NOT IN (
            SELECT mirror_hash FROM content
          )
        `);
        orphanedChunks = chunksResult.changes;

        // Delete vectors for deleted chunks
        const vectorsResult = db.run(`
          DELETE FROM content_vectors WHERE (mirror_hash, seq) NOT IN (
            SELECT mirror_hash, seq FROM content_chunks
          )
        `);
        orphanedVectors = vectorsResult.changes;

        // Delete expired cache entries
        const cacheResult = db.run(`
          DELETE FROM llm_cache WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
        `);
        expiredCache = cacheResult.changes;

        // Clean orphaned FTS entries (documents that no longer exist or are inactive)
        db.run(`
          DELETE FROM documents_fts WHERE rowid NOT IN (
            SELECT id FROM documents WHERE active = 1
          )
        `);
      });

      transaction();

      return ok({
        orphanedContent,
        orphanedChunks,
        orphanedVectors,
        expiredCache,
      });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to cleanup orphans",
        cause
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Row Types (snake_case from SQLite)
// ─────────────────────────────────────────────────────────────────────────────

interface DbCollectionRow {
  name: string;
  path: string;
  pattern: string;
  include: string | null;
  exclude: string | null;
  update_cmd: string | null;
  language_hint: string | null;
  synced_at: string;
}

interface DbContextRow {
  scope_type: "global" | "collection" | "prefix";
  scope_key: string;
  text: string;
  synced_at: string;
}

interface DbDocumentRow {
  id: number;
  collection: string;
  rel_path: string;
  source_hash: string;
  source_mime: string;
  source_ext: string;
  source_size: number;
  source_mtime: string;
  docid: string;
  uri: string;
  title: string | null;
  mirror_hash: string | null;
  converter_id: string | null;
  converter_version: string | null;
  language_hint: string | null;
  active: number;
  ingest_version: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbChunkRow {
  mirror_hash: string;
  seq: number;
  pos: number;
  text: string;
  start_line: number;
  end_line: number;
  language: string | null;
  token_count: number | null;
  created_at: string;
}

interface DbIngestErrorRow {
  id: number;
  collection: string;
  rel_path: string;
  occurred_at: string;
  code: string;
  message: string;
  details_json: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row Mappers (snake_case -> camelCase)
// ─────────────────────────────────────────────────────────────────────────────

function mapCollectionRow(row: DbCollectionRow): CollectionRow {
  return {
    name: row.name,
    path: row.path,
    pattern: row.pattern,
    include: row.include ? JSON.parse(row.include) : null,
    exclude: row.exclude ? JSON.parse(row.exclude) : null,
    updateCmd: row.update_cmd,
    languageHint: row.language_hint,
    syncedAt: row.synced_at,
  };
}

function mapContextRow(row: DbContextRow): ContextRow {
  return {
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    text: row.text,
    syncedAt: row.synced_at,
  };
}

function mapDocumentRow(row: DbDocumentRow): DocumentRow {
  return {
    id: row.id,
    collection: row.collection,
    relPath: row.rel_path,
    sourceHash: row.source_hash,
    sourceMime: row.source_mime,
    sourceExt: row.source_ext,
    sourceSize: row.source_size,
    sourceMtime: row.source_mtime,
    docid: row.docid,
    uri: row.uri,
    title: row.title,
    mirrorHash: row.mirror_hash,
    converterId: row.converter_id,
    converterVersion: row.converter_version,
    languageHint: row.language_hint,
    active: row.active === 1,
    ingestVersion: row.ingest_version,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChunkRow(row: DbChunkRow): ChunkRow {
  return {
    mirrorHash: row.mirror_hash,
    seq: row.seq,
    pos: row.pos,
    text: row.text,
    startLine: row.start_line,
    endLine: row.end_line,
    language: row.language,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

function mapIngestErrorRow(row: DbIngestErrorRow): IngestErrorRow {
  return {
    id: row.id,
    collection: row.collection,
    relPath: row.rel_path,
    occurredAt: row.occurred_at,
    code: row.code,
    message: row.message,
    detailsJson: row.details_json,
  };
}
