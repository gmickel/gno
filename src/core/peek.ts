/**
 * Shared peek snapshot builder for CLI and later MCP.
 * Metadata-only: never opens the model cache, resolves model URIs, or activates.
 *
 * @module src/core/peek
 */

// node:path — no Bun path utils
import { join as pathJoin } from "node:path";

import type { DocumentRow, IndexStatus } from "../store/types";

import { DEFAULT_INDEX_NAME, VERSION, getIndexDbPath } from "../app/constants";
import {
  isProcessAlive,
  readPidFile,
  resolveProcessPaths,
} from "../cli/detach";
import { CliError } from "../cli/errors";
import { isInitialized, loadConfig } from "../config";
import { SqliteAdapter } from "../store/sqlite/adapter";

export const PEEK_SCHEMA_VERSION = "peek@1.0" as const;
export const PEEK_RECENT_LIMIT = 10;

export interface PeekCounts {
  documents: number;
  collections: number;
}

export interface PeekBacklog {
  pending: number;
  failed: number;
}

export interface PeekRecentItem {
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  absPath: string;
  modifiedAt: string;
}

export interface PeekServe {
  running: boolean;
  url: string | null;
}

export interface PeekSnapshot {
  schemaVersion: typeof PEEK_SCHEMA_VERSION;
  gnoVersion: string;
  generatedAt: string;
  initialized: boolean;
  indexName: string;
  counts: PeekCounts | null;
  backlog: PeekBacklog | null;
  lastIndexedAt: string | null;
  recent: PeekRecentItem[];
  serve: PeekServe;
}

export interface BuildPeekOptions {
  configPath?: string;
  indexName?: string;
}

function asRuntimeError(error: unknown, fallback: string): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return new CliError(
    "RUNTIME",
    error instanceof Error ? error.message : fallback
  );
}

async function readServeLiveness(): Promise<PeekServe> {
  try {
    const { pidFile } = resolveProcessPaths("serve");
    const payload = await readPidFile(pidFile);
    if (!payload || !isProcessAlive(payload.pid) || payload.port == null) {
      return { running: false, url: null };
    }
    return {
      running: true,
      url: `http://localhost:${payload.port}`,
    };
  } catch (error) {
    throw asRuntimeError(error, "Failed to read serve process state");
  }
}

function mapRecent(
  documents: DocumentRow[],
  status: IndexStatus
): PeekRecentItem[] {
  const collectionPaths = new Map(
    status.collections.map((collection) => [collection.name, collection.path])
  );
  return documents.slice(0, PEEK_RECENT_LIMIT).map((doc) => {
    const sourceRelPath = doc.recordSourcePath ?? doc.relPath;
    const collectionPath = collectionPaths.get(doc.collection) ?? "";
    return {
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      collection: doc.collection,
      absPath: pathJoin(collectionPath, sourceRelPath),
      modifiedAt: doc.sourceMtime,
    };
  });
}

function emptySnapshot(
  indexName: string,
  generatedAt: string,
  serve: PeekServe
): PeekSnapshot {
  return {
    schemaVersion: PEEK_SCHEMA_VERSION,
    gnoVersion: VERSION,
    generatedAt,
    initialized: false,
    indexName,
    counts: null,
    backlog: null,
    lastIndexedAt: null,
    recent: [],
    serve,
  };
}

/**
 * Build a peek@1.0 snapshot. Throws CliError("RUNTIME") on any subquery
 * failure so callers never emit a half-filled payload.
 */
export async function buildPeekSnapshot(
  options: BuildPeekOptions = {}
): Promise<PeekSnapshot> {
  const generatedAt = new Date().toISOString();
  const requestedIndex = options.indexName ?? DEFAULT_INDEX_NAME;
  const serve = await readServeLiveness();

  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return emptySnapshot(requestedIndex, generatedAt, serve);
  }

  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    throw new CliError("RUNTIME", configResult.error.message);
  }

  const store = new SqliteAdapter();
  const openResult = await store.open(
    getIndexDbPath(options.indexName),
    configResult.value.ftsTokenizer
  );
  if (!openResult.ok) {
    throw new CliError("RUNTIME", openResult.error.message);
  }

  try {
    const statusResult = await store.getStatus();
    if (!statusResult.ok) {
      throw new CliError("RUNTIME", statusResult.error.message);
    }

    const recentResult = await store.listDocumentsPaginated({
      limit: PEEK_RECENT_LIMIT,
      offset: 0,
    });
    if (!recentResult.ok) {
      throw new CliError("RUNTIME", recentResult.error.message);
    }

    const status = statusResult.value;
    return {
      schemaVersion: PEEK_SCHEMA_VERSION,
      gnoVersion: VERSION,
      generatedAt,
      initialized: true,
      indexName: status.indexName,
      counts: {
        documents: status.activeDocuments,
        collections: status.collections.length,
      },
      backlog: {
        pending: status.embeddingBacklog,
        failed: status.recentErrors,
      },
      lastIndexedAt: status.lastUpdatedAt,
      recent: mapRecent(recentResult.value.documents, status),
      serve,
    };
  } catch (error) {
    throw asRuntimeError(error, "Failed to build peek snapshot");
  } finally {
    await store.close();
  }
}
