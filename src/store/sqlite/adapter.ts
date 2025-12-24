/**
 * SQLite implementation of StorePort.
 * Uses bun:sqlite for database operations.
 *
 * Note: bun:sqlite is synchronous but we use async for interface consistency.
 *
 * @module src/store/sqlite/adapter
 */

import { Database } from 'bun:sqlite';
import { buildUri, deriveDocid } from '../../app/constants';
import type { Collection, Context, FtsTokenizer } from '../../config/types';
import { migrations, runMigrations } from '../migrations';
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
} from '../types';
import { err, ok } from '../types';
import type { SqliteDbProvider } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Adapter Implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Regex to strip .sqlite extension from db path */
const SQLITE_EXT_REGEX = /\.sqlite$/;

/** Regex to strip index- prefix from db name */
const INDEX_PREFIX_REGEX = /^index-/;

export class SqliteAdapter implements StorePort, SqliteDbProvider {
  private db: Database | null = null;
  private dbPath = '';
  private ftsTokenizer: FtsTokenizer = 'unicode61';
  private configPath = ''; // Set by CLI layer for status output

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
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');

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
        cause instanceof Error ? cause.message : 'Failed to open database';
      return err('CONNECTION_FAILED', message, cause);
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
      throw new Error('Database not open');
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
            .query<{ name: string }, []>('SELECT name FROM collections')
            .all()
            .map((r) => r.name)
        );

        const incoming = new Set(collections.map((c) => c.name));

        // Delete removed collections
        for (const name of existing) {
          if (!incoming.has(name)) {
            db.run('DELETE FROM collections WHERE name = ?', [name]);
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to sync collections',
        cause
      );
    }
  }

  async syncContexts(contexts: Context[]): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Delete all and re-insert (contexts are small)
        db.run('DELETE FROM contexts');

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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to sync contexts',
        cause
      );
    }
  }

  async getCollections(): Promise<StoreResult<CollectionRow[]>> {
    try {
      const db = this.ensureOpen();
      const rows = db
        .query<DbCollectionRow, []>('SELECT * FROM collections')
        .all();

      return ok(rows.map(mapCollectionRow));
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get collections',
        cause
      );
    }
  }

  async getContexts(): Promise<StoreResult<ContextRow[]>> {
    try {
      const db = this.ensureOpen();
      const rows = db.query<DbContextRow, []>('SELECT * FROM contexts').all();

      return ok(rows.map(mapContextRow));
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get contexts',
        cause
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Documents
  // ─────────────────────────────────────────────────────────────────────────

  async upsertDocument(doc: DocumentInput): Promise<StoreResult<string>> {
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
          last_error_code, last_error_message, last_error_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))
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
        ]
      );

      return ok(docid);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to upsert document',
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
          'SELECT * FROM documents WHERE collection = ? AND rel_path = ?'
        )
        .get(collection, relPath);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get document',
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
          'SELECT * FROM documents WHERE docid = ?'
        )
        .get(docid);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error
          ? cause.message
          : 'Failed to get document by docid',
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
        .query<DbDocumentRow, [string]>('SELECT * FROM documents WHERE uri = ?')
        .get(uri);

      return ok(row ? mapDocumentRow(row) : null);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error
          ? cause.message
          : 'Failed to get document by uri',
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
              'SELECT * FROM documents WHERE collection = ?'
            )
            .all(collection)
        : db.query<DbDocumentRow, []>('SELECT * FROM documents').all();

      return ok(rows.map(mapDocumentRow));
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to list documents',
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

      const placeholders = relPaths.map(() => '?').join(',');
      const result = db.run(
        `UPDATE documents SET active = 0, updated_at = datetime('now')
         WHERE collection = ? AND rel_path IN (${placeholders})`,
        [collection, ...relPaths]
      );

      return ok(result.changes);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error
          ? cause.message
          : 'Failed to mark documents inactive',
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to upsert content',
        cause
      );
    }
  }

  async getContent(mirrorHash: string): Promise<StoreResult<string | null>> {
    try {
      const db = this.ensureOpen();

      const row = db
        .query<{ markdown: string }, [string]>(
          'SELECT markdown FROM content WHERE mirror_hash = ?'
        )
        .get(mirrorHash);

      return ok(row?.markdown ?? null);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get content',
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
        db.run('DELETE FROM content_chunks WHERE mirror_hash = ?', [
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to upsert chunks',
        cause
      );
    }
  }

  async getChunks(mirrorHash: string): Promise<StoreResult<ChunkRow[]>> {
    try {
      const db = this.ensureOpen();

      const rows = db
        .query<DbChunkRow, [string]>(
          'SELECT * FROM content_chunks WHERE mirror_hash = ? ORDER BY seq'
        )
        .all(mirrorHash);

      return ok(rows.map(mapChunkRow));
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get chunks',
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

      // Join FTS results with chunks and documents
      const sql = `
        SELECT
          c.mirror_hash,
          c.seq,
          fts.rank as score,
          ${options.snippet ? "snippet(content_fts, 0, '<mark>', '</mark>', '...', 32) as snippet," : ''}
          d.docid,
          d.uri,
          d.title,
          d.collection,
          d.rel_path
        FROM content_fts fts
        JOIN content_chunks c ON c.rowid = fts.rowid
        JOIN documents d ON d.mirror_hash = c.mirror_hash AND d.active = 1
        WHERE content_fts MATCH ?
        ${options.collection ? 'AND d.collection = ?' : ''}
        ${options.language ? 'AND c.language = ?' : ''}
        ORDER BY fts.rank
        LIMIT ?
      `;

      const params: (string | number)[] = [query];
      if (options.collection) {
        params.push(options.collection);
      }
      if (options.language) {
        params.push(options.language);
      }
      params.push(limit);

      type FtsRow = {
        mirror_hash: string;
        seq: number;
        score: number;
        snippet?: string;
        docid: string;
        uri: string;
        title: string | null;
        collection: string;
        rel_path: string;
      };

      const rows = db.query<FtsRow, (string | number)[]>(sql).all(...params);

      return ok(
        rows.map((r) => ({
          mirrorHash: r.mirror_hash,
          seq: r.seq,
          score: Math.abs(r.score), // FTS5 rank is negative
          snippet: r.snippet,
          docid: r.docid,
          uri: r.uri,
          title: r.title ?? undefined,
          collection: r.collection,
          relPath: r.rel_path,
        }))
      );
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to search FTS',
        cause
      );
    }
  }

  async rebuildFtsForHash(mirrorHash: string): Promise<StoreResult<void>> {
    try {
      const db = this.ensureOpen();

      const transaction = db.transaction(() => {
        // Get chunks for this hash
        const chunks = db
          .query<{ rowid: number; text: string }, [string]>(
            'SELECT rowid, text FROM content_chunks WHERE mirror_hash = ?'
          )
          .all(mirrorHash);

        // Delete old FTS entries for these rowids
        for (const chunk of chunks) {
          db.run('DELETE FROM content_fts WHERE rowid = ?', [chunk.rowid]);
        }

        // Insert new FTS entries
        const stmt = db.prepare(
          'INSERT INTO content_fts (rowid, text) VALUES (?, ?)'
        );
        for (const chunk of chunks) {
          stmt.run(chunk.rowid, chunk.text);
        }
      });

      transaction();
      return ok(undefined);
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to rebuild FTS',
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
      const version = versionRow?.value ?? '0';

      // Derive indexName from dbPath (basename without extension)
      const indexName =
        this.dbPath
          .split('/')
          .pop()
          ?.replace(SQLITE_EXT_REGEX, '')
          ?.replace(INDEX_PREFIX_REGEX, '') || 'default';

      // Get collection stats with chunk counts
      type CollectionStat = {
        name: string;
        path: string;
        total: number;
        active: number;
        errored: number;
        chunked: number;
        chunk_count: number;
        embedded_count: number;
      };

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
            'SELECT COUNT(*) as count FROM content_chunks'
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
          'SELECT MAX(updated_at) as last_updated FROM documents'
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get status',
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to record error',
        cause
      );
    }
  }

  async getRecentErrors(limit = 50): Promise<StoreResult<IngestErrorRow[]>> {
    try {
      const db = this.ensureOpen();

      const rows = db
        .query<DbIngestErrorRow, [number]>(
          'SELECT * FROM ingest_errors ORDER BY occurred_at DESC LIMIT ?'
        )
        .all(limit);

      return ok(rows.map(mapIngestErrorRow));
    } catch (cause) {
      return err(
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to get recent errors',
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

        // Rebuild FTS index (remove orphaned entries)
        db.run(`
          DELETE FROM content_fts WHERE rowid NOT IN (
            SELECT rowid FROM content_chunks
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
        'QUERY_FAILED',
        cause instanceof Error ? cause.message : 'Failed to cleanup orphans',
        cause
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Row Types (snake_case from SQLite)
// ─────────────────────────────────────────────────────────────────────────────

type DbCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  include: string | null;
  exclude: string | null;
  update_cmd: string | null;
  language_hint: string | null;
  synced_at: string;
};

type DbContextRow = {
  scope_type: 'global' | 'collection' | 'prefix';
  scope_key: string;
  text: string;
  synced_at: string;
};

type DbDocumentRow = {
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
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbChunkRow = {
  mirror_hash: string;
  seq: number;
  pos: number;
  text: string;
  start_line: number;
  end_line: number;
  language: string | null;
  token_count: number | null;
  created_at: string;
};

type DbIngestErrorRow = {
  id: number;
  collection: string;
  rel_path: string;
  occurred_at: string;
  code: string;
  message: string;
  details_json: string | null;
};

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
