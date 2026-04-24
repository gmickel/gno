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
  BacklinkRow,
  ChunkInput,
  ChunkRow,
  CleanupStats,
  CollectionRow,
  ContextRow,
  DocLinkInput,
  DocLinkRow,
  DocLinkSource,
  DocumentInput,
  DocumentRow,
  EmbeddingCleanupStats,
  FtsResult,
  FtsSearchOptions,
  GetGraphOptions,
  GraphResult,
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

import { buildUri, deriveDocid, stripUriIndex } from "../../app/constants";
import { normalizeWikiName, stripWikiMdExt } from "../../core/links";
import { migrations, runMigrations } from "../migrations";
import { err, ok } from "../types";
import { modelTableName } from "../vector/sqlite-vec";
import { loadFts5Snowball } from "./fts5-snowball";

// ─────────────────────────────────────────────────────────────────────────────
// FTS5 Query Escaping
// ─────────────────────────────────────────────────────────────────────────────

/** Whitespace regex for splitting FTS5 tokens */
const WHITESPACE_REGEX = /\s+/;
const SINGLE_LINE_QUERY_PATTERN = /[\r\n]/;
const DOUBLE_QUOTE_PATTERN = /"/g;
const FTS5_FIELD_WEIGHTS = {
  filepath: 1.5,
  title: 4.0,
  body: 1.0,
} as const;

function sanitizeFts5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}'_]/gu, "").toLowerCase();
}

function isCompoundToken(token: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}'+-]*[-+][\p{L}\p{N}][\p{L}\p{N}'+-]*$/u.test(
    token
  );
}

function sanitizeCompoundTerm(term: string): string {
  return term
    .split(/[-+]/)
    .map((part) => sanitizeFts5Term(part))
    .filter((part) => part.length > 0)
    .join(" ");
}

type FtsQueryBuildResult =
  | { ok: true; query: string }
  | { ok: false; error: string };

/**
 * Narrow lexical grammar for BM25/FTS queries.
 *
 * Supported:
 * - plain terms -> prefix match
 * - quoted phrases -> phrase match
 * - negation with at least one positive term
 * - hyphenated compounds handled intentionally
 */
function buildFts5Query(query: string): FtsQueryBuildResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: "Search query cannot be empty" };
  }

  if (SINGLE_LINE_QUERY_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: "Lexical query must be a single line. Remove newline characters.",
    };
  }

  const quoteCount = (trimmed.match(DOUBLE_QUOTE_PATTERN) ?? []).length;
  if (quoteCount % 2 === 1) {
    return {
      ok: false,
      error:
        'Lexical query has an unmatched double quote ("). Add the closing quote or remove it.',
    };
  }

  const positive: string[] = [];
  const negative: string[] = [];
  let i = 0;

  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) {
      i += 1;
    }
    if (i >= trimmed.length) {
      break;
    }

    const negated = trimmed[i] === "-";
    if (negated) {
      i += 1;
    }

    if (i < trimmed.length && trimmed[i] === '"') {
      const start = i + 1;
      i += 1;
      while (i < trimmed.length && trimmed[i] !== '"') {
        i += 1;
      }
      const phrase = trimmed.slice(start, i).trim();
      i += 1;

      if (!phrase) {
        continue;
      }

      const sanitized = phrase
        .split(WHITESPACE_REGEX)
        .map((token) =>
          isCompoundToken(token)
            ? sanitizeCompoundTerm(token)
            : sanitizeFts5Term(token)
        )
        .filter((token) => token.length > 0)
        .join(" ");
      if (!sanitized) {
        continue;
      }

      const ftsPhrase = `"${sanitized}"`;
      if (negated) {
        negative.push(ftsPhrase);
      } else {
        positive.push(ftsPhrase);
      }
      continue;
    }

    const start = i;
    while (i < trimmed.length && !/[\s"]/.test(trimmed[i]!)) {
      i += 1;
    }
    const token = trimmed.slice(start, i);
    if (!token) {
      continue;
    }

    if (isCompoundToken(token)) {
      const sanitized = sanitizeCompoundTerm(token);
      if (!sanitized) {
        continue;
      }
      const ftsPhrase = `"${sanitized}"`;
      if (negated) {
        negative.push(ftsPhrase);
      } else {
        positive.push(ftsPhrase);
      }
      continue;
    }

    const sanitized = sanitizeFts5Term(token);
    if (!sanitized) {
      continue;
    }
    const ftsTerm = `"${sanitized}"*`;
    if (negated) {
      negative.push(ftsTerm);
    } else {
      positive.push(ftsTerm);
    }
  }

  if (positive.length === 0 && negative.length === 0) {
    return { ok: false, error: "Search query has no searchable terms" };
  }

  if (positive.length === 0) {
    return {
      ok: false,
      error:
        "Negation requires at least one positive search term in lexical queries.",
    };
  }

  let ftsQuery = positive.join(" AND ");
  for (const negation of negative) {
    ftsQuery = `${ftsQuery} NOT ${negation}`;
  }

  return { ok: true, query: ftsQuery };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Regex to strip .sqlite extension from db path */
const SQLITE_EXT_REGEX = /\.sqlite$/;

/** Regex to strip index- prefix from db name */
const INDEX_PREFIX_REGEX = /^index-/;

function isDatabaseLockedError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.toLowerCase().includes("database is locked")
  );
}

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

      // Keep WAL everywhere so readers can continue while a writer is active.
      // CI still relaxes fsync/temp-store for speed, but MEMORY journal mode
      // breaks the cross-process read/write behavior we rely on in CLI tests.
      try {
        const journalMode = this.db
          .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
          .get()?.journal_mode;
        if (journalMode?.toLowerCase() !== "wal") {
          this.db.exec("PRAGMA journal_mode = WAL");
        }
      } catch (cause) {
        if (!isDatabaseLockedError(cause)) {
          throw cause;
        }
        // Another process may be switching journal mode or holding a write
        // lock during startup. In that case we keep the connection usable and
        // rely on the existing DB journal mode instead of failing open().
      }

      if (process.env.CI) {
        this.db.exec("PRAGMA synchronous = OFF");
        this.db.exec("PRAGMA temp_store = MEMORY");
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
          source_size, source_mtime, source_ctime, docid, uri, title, mirror_hash,
          converter_id, converter_version, language_hint, content_type, categories,
          author, frontmatter_date, date_fields, active, indexed_at, last_error_code,
          last_error_message, last_error_at, ingest_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(collection, rel_path) DO UPDATE SET
          source_hash = excluded.source_hash,
          source_mime = excluded.source_mime,
          source_ext = excluded.source_ext,
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          source_ctime = excluded.source_ctime,
          docid = excluded.docid,
          uri = excluded.uri,
          title = excluded.title,
          mirror_hash = excluded.mirror_hash,
          converter_id = excluded.converter_id,
          converter_version = excluded.converter_version,
          language_hint = excluded.language_hint,
          content_type = excluded.content_type,
          categories = excluded.categories,
          author = excluded.author,
          frontmatter_date = excluded.frontmatter_date,
          date_fields = excluded.date_fields,
          active = 1,
          indexed_at = datetime('now'),
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
          doc.sourceCtime ?? doc.sourceMtime,
          docid,
          uri,
          doc.title ?? null,
          doc.mirrorHash ?? null,
          doc.converterId ?? null,
          doc.converterVersion ?? null,
          doc.languageHint ?? null,
          doc.contentType ?? null,
          doc.categories ? JSON.stringify(doc.categories) : null,
          doc.author ?? null,
          doc.frontmatterDate ?? null,
          doc.dateFields ? JSON.stringify(doc.dateFields) : null,
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
      const canonicalUri = stripUriIndex(uri);
      const row = db
        .query<DbDocumentRow, [string]>("SELECT * FROM documents WHERE uri = ?")
        .get(canonicalUri);

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

  async listActiveDocumentsForBrowse(
    collection?: string
  ): Promise<StoreResult<DocumentRow[]>> {
    try {
      const db = this.ensureOpen();
      const rows = collection
        ? db
            .query<DbDocumentRow, [string]>(
              `SELECT * FROM documents
               WHERE collection = ? AND active = 1
               ORDER BY rel_path ASC, id ASC`
            )
            .all(collection)
        : db
            .query<DbDocumentRow, []>(
              `SELECT * FROM documents
               WHERE active = 1
               ORDER BY collection ASC, rel_path ASC, id ASC`
            )
            .all();

      return ok(rows.map(mapDocumentRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to list active browse documents",
        cause
      );
    }
  }

  async getDocumentsByMirrorHashes(
    mirrorHashes: string[],
    options: {
      collection?: string;
      activeOnly?: boolean;
    } = {}
  ): Promise<StoreResult<DocumentRow[]>> {
    try {
      if (mirrorHashes.length === 0) {
        return ok([]);
      }

      const uniqueHashes = [
        ...new Set(mirrorHashes.filter((hash) => hash.trim().length > 0)),
      ];
      if (uniqueHashes.length === 0) {
        return ok([]);
      }

      const db = this.ensureOpen();
      const rows: DbDocumentRow[] = [];

      // SQLite SQLITE_LIMIT_VARIABLE_NUMBER defaults to 999.
      // Reserve headroom for optional non-IN parameters.
      const SQL_PARAM_LIMIT = options.collection ? 899 : 900;

      for (let i = 0; i < uniqueHashes.length; i += SQL_PARAM_LIMIT) {
        const batch = uniqueHashes.slice(i, i + SQL_PARAM_LIMIT);
        const placeholders = batch.map(() => "?").join(",");
        const clauses = [`mirror_hash IN (${placeholders})`];
        const params: string[] = [...batch];

        if (options.activeOnly ?? true) {
          clauses.push("active = 1");
        }
        if (options.collection) {
          clauses.push("collection = ?");
          params.push(options.collection);
        }

        const sql = `SELECT * FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id`;
        rows.push(...db.query<DbDocumentRow, string[]>(sql).all(...params));
      }

      return ok(rows.map(mapDocumentRow));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get documents by mirror hashes",
        cause
      );
    }
  }

  async listDocumentsPaginated(options: {
    collection?: string;
    limit: number;
    offset: number;
    pathPrefix?: string;
    directChildrenOnly?: boolean;
    tagsAll?: string[];
    tagsAny?: string[];
    since?: string;
    until?: string;
    categories?: string[];
    author?: string;
    sortField?: string;
    sortOrder?: "asc" | "desc";
  }): Promise<StoreResult<{ documents: DocumentRow[]; total: number }>> {
    try {
      const db = this.ensureOpen();
      const {
        collection,
        limit,
        offset,
        pathPrefix,
        directChildrenOnly,
        tagsAll,
        tagsAny,
      } = options;

      // Build WHERE conditions and params
      const conditions: string[] = ["d.active = 1"];
      const params: (string | number)[] = [];

      if (collection) {
        conditions.push("d.collection = ?");
        params.push(collection);
      }

      const normalizedPathPrefix = pathPrefix
        ?.replaceAll("\\", "/")
        .replace(/^\/+|\/+$/g, "");

      if (normalizedPathPrefix) {
        conditions.push("d.rel_path LIKE ?");
        params.push(`${normalizedPathPrefix}/%`);

        if (directChildrenOnly) {
          conditions.push("substr(d.rel_path, ?) NOT LIKE '%/%'");
          params.push(normalizedPathPrefix.length + 2);
        }
      } else if (directChildrenOnly) {
        conditions.push("d.rel_path NOT LIKE '%/%'");
      }

      if (options.since) {
        conditions.push("d.source_mtime >= ?");
        params.push(options.since);
      }
      if (options.until) {
        conditions.push("d.source_mtime <= ?");
        params.push(options.until);
      }

      if (options.categories && options.categories.length > 0) {
        const placeholders = options.categories.map(() => "?").join(",");
        conditions.push(
          `(d.content_type IN (${placeholders}) OR EXISTS (SELECT 1 FROM json_each(COALESCE(d.categories, '[]')) jc WHERE jc.value IN (${placeholders})))`
        );
        params.push(...options.categories, ...options.categories);
      }

      if (options.author) {
        conditions.push("LOWER(COALESCE(d.author, '')) LIKE ?");
        params.push(`%${options.author.toLowerCase()}%`);
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

      // Sort options
      const sortOrder = options.sortOrder === "asc" ? "ASC" : "DESC";
      const sortField = options.sortField ?? "modified";
      const isSafeDateField = /^[a-z0-9_]+$/.test(sortField);
      let orderClause = `d.source_mtime ${sortOrder}`;
      if (sortField !== "modified" && isSafeDateField) {
        orderClause = `COALESCE(json_extract(d.date_fields, '$."${sortField}"'), d.source_mtime) ${sortOrder}`;
      }

      // Get total count
      // Use COUNT(DISTINCT d.id) to prevent duplicate counting when tag filters match multiple tags
      const countSql = `SELECT COUNT(DISTINCT d.id) as count FROM documents d WHERE ${whereClause}`;
      const countRow = db
        .query<{ count: number }, (string | number)[]>(countSql)
        .get(...params);
      const total = countRow?.count ?? 0;

      // Get paginated documents
      // Use DISTINCT to prevent duplicate rows when tag filters match multiple tags
      const selectSql = `SELECT DISTINCT d.* FROM documents d WHERE ${whereClause} ORDER BY ${orderClause}, d.id ASC LIMIT ? OFFSET ?`;
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

  async getCollectionDateFields(
    collection?: string
  ): Promise<StoreResult<string[]>> {
    try {
      const db = this.ensureOpen();
      const conditions: string[] = [
        "d.active = 1",
        "d.date_fields IS NOT NULL",
      ];
      const params: string[] = [];

      if (collection) {
        conditions.push("d.collection = ?");
        params.push(collection);
      }

      const sql = `
        SELECT DISTINCT jf.key as field
        FROM documents d
        JOIN json_each(COALESCE(d.date_fields, '{}')) jf
        WHERE ${conditions.join(" AND ")}
        ORDER BY jf.key ASC
      `;

      const rows = db.query<{ field: string }, string[]>(sql).all(...params);
      return ok(rows.map((r) => r.field));
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to list collection date fields",
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

  async getContentBatch(
    mirrorHashes: string[]
  ): Promise<StoreResult<Map<string, string>>> {
    try {
      const db = this.ensureOpen();

      if (mirrorHashes.length === 0) {
        return ok(new Map());
      }

      interface DbContentRow {
        mirror_hash: string;
        markdown: string;
      }

      const placeholders = mirrorHashes.map(() => "?").join(", ");
      const rows = db
        .query<DbContentRow, string[]>(
          `SELECT mirror_hash, markdown FROM content
           WHERE mirror_hash IN (${placeholders})`
        )
        .all(...mirrorHashes);

      return ok(
        new Map(rows.map((row) => [row.mirror_hash, row.markdown] as const))
      );
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get content batch",
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
      const builtQuery = buildFts5Query(query);
      if (!builtQuery.ok) {
        return err("INVALID_INPUT", builtQuery.error);
      }

      // Build tag filter conditions using EXISTS subqueries
      const tagConditions: string[] = [];
      const params: (string | number)[] = [];

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

      if (options.since) {
        tagConditions.push("d.source_mtime >= ?");
        params.push(options.since);
      }
      if (options.until) {
        tagConditions.push("d.source_mtime <= ?");
        params.push(options.until);
      }
      if (options.categories && options.categories.length > 0) {
        const placeholders = options.categories.map(() => "?").join(",");
        tagConditions.push(
          `(d.content_type IN (${placeholders}) OR EXISTS (SELECT 1 FROM json_each(COALESCE(d.categories, '[]')) jc WHERE jc.value IN (${placeholders})))`
        );
        params.push(...options.categories, ...options.categories);
      }
      if (options.author) {
        tagConditions.push("LOWER(COALESCE(d.author, '')) LIKE ?");
        params.push(`%${options.author.toLowerCase()}%`);
      }

      if (options.collection) {
        params.push(options.collection);
      }

      const hasOuterFilters =
        tagConditions.length > 0 || Boolean(options.collection);
      const ftsLimit = hasOuterFilters ? limit * 10 : limit;
      params.push(limit);

      // Document-level FTS search using an FTS-first CTE to keep collection and
      // metadata filters from degrading the query plan into a broad scan.
      const sql = `
        WITH fts_matches AS (
          SELECT
            rowid,
            ${options.snippet ? "snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet," : ""}
            bm25(
              documents_fts,
              ${FTS5_FIELD_WEIGHTS.filepath},
              ${FTS5_FIELD_WEIGHTS.title},
              ${FTS5_FIELD_WEIGHTS.body}
            ) as score
          FROM documents_fts
          WHERE documents_fts MATCH ?
          ORDER BY score
          LIMIT ?
        )
        SELECT
          d.mirror_hash,
          0 as seq,
          fm.score as score,
          ${options.snippet ? "fm.snippet as snippet," : ""}
          d.docid,
          d.uri,
          d.title,
          d.collection,
          d.rel_path,
          d.source_mime,
          d.source_ext,
          d.source_mtime,
          d.frontmatter_date,
          d.source_size,
          d.source_hash
        FROM fts_matches fm
        JOIN documents d ON d.id = fm.rowid AND d.active = 1
        WHERE 1 = 1
        ${tagConditions.length > 0 ? `AND ${tagConditions.join(" AND ")}` : ""}
        ${options.collection ? "AND d.collection = ?" : ""}
        ORDER BY fm.score
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
        frontmatter_date: string | null;
        source_size: number | null;
        source_hash: string | null;
      }

      const queryParams = [builtQuery.query, ftsLimit, ...params];
      const rows = db
        .query<FtsRow, (string | number)[]>(sql)
        .all(...queryParams);

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
          frontmatterDate: r.frontmatter_date ?? undefined,
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
  // Links
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set links for a document.
   * Replaces links from the given source (parsed, user, or suggested).
   */
  async setDocLinks(
    documentId: number,
    links: DocLinkInput[],
    source: DocLinkSource
  ): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Delete existing links from this source
        db.run("DELETE FROM doc_links WHERE source_doc_id = ? AND source = ?", [
          documentId,
          source,
        ]);

        // Insert new links
        if (links.length > 0) {
          const stmt = db.prepare(`
            INSERT INTO doc_links (
              source_doc_id, target_ref, target_ref_norm, target_anchor,
              target_collection, link_type, link_text,
              start_line, start_col, end_line, end_col, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const link of links) {
            // Normalize empty string targetCollection to NULL for consistent semantics
            // NULL = "same collection as source doc"
            const normalizedTargetCollection = link.targetCollection?.trim()
              ? link.targetCollection.trim()
              : null;

            stmt.run(
              documentId,
              link.targetRef,
              link.targetRefNorm,
              link.targetAnchor ?? null,
              normalizedTargetCollection,
              link.linkType,
              link.linkText ?? null,
              link.startLine,
              link.startCol,
              link.endLine,
              link.endCol,
              source
            );
          }
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to set document links",
        cause
      );
    }
  }

  /**
   * Get all outgoing links for a document.
   */
  async getLinksForDoc(documentId: number): Promise<StoreResult<DocLinkRow[]>> {
    try {
      const db = this.ensureOpen();

      interface DbDocLinkRow {
        target_ref: string;
        target_ref_norm: string;
        target_anchor: string | null;
        target_collection: string | null;
        link_type: "wiki" | "markdown";
        link_text: string | null;
        start_line: number;
        start_col: number;
        end_line: number;
        end_col: number;
        source: "parsed" | "user" | "suggested";
      }

      const rows = db
        .query<DbDocLinkRow, [number]>(
          `SELECT target_ref, target_ref_norm, target_anchor, target_collection,
                  link_type, link_text, start_line, start_col, end_line, end_col, source
           FROM doc_links
           WHERE source_doc_id = ?
           ORDER BY start_line, start_col`
        )
        .all(documentId);

      return ok(
        rows.map((r) => ({
          targetRef: r.target_ref,
          targetRefNorm: r.target_ref_norm,
          targetAnchor: r.target_anchor,
          targetCollection: r.target_collection,
          linkType: r.link_type,
          linkText: r.link_text,
          startLine: r.start_line,
          startCol: r.start_col,
          endLine: r.end_line,
          endCol: r.end_col,
          source: r.source,
        }))
      );
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get links for document",
        cause
      );
    }
  }

  /**
   * Get backlinks pointing to a document.
   * Uses target_ref_norm for matching (wiki=normalized title with path fallbacks, markdown=rel_path).
   * Only returns links from active source documents.
   */
  async getBacklinksForDoc(
    documentId: number,
    options?: { collection?: string }
  ): Promise<StoreResult<BacklinkRow[]>> {
    try {
      const db = this.ensureOpen();

      // Get target document
      const target = db
        .query<
          { title: string | null; rel_path: string; collection: string },
          [number]
        >(
          "SELECT title, rel_path, collection FROM documents WHERE id = ? AND active = 1"
        )
        .get(documentId);

      if (!target) {
        return ok([]);
      }

      // Compute normalized wiki keys for fallback matching
      const keySet = new Set<string>();
      const addKey = (value: string): void => {
        if (value) {
          keySet.add(value);
        }
      };
      const addVariants = (value: string): void => {
        if (!value) return;
        const base = stripWikiMdExt(value);
        const md = `${base}.md`;
        addKey(value);
        addKey(base);
        addKey(md);
      };
      const addVariantsWithBasename = (value: string): void => {
        if (!value) return;
        addVariants(value);
        const basename = value.split("/").pop() ?? value;
        if (basename !== value) {
          addVariants(basename);
        }
      };

      const titleKey = normalizeWikiName(target.title ?? "");
      addVariants(titleKey);

      const relPathKey = normalizeWikiName(target.rel_path);
      addVariantsWithBasename(relPathKey);

      interface DbBacklinkRow {
        source_doc_id: number;
        docid: string;
        uri: string;
        title: string | null;
        link_text: string | null;
        start_line: number;
        start_col: number;
      }

      const targetCollection = target.collection;
      const sourceCollectionFilter = options?.collection;

      // Query wiki backlinks (link_type='wiki') with path-style fallbacks
      // NULL target_collection means "same collection as source" - enforce this in SQL
      const wikiConditions: string[] = [];
      const wikiParams: string[] = [];

      const addWikiExact = (value: string): void => {
        wikiConditions.push("dl.target_ref_norm = ?");
        wikiParams.push(value);
      };

      const addWikiSuffix = (value: string): void => {
        wikiConditions.push(
          `(substr(dl.target_ref_norm, -length(?)) = ?
            AND (length(dl.target_ref_norm) = length(?)
              OR substr(dl.target_ref_norm, -length(?) - 1, 1) = '/'))`
        );
        wikiParams.push(value, value, value, value);
      };

      for (const key of keySet) {
        addWikiExact(key);
        addWikiSuffix(key);
      }

      const wikiBacklinks =
        wikiConditions.length > 0
          ? db
              .query<DbBacklinkRow, string[]>(
                `SELECT dl.source_doc_id, src.docid, src.uri, src.title, dl.link_text, dl.start_line, dl.start_col
                 FROM doc_links dl
                 JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
                 WHERE dl.link_type = 'wiki'
                   AND (${wikiConditions.join(" OR ")})
                   AND (
                     (dl.target_collection IS NULL AND src.collection = ?)
                     OR dl.target_collection = ?
                   )
                   ${sourceCollectionFilter ? "AND src.collection = ?" : ""}
                 ORDER BY src.uri, dl.start_line, dl.start_col`
              )
              .all(
                ...wikiParams,
                targetCollection,
                targetCollection,
                ...(sourceCollectionFilter ? [sourceCollectionFilter] : [])
              )
          : [];

      // Query markdown backlinks (link_type='markdown')
      // NULL target_collection means "same collection as source" - enforce this in SQL
      const mdBacklinks = db
        .query<DbBacklinkRow, string[]>(
          `SELECT dl.source_doc_id, src.docid, src.uri, src.title, dl.link_text, dl.start_line, dl.start_col
           FROM doc_links dl
           JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
           WHERE dl.link_type = 'markdown'
             AND dl.target_ref_norm = ?
             AND (
               (dl.target_collection IS NULL AND src.collection = ?)
               OR dl.target_collection = ?
             )
             ${sourceCollectionFilter ? "AND src.collection = ?" : ""}
           ORDER BY src.uri, dl.start_line, dl.start_col`
        )
        .all(
          target.rel_path,
          targetCollection,
          targetCollection,
          ...(sourceCollectionFilter ? [sourceCollectionFilter] : [])
        );

      const allBacklinks = [...wikiBacklinks, ...mdBacklinks].map((r) => ({
        sourceDocId: r.source_doc_id,
        sourceDocid: r.docid,
        sourceDocUri: r.uri,
        sourceDocTitle: r.title,
        linkText: r.link_text,
        startLine: r.start_line,
        startCol: r.start_col,
      }));

      return ok(allBacklinks);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to get backlinks for document",
        cause
      );
    }
  }

  async resolveLinks(
    targets: Array<{
      targetRefNorm: string;
      targetCollection: string;
      linkType: "wiki" | "markdown";
    }>
  ): Promise<
    StoreResult<
      Array<{ docid: string; uri: string; title: string | null } | null>
    >
  > {
    try {
      const db = this.ensureOpen();

      const results: Array<{
        docid: string;
        uri: string;
        title: string | null;
      } | null> = Array.from({ length: targets.length }, () => null);

      const wikiTargets: Array<{
        idx: number;
        collection: string;
        baseRef: string;
        baseRefMd: string;
      }> = [];
      const mdTargets: Array<{
        idx: number;
        collection: string;
        relPath: string;
      }> = [];

      for (const [idx, target] of targets.entries()) {
        if (target.linkType === "wiki") {
          const baseRef = stripWikiMdExt(target.targetRefNorm);
          wikiTargets.push({
            idx,
            collection: target.targetCollection,
            baseRef,
            baseRefMd: `${baseRef}.md`,
          });
        } else {
          mdTargets.push({
            idx,
            collection: target.targetCollection,
            relPath: target.targetRefNorm,
          });
        }
      }

      const chunkArray = <T>(items: T[], chunkSize: number): T[][] => {
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += chunkSize) {
          chunks.push(items.slice(i, i + chunkSize));
        }
        return chunks;
      };

      const MAX_SQL_PARAMS = 900;
      const wikiBatchSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / 4));
      const mdBatchSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / 3));

      const titleExpr = "lower(trim(d.title))";
      const relExpr = "lower(d.rel_path)";
      const suffixMatchExprExpr = (
        targetExpr: string,
        valueExpr: string
      ): string =>
        `(substr(${targetExpr}, -length(${valueExpr})) = ${valueExpr}
          AND (length(${targetExpr}) = length(${valueExpr})
            OR substr(${targetExpr}, -length(${valueExpr}) - 1, 1) = '/'))`;

      if (wikiTargets.length > 0) {
        for (const batch of chunkArray(wikiTargets, wikiBatchSize)) {
          const valuesClause = batch.map(() => "(?, ?, ?, ?)").join(", ");
          const wikiParams = batch.flatMap((t) => [
            t.idx,
            t.collection,
            t.baseRef,
            t.baseRefMd,
          ]);

          const baseRefExpr = "t.base_ref";
          const baseRefMdExpr = "t.base_ref_md";
          const wikiWhere = `
            ${titleExpr} = ${baseRefExpr}
            OR ${titleExpr} = ${baseRefMdExpr}
            OR ${suffixMatchExprExpr(baseRefExpr, titleExpr)}
            OR ${suffixMatchExprExpr(baseRefMdExpr, `${titleExpr} || '.md'`)}
            OR ${relExpr} = ${baseRefExpr}
            OR ${relExpr} = ${baseRefMdExpr}
            OR ${suffixMatchExprExpr(relExpr, baseRefMdExpr)}
            OR ${suffixMatchExprExpr(relExpr, baseRefExpr)}
            OR ${suffixMatchExprExpr(baseRefMdExpr, relExpr)}
            OR ${suffixMatchExprExpr(baseRefExpr, relExpr)}
          `;

          const wikiRank = `CASE
            WHEN ${titleExpr} = ${baseRefExpr} THEN 1
            WHEN ${titleExpr} = ${baseRefMdExpr} THEN 2
            WHEN ${suffixMatchExprExpr(baseRefExpr, titleExpr)} THEN 3
            WHEN ${suffixMatchExprExpr(
              baseRefMdExpr,
              `${titleExpr} || '.md'`
            )} THEN 4
            WHEN ${relExpr} = ${baseRefExpr} THEN 5
            WHEN ${relExpr} = ${baseRefMdExpr} THEN 6
            WHEN ${suffixMatchExprExpr(relExpr, baseRefMdExpr)} THEN 7
            WHEN ${suffixMatchExprExpr(relExpr, baseRefExpr)} THEN 8
            WHEN ${suffixMatchExprExpr(baseRefMdExpr, relExpr)} THEN 9
            WHEN ${suffixMatchExprExpr(baseRefExpr, relExpr)} THEN 10
            ELSE 99
          END`;

          const wikiQuery = `
            WITH targets(idx, collection, base_ref, base_ref_md) AS (
              VALUES ${valuesClause}
            ),
            candidates AS (
              SELECT
                t.idx,
                d.docid,
                d.uri,
                d.title,
                d.id as doc_id,
                ${wikiRank} as rank
              FROM targets t
              JOIN documents d ON d.active = 1 AND d.collection = t.collection
              WHERE ${wikiWhere}
            ),
            ranked AS (
              SELECT *,
                ROW_NUMBER() OVER (PARTITION BY idx ORDER BY rank, doc_id) as rn
              FROM candidates
            )
            SELECT idx, docid, uri, title
            FROM ranked
            WHERE rn = 1
          `;

          const wikiRows = db
            .query<
              { idx: number; docid: string; uri: string; title: string | null },
              (string | number)[]
            >(wikiQuery)
            .all(...wikiParams);

          for (const row of wikiRows) {
            results[row.idx] = {
              docid: row.docid,
              uri: row.uri,
              title: row.title,
            };
          }
        }
      }

      if (mdTargets.length > 0) {
        for (const batch of chunkArray(mdTargets, mdBatchSize)) {
          const valuesClause = batch.map(() => "(?, ?, ?)").join(", ");
          const mdParams = batch.flatMap((t) => [
            t.idx,
            t.collection,
            t.relPath,
          ]);
          const mdQuery = `
            WITH targets(idx, collection, rel_path) AS (
              VALUES ${valuesClause}
            ),
            ranked AS (
              SELECT
                t.idx,
                d.docid,
                d.uri,
                d.title,
                d.id as doc_id,
                ROW_NUMBER() OVER (PARTITION BY t.idx ORDER BY d.id) as rn
              FROM targets t
              JOIN documents d ON d.active = 1
                AND d.collection = t.collection
                AND d.rel_path = t.rel_path
            )
            SELECT idx, docid, uri, title
            FROM ranked
            WHERE rn = 1
          `;

          const mdRows = db
            .query<
              { idx: number; docid: string; uri: string; title: string | null },
              (string | number)[]
            >(mdQuery)
            .all(...mdParams);

          for (const row of mdRows) {
            results[row.idx] = {
              docid: row.docid,
              uri: row.uri,
              title: row.title,
            };
          }
        }
      }

      return ok(results);
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to resolve links",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Graph
  // ─────────────────────────────────────────────────────────────────────────

  async getGraph(options?: GetGraphOptions): Promise<StoreResult<GraphResult>> {
    try {
      const db = this.ensureOpen();

      // Apply defaults
      const collection = options?.collection ?? null;
      // Clamp all limits defensively (store is last line of defense)
      const limitNodes = Math.max(
        1,
        Math.min(5000, options?.limitNodes ?? 2000)
      );
      const limitEdges = Math.max(
        1,
        Math.min(50000, options?.limitEdges ?? 10000)
      );
      const includeSimilar = options?.includeSimilar ?? false;
      const threshold = Math.max(0, Math.min(1, options?.threshold ?? 0.7));
      const linkedOnly = options?.linkedOnly ?? true;
      const similarTopK = Math.max(1, Math.min(20, options?.similarTopK ?? 5));

      const warnings: string[] = [];

      // Always probe sqlite-vec availability (not just when similarity requested)
      let similarAvailable = false;
      try {
        db.query("SELECT vec_version()").get();
        similarAvailable = true;
      } catch {
        // sqlite-vec not loaded
      }

      const wikiTitleExpr = (alias: string): string =>
        `lower(trim(${alias}.title))`;

      const wikiRelPathExpr = (alias: string): string =>
        `lower(${alias}.rel_path)`;

      const suffixMatch = (targetExpr: string, valueExpr: string): string =>
        `(substr(${targetExpr}, -length(${valueExpr})) = ${valueExpr}
          AND (length(${targetExpr}) = length(${valueExpr})
            OR substr(${targetExpr}, -length(${valueExpr}) - 1, 1) = '/'))`;

      const wikiMatch = (alias: string, targetRefExpr: string): string => {
        const titleExpr = wikiTitleExpr(alias);
        const relExpr = wikiRelPathExpr(alias);
        const targetBaseExpr = `CASE
          WHEN ${targetRefExpr} LIKE '%.md' THEN substr(${targetRefExpr}, 1, length(${targetRefExpr}) - 3)
          ELSE ${targetRefExpr}
        END`;
        const targetMdExpr = `${targetBaseExpr} || '.md'`;
        return `(
          ${titleExpr} = ${targetBaseExpr}
          OR ${titleExpr} = ${targetMdExpr}
          OR ${suffixMatch(targetBaseExpr, titleExpr)}
          OR ${suffixMatch(targetMdExpr, `${titleExpr} || '.md'`)}
          OR ${relExpr} = ${targetBaseExpr}
          OR ${relExpr} = ${targetMdExpr}
          OR ${suffixMatch(relExpr, targetMdExpr)}
          OR ${suffixMatch(relExpr, targetBaseExpr)}
          OR ${suffixMatch(targetMdExpr, relExpr)}
          OR ${suffixMatch(targetBaseExpr, relExpr)}
        )`;
      };

      const wikiOrder = (alias: string, targetRefExpr: string): string => {
        const titleExpr = wikiTitleExpr(alias);
        const relExpr = wikiRelPathExpr(alias);
        const targetBaseExpr = `CASE
          WHEN ${targetRefExpr} LIKE '%.md' THEN substr(${targetRefExpr}, 1, length(${targetRefExpr}) - 3)
          ELSE ${targetRefExpr}
        END`;
        const targetMdExpr = `${targetBaseExpr} || '.md'`;
        return `CASE
          WHEN ${titleExpr} = ${targetBaseExpr} THEN 1
          WHEN ${titleExpr} = ${targetMdExpr} THEN 2
          WHEN ${suffixMatch(targetBaseExpr, titleExpr)} THEN 3
          WHEN ${suffixMatch(targetMdExpr, `${titleExpr} || '.md'`)} THEN 4
          WHEN ${relExpr} = ${targetBaseExpr} THEN 5
          WHEN ${relExpr} = ${targetMdExpr} THEN 6
          WHEN ${suffixMatch(relExpr, targetMdExpr)} THEN 7
          WHEN ${suffixMatch(relExpr, targetBaseExpr)} THEN 8
          WHEN ${suffixMatch(targetMdExpr, relExpr)} THEN 9
          WHEN ${suffixMatch(targetBaseExpr, relExpr)} THEN 10
          ELSE 11
        END`;
      };

      const wikiBestMatch = (
        collectionExpr: string,
        targetRefExpr: string
      ): string => `
        SELECT t.id FROM documents t
        WHERE t.active = 1
          AND t.collection = ${collectionExpr}
          AND ${wikiMatch("t", targetRefExpr)}
          AND ${wikiOrder("t", targetRefExpr)} = (
            SELECT MIN(${wikiOrder("t2", targetRefExpr)}) FROM documents t2
            WHERE t2.active = 1
              AND t2.collection = ${collectionExpr}
              AND ${wikiMatch("t2", targetRefExpr)}
          )
        ORDER BY t.id LIMIT 1
      `;
      interface ResolvedEdgeRow {
        source_id: number;
        source_docid: string;
        target_id: number;
        target_docid: string;
        link_type: "wiki" | "markdown";
        weight: number;
      }

      interface UnresolvedCountRow {
        unresolved: number | null;
      }

      interface NodeMetaRow {
        id: number;
        docid: string;
        uri: string;
        title: string | null;
        collection: string;
        rel_path: string;
      }

      const edgeParams: string[] = [];
      let edgeCollectionClause = "";
      if (collection) {
        edgeCollectionClause = "AND src.collection = ? AND tgt.collection = ?";
        edgeParams.push(collection, collection);
      }

      const resolvedEdgeQuery = `
        SELECT
          src.id as source_id,
          src.docid as source_docid,
          tgt.id as target_id,
          tgt.docid as target_docid,
          dl.link_type,
          COUNT(*) as weight
        FROM documents src
        JOIN doc_links dl ON dl.source_doc_id = src.id
        JOIN documents tgt ON tgt.id = CASE dl.link_type
          WHEN 'wiki' THEN (${wikiBestMatch(
            "COALESCE(dl.target_collection, src.collection)",
            "dl.target_ref_norm"
          )})
          WHEN 'markdown' THEN (
            SELECT md.id FROM documents md
            WHERE md.active = 1
              AND md.collection = COALESCE(dl.target_collection, src.collection)
              AND md.rel_path = dl.target_ref_norm
            ORDER BY md.id LIMIT 1
          )
        END
        WHERE src.active = 1 AND tgt.active = 1
          ${edgeCollectionClause}
        GROUP BY src.id, src.docid, tgt.id, tgt.docid, dl.link_type
        ORDER BY weight DESC, src.id ASC, tgt.id ASC
      `;

      const resolvedEdgeRows = db
        .query<ResolvedEdgeRow, string[]>(resolvedEdgeQuery)
        .all(...edgeParams);

      const unresolvedParams: string[] = [];
      let unresolvedCollectionClause = "";
      if (collection) {
        unresolvedCollectionClause = "AND src.collection = ?";
        unresolvedParams.push(collection);
      }
      const unresolvedQuery = `
        SELECT
          SUM(CASE WHEN target_id IS NULL THEN 1 ELSE 0 END) as unresolved
        FROM (
          SELECT
            CASE dl.link_type
              WHEN 'wiki' THEN (
                ${wikiBestMatch(
                  "COALESCE(dl.target_collection, src.collection)",
                  "dl.target_ref_norm"
                )}
              )
              WHEN 'markdown' THEN (
                SELECT t.id FROM documents t
                WHERE t.active = 1
                  AND t.collection = COALESCE(dl.target_collection, src.collection)
                  AND t.rel_path = dl.target_ref_norm
                ORDER BY t.id LIMIT 1
              )
            END as target_id
          FROM documents src
          JOIN doc_links dl ON dl.source_doc_id = src.id
          WHERE src.active = 1
            ${unresolvedCollectionClause}
        )
      `;
      const unresolvedRow = db
        .query<UnresolvedCountRow, string[]>(unresolvedQuery)
        .get(...unresolvedParams);
      const totalEdgesUnresolved = unresolvedRow?.unresolved ?? 0;

      const outNeighbors = new Map<number, Set<number>>();
      const inNeighbors = new Map<number, Set<number>>();
      const connectedNodeIds = new Set<number>();

      for (const row of resolvedEdgeRows) {
        connectedNodeIds.add(row.source_id);
        connectedNodeIds.add(row.target_id);

        const sourceSet = outNeighbors.get(row.source_id) ?? new Set<number>();
        sourceSet.add(row.target_id);
        outNeighbors.set(row.source_id, sourceSet);

        const targetSet = inNeighbors.get(row.target_id) ?? new Set<number>();
        targetSet.add(row.source_id);
        inNeighbors.set(row.target_id, targetSet);
      }

      const connectedIdList = [...connectedNodeIds].sort((a, b) => a - b);
      const connectedMetaMap = new Map<number, NodeMetaRow>();
      if (connectedIdList.length > 0) {
        const placeholders = connectedIdList.map(() => "?").join(",");
        const connectedRows = db
          .query<NodeMetaRow, number[]>(
            `SELECT id, docid, uri, title, collection, rel_path
             FROM documents
             WHERE id IN (${placeholders})`
          )
          .all(...connectedIdList);
        for (const row of connectedRows) {
          connectedMetaMap.set(row.id, row);
        }
      }

      const connectedNodes = connectedIdList
        .map((id) => {
          const meta = connectedMetaMap.get(id);
          if (!meta) {
            return null;
          }
          return {
            ...meta,
            degree:
              (outNeighbors.get(id)?.size ?? 0) +
              (inNeighbors.get(id)?.size ?? 0),
          };
        })
        .filter((row): row is NodeMetaRow & { degree: number } => row !== null)
        .sort((a, b) => b.degree - a.degree || a.id - b.id);

      let totalNodes = linkedOnly ? connectedNodes.length : 0;
      if (!linkedOnly) {
        const countParams: string[] = [];
        let countClause = "";
        if (collection) {
          countClause = "WHERE active = 1 AND collection = ?";
          countParams.push(collection);
        } else {
          countClause = "WHERE active = 1";
        }
        const countRow = db
          .query<{ cnt: number }, string[]>(
            `SELECT COUNT(*) as cnt FROM documents ${countClause}`
          )
          .get(...countParams);
        totalNodes = countRow?.cnt ?? connectedNodes.length;
      }

      const selectedNodeRows = [...connectedNodes];
      if (!linkedOnly && selectedNodeRows.length < limitNodes) {
        const remaining = limitNodes - selectedNodeRows.length;
        const excluded = selectedNodeRows.map((row) => row.id);
        const isolatedParams: (string | number)[] = [];
        const conditions = ["active = 1"];
        if (collection) {
          conditions.push("collection = ?");
          isolatedParams.push(collection);
        }
        if (excluded.length > 0) {
          const placeholders = excluded.map(() => "?").join(",");
          conditions.push(`id NOT IN (${placeholders})`);
          isolatedParams.push(...excluded);
        }
        isolatedParams.push(remaining);

        const isolatedRows = db
          .query<NodeMetaRow, (string | number)[]>(
            `SELECT id, docid, uri, title, collection, rel_path
             FROM documents
             WHERE ${conditions.join(" AND ")}
             ORDER BY id ASC
             LIMIT ?`
          )
          .all(...isolatedParams)
          .map((row) => ({ ...row, degree: 0 }));
        selectedNodeRows.push(...isolatedRows);
      }

      const nodes = selectedNodeRows.slice(0, limitNodes).map((row) => ({
        id: row.docid,
        uri: row.uri,
        title: row.title,
        collection: row.collection,
        relPath: row.rel_path,
        degree: row.degree,
      }));

      const truncatedNodes = totalNodes > nodes.length;
      const selectedDocids = new Set(nodes.map((node) => node.id));
      const nodeDocids = new Set(nodes.map((node) => node.id));

      const edgeMap = new Map<
        string,
        { type: "wiki" | "markdown" | "similar"; weight: number }
      >();
      for (const row of resolvedEdgeRows) {
        if (
          !selectedDocids.has(row.source_docid) ||
          !selectedDocids.has(row.target_docid)
        ) {
          continue;
        }
        const key = `${row.source_docid}:${row.target_docid}:${row.link_type}`;
        edgeMap.set(key, { type: row.link_type, weight: row.weight });
      }

      // Phase 3: Similarity edges (if requested)
      let similarTruncatedByComputeBudget = false;

      if (includeSimilar && nodeDocids.size > 0 && similarAvailable) {
        // Cap similarity work to avoid blocking the server event loop
        const SIMILARITY_NODE_CAP = 200;
        const nodesForSimilarity = [...nodeDocids].slice(
          0,
          SIMILARITY_NODE_CAP
        );
        if (nodeDocids.size > SIMILARITY_NODE_CAP) {
          similarTruncatedByComputeBudget = true;
          warnings.push(
            `Similarity capped at ${SIMILARITY_NODE_CAP} nodes (requested ${nodeDocids.size})`
          );
        }

        // Track if any similarity queries fail
        let similarityFailures = 0;

        const mirrorByDocid = new Map<string, string>();
        if (nodesForSimilarity.length > 0) {
          const placeholders = nodesForSimilarity.map(() => "?").join(",");
          const mirrorRows = db
            .query<{ docid: string; mirror_hash: string }, string[]>(
              `SELECT docid, mirror_hash
               FROM documents
               WHERE active = 1
                 AND docid IN (${placeholders})`
            )
            .all(...nodesForSimilarity);
          for (const row of mirrorRows) {
            if (row.mirror_hash) {
              mirrorByDocid.set(row.docid, row.mirror_hash);
            }
          }
        }
        const allowedMirrorHashes = [...mirrorByDocid.values()];
        if (allowedMirrorHashes.length === 0) {
          warnings.push("Similarity unavailable: no embedded nodes in graph");
        }
        const allowedPlaceholders = allowedMirrorHashes
          .map(() => "?")
          .join(",");

        // Get kNN for each node
        // Query content_vectors for embedded chunks, find similar
        for (const docid of nodesForSimilarity) {
          if (allowedMirrorHashes.length === 0) break;
          const mirrorHash = mirrorByDocid.get(docid);
          if (!mirrorHash) continue;

          // Find similar docs using vec_distance, aggregate by doc to get max score
          interface SimilarRow {
            target_docid: string;
            score: number;
          }

          // Use GROUP BY to get one best score per doc (avoids duplicate rows from multi-chunk docs)
          const similarQuery = `
            SELECT
              d.docid as target_docid,
              MAX(1 - vec_distance_cosine(v1.embedding, v2.embedding)) as score
            FROM content_vectors v1
            JOIN content_vectors v2 ON v2.model = v1.model
              AND v2.mirror_hash != v1.mirror_hash
              AND v2.seq = 0
            JOIN documents d ON d.mirror_hash = v2.mirror_hash AND d.active = 1
            WHERE v1.mirror_hash = ? AND v1.seq = 0
              AND d.docid != ?
              AND v2.mirror_hash IN (${allowedPlaceholders})
            GROUP BY d.docid
            HAVING score >= ?
            ORDER BY score DESC
            LIMIT ?
          `;

          try {
            const similarRows = db
              .query<SimilarRow, (string | number)[]>(similarQuery)
              .all(
                mirrorHash,
                docid,
                ...allowedMirrorHashes,
                threshold,
                similarTopK
              );

            for (const sim of similarRows) {
              if (!nodeDocids.has(sim.target_docid)) continue;

              // Clamp score to [0, 1] for schema compliance
              const clampedScore = Math.max(0, Math.min(1, sim.score));

              // Canonicalize by lexicographic order (undirected edge)
              const [a, b] =
                docid < sim.target_docid
                  ? [docid, sim.target_docid]
                  : [sim.target_docid, docid];
              const key = `${a}:${b}:similar`;

              // Keep max score
              const existing = edgeMap.get(key);
              if (!existing || clampedScore > existing.weight) {
                edgeMap.set(key, { type: "similar", weight: clampedScore });
              }
            }
          } catch {
            similarityFailures++;
          }
        }

        // Report partial failures
        if (similarityFailures > 0) {
          warnings.push(
            `Similarity query failed for ${similarityFailures} nodes; results may be incomplete`
          );
        }
      } else if (includeSimilar && !similarAvailable) {
        warnings.push("Similarity edges unavailable: sqlite-vec not loaded");
      }

      // Convert edge map to array, apply limit
      const allEdges = [...edgeMap.entries()].map(([key, val]) => {
        const parts = key.split(":");
        return {
          source: parts[0] ?? "",
          target: parts[1] ?? "",
          type: val.type,
          weight: val.weight,
        };
      });

      const truncatedEdges = allEdges.length > limitEdges;
      const links = allEdges.slice(0, limitEdges);

      // Add truncation warnings
      if (truncatedNodes) {
        warnings.push(`Nodes truncated: ${totalNodes} → ${limitNodes}`);
      }
      if (truncatedEdges) {
        warnings.push(`Edges truncated: ${allEdges.length} → ${limitEdges}`);
      }

      return ok({
        nodes,
        links,
        meta: {
          collection,
          nodeLimit: limitNodes,
          edgeLimit: limitEdges,
          totalNodes,
          // totalEdges = collapsed edge count within selected nodes (matches allEdges)
          totalEdges: allEdges.length,
          totalEdgesUnresolved,
          returnedNodes: nodes.length,
          returnedEdges: links.length,
          truncated: truncatedNodes || truncatedEdges,
          linkedOnly,
          includedSimilar: includeSimilar && similarAvailable,
          similarAvailable,
          similarTopK,
          similarTruncatedByComputeBudget,
          warnings,
        },
      });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : "Failed to get graph",
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status
  // ─────────────────────────────────────────────────────────────────────────

  async getStatus(options?: {
    embedModel?: string;
  }): Promise<StoreResult<IndexStatus>> {
    try {
      const db = this.ensureOpen();
      const embedModel = options?.embedModel ?? null;

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
        .query<CollectionStat, [string | null, string | null]>(
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
            (SELECT COUNT(*) FROM content_chunks cc
             WHERE EXISTS (
               SELECT 1 FROM documents d3
               WHERE d3.collection = c.name
                 AND d3.active = 1
                 AND d3.mirror_hash = cc.mirror_hash
             )
             AND EXISTS (
               SELECT 1 FROM content_vectors cv
               WHERE cv.mirror_hash = cc.mirror_hash
                 AND cv.seq = cc.seq
                 AND (? IS NULL OR cv.model = ?)
                 AND cv.embedded_at >= cc.created_at
             )) as embedded_count
          FROM collections c
          LEFT JOIN documents d ON d.collection = c.name
          GROUP BY c.name, c.path
        `
        )
        .all(embedModel, embedModel);

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
        .query<{ count: number }, [string | null, string | null]>(
          `
          SELECT COUNT(*) as count FROM content_chunks c
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors v
            WHERE v.mirror_hash = c.mirror_hash
              AND v.seq = c.seq
              AND (? IS NULL OR v.model = ?)
              AND v.embedded_at >= c.created_at
          )
        `
        )
        .get(embedModel, embedModel);

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

  async clearEmbeddingsForCollection(
    collection: string,
    options: { mode: "stale" | "all"; activeModel?: string }
  ): Promise<StoreResult<EmbeddingCleanupStats>> {
    try {
      const db = this.ensureOpen();
      const collectionName = collection.toLowerCase();

      if (options.mode === "stale" && !options.activeModel) {
        return err(
          "INVALID_INPUT",
          "activeModel is required for stale embedding cleanup"
        );
      }

      const filterSql = options.mode === "stale" ? "AND cv.model != ?" : "";
      const filterParams =
        options.mode === "stale" ? [options.activeModel ?? ""] : [];

      const deletableRows = db
        .query<{ mirror_hash: string; model: string; seq: number }, string[]>(
          `
          SELECT DISTINCT cv.mirror_hash, cv.seq, cv.model
          FROM content_vectors cv
          WHERE EXISTS (
            SELECT 1 FROM documents d
            WHERE d.collection = ?
              AND d.mirror_hash = cv.mirror_hash
          )
          ${filterSql}
          AND NOT EXISTS (
            SELECT 1 FROM documents d2
            WHERE d2.mirror_hash = cv.mirror_hash
              AND d2.collection != ?
              AND d2.active = 1
          )
        `
        )
        .all(collectionName, ...filterParams, collectionName);

      const protectedRow = db
        .query<{ count: number }, string[]>(
          `
          SELECT COUNT(*) as count
          FROM (
            SELECT DISTINCT cv.mirror_hash, cv.seq, cv.model
            FROM content_vectors cv
            WHERE EXISTS (
              SELECT 1 FROM documents d
              WHERE d.collection = ?
                AND d.mirror_hash = cv.mirror_hash
            )
            ${filterSql}
            AND EXISTS (
              SELECT 1 FROM documents d2
              WHERE d2.mirror_hash = cv.mirror_hash
                AND d2.collection != ?
                AND d2.active = 1
            )
          )
        `
        )
        .get(collectionName, ...filterParams, collectionName);

      const deletedModels = [...new Set(deletableRows.map((row) => row.model))];

      const transaction = db.transaction(() => {
        const deleteVectorStmt = db.prepare(
          `DELETE FROM content_vectors WHERE mirror_hash = ? AND seq = ? AND model = ?`
        );
        const vecDeleteStatements = new Map<
          string,
          ReturnType<typeof db.prepare> | null
        >();

        for (const row of deletableRows) {
          deleteVectorStmt.run(row.mirror_hash, row.seq, row.model);

          let deleteVecStmt = vecDeleteStatements.get(row.model);
          if (deleteVecStmt === undefined) {
            try {
              deleteVecStmt = db.prepare(
                `DELETE FROM ${modelTableName(row.model)} WHERE chunk_id = ?`
              );
            } catch {
              deleteVecStmt = null;
            }
            vecDeleteStatements.set(row.model, deleteVecStmt);
          }

          if (deleteVecStmt) {
            try {
              deleteVecStmt.run(`${row.mirror_hash}:${row.seq}`);
            } catch {
              // Best effort; a later vec sync/rebuild can recover.
            }
          }
        }
      });

      transaction();

      return ok({
        collection: collectionName,
        deletedVectors: deletableRows.length,
        deletedModels,
        mode: options.mode,
        protectedSharedVectors: protectedRow?.count ?? 0,
      });
    } catch (cause) {
      return err(
        "QUERY_FAILED",
        cause instanceof Error
          ? cause.message
          : "Failed to clear collection embeddings",
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
  source_ctime: string | null;
  docid: string;
  uri: string;
  title: string | null;
  mirror_hash: string | null;
  converter_id: string | null;
  converter_version: string | null;
  language_hint: string | null;
  content_type: string | null;
  categories: string | null;
  author: string | null;
  frontmatter_date: string | null;
  date_fields: string | null;
  indexed_at: string | null;
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
  let categories: string[] | null = null;
  if (row.categories) {
    try {
      const parsed = JSON.parse(row.categories);
      if (Array.isArray(parsed)) {
        categories = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      categories = null;
    }
  }

  let dateFields: Record<string, string> | null = null;
  if (row.date_fields) {
    try {
      const parsed = JSON.parse(row.date_fields);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            normalized[key] = value;
          }
        }
        if (Object.keys(normalized).length > 0) {
          dateFields = normalized;
        }
      }
    } catch {
      dateFields = null;
    }
  }

  return {
    id: row.id,
    collection: row.collection,
    relPath: row.rel_path,
    sourceHash: row.source_hash,
    sourceMime: row.source_mime,
    sourceExt: row.source_ext,
    sourceSize: row.source_size,
    sourceMtime: row.source_mtime,
    sourceCtime: row.source_ctime,
    docid: row.docid,
    uri: row.uri,
    title: row.title,
    mirrorHash: row.mirror_hash,
    converterId: row.converter_id,
    converterVersion: row.converter_version,
    languageHint: row.language_hint,
    contentType: row.content_type,
    categories,
    author: row.author,
    frontmatterDate: row.frontmatter_date,
    dateFields,
    indexedAt: row.indexed_at,
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
