/**
 * Session-archive setup: the dedicated archive config/index pair and the
 * owner-registered sources. Owner-local surfaces only (CLI, SDK, same-host
 * REST); nothing here imports.
 *
 * @module src/sessions/setup
 */

// node:fs/promises mkdir: directory creation has no Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path: no Bun path utilities.
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Collection, Config } from "../config/types";
import type { SessionSourceConfig, SessionsConfig } from "./config";

import { getIndexDbPath, resolveDirs } from "../app/constants";
import { canonicalizeIndexName, isValidIndexName } from "../app/index-name";
import { createDefaultConfig, getConfigPaths, loadConfig } from "../config";
import { applyConfigFileChange } from "../core/config-mutation";
import { SqliteAdapter } from "../store/sqlite/adapter";
import {
  SESSION_ARCHIVE_FIELD_MAPPING,
  SESSION_STATE_DIRNAME,
} from "./archive";
import {
  canonicalConfigPath,
  readIndexBinding,
  writeIndexBinding,
} from "./binding";
import {
  assertNotFilesystemRoot,
  assertSafeSourceRoot,
  canonicalPath,
  isWithin,
} from "./sources";
import { SESSION_HARNESSES, type SessionHarness, SessionsError } from "./types";

/** GNO-owned directories plus the archive: never readable as a source. */
export function protectedRoots(sessions: SessionsConfig | undefined): string[] {
  const dirs = resolveDirs();
  const roots = [dirs.config, dirs.data, dirs.cache];
  if (sessions) roots.push(sessions.archiveRoot);
  return roots;
}

export function requireSessionsConfig(config: Config): SessionsConfig {
  if (!config.sessions) {
    throw new SessionsError(
      "SESSIONS_NOT_CONFIGURED",
      "No session archive is configured for this config. Create one with: gno --config <archive.yml> --index <name> sessions init --archive <dir> --collection <name>"
    );
  }
  return config.sessions;
}

export function archiveCollection(
  config: Config,
  sessions: SessionsConfig,
  name: string
): Collection {
  const collection = config.collections.find((item) => item.name === name);
  if (
    !collection ||
    resolve(collection.path) !== resolve(join(sessions.archiveRoot, name))
  ) {
    throw new SessionsError(
      "SESSIONS_UNKNOWN_COLLECTION",
      `Collection "${name}" is not an archive collection of this session archive. Add it with: gno sessions init --archive <dir> --collection ${name}`
    );
  }
  return collection;
}

/**
 * Refuse an archive inside a folder the default (curated) config already
 * indexes: plain default-config sync would otherwise ingest the archive.
 */
async function assertOutsideCuratedCollections(
  archiveRoot: string
): Promise<void> {
  const path = getConfigPaths().configFile;
  if (!(await Bun.file(path).exists())) return;
  const loaded = await loadConfig(path);
  if (!loaded.ok) return;
  for (const collection of loaded.value.collections) {
    const root =
      (await canonicalPath(collection.path)) ?? resolve(collection.path);
    if (isWithin(root, archiveRoot)) {
      throw new SessionsError(
        "SESSIONS_UNSAFE_PATH",
        `The archive would sit inside collection "${collection.name}" of the default config, whose sync would ingest it; choose a directory outside it.`
      );
    }
  }
}

/**
 * Check the index can be bound to this archive config, run `commit` (the
 * config change), and record the binding only once it succeeds, so a failed
 * init never leaves an index bound to a config that is not an archive. The
 * check runs first so an index in use refuses before the config is written.
 */
async function bindArchiveIndex<T extends { ok: boolean }>(
  configPath: string,
  indexName: string,
  archiveRoot: string,
  commit: () => Promise<T>
): Promise<T> {
  const existing = (await Bun.file(configPath).exists())
    ? await loadConfig(configPath)
    : null;
  if (existing && !existing.ok) {
    throw new SessionsError("SESSIONS_INVALID_INPUT", existing.error.message);
  }
  const config = existing?.ok ? existing.value : createDefaultConfig();
  const dbPath = getIndexDbPath(indexName);
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new SqliteAdapter();
  store.setConfigPath(configPath);
  const opened = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!opened.ok) {
    throw new SessionsError("SESSIONS_INVALID_INPUT", opened.error.message);
  }
  try {
    const db = store.getRawDb();
    const foreign = db
      .query<{ path: string }, []>("SELECT path FROM collections")
      .all()
      .filter((row) => !isWithin(archiveRoot, resolve(row.path)));
    const canonical = await canonicalConfigPath(configPath);
    const marker = readIndexBinding(dbPath);
    if (foreign.length > 0 || (marker !== null && marker !== canonical)) {
      throw new SessionsError(
        "SESSIONS_BINDING_MISMATCH",
        `Index "${indexName}" already holds other collections or belongs to another archive; choose a new index name for the session archive.`
      );
    }
    const result = await commit();
    if (result.ok) writeIndexBinding(db, canonical);
    return result;
  } finally {
    await store.close();
  }
}

export interface InitArchiveInput {
  configPath: string;
  indexName: string;
  archiveRoot: string;
  collection: string;
}

function assertDedicatedPair(configPath: string, indexName: string): void {
  if (resolve(configPath) === resolve(getConfigPaths().configFile)) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "Session archives use a dedicated config file; pass --config <archive.yml> instead of the default config."
    );
  }
  if (
    !isValidIndexName(indexName) ||
    canonicalizeIndexName(indexName) === "default"
  ) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "Session archives use a dedicated named index; pass --index <name> (not default)."
    );
  }
}

function archiveCollectionDefinition(
  archiveRoot: string,
  name: string
): Collection {
  return {
    name,
    path: join(archiveRoot, name),
    pattern: "**/*.jsonl",
    include: [],
    exclude: [SESSION_STATE_DIRNAME],
    recordAdapters: {
      jsonl: { fieldMapping: SESSION_ARCHIVE_FIELD_MAPPING },
    },
  } as Collection;
}

/** Create or extend the dedicated archive config. Idempotent. */
export async function initSessionArchive(input: InitArchiveInput): Promise<{
  config: Config;
  archiveRoot: string;
  created: boolean;
}> {
  assertDedicatedPair(input.configPath, input.indexName);
  if (!isAbsolute(input.archiveRoot)) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "--archive must be an absolute directory path."
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.collection)) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "Collection names are lowercase alphanumeric with hyphens/underscores, 1-64 chars."
    );
  }
  // Lexically before creating anything, and again once symlinks resolve.
  assertNotFilesystemRoot(input.archiveRoot, "The session archive");
  const insideGnoDirs = (path: string): boolean =>
    protectedRoots(undefined).some((root) => isWithin(resolve(root), path));
  if (!insideGnoDirs(resolve(input.archiveRoot))) {
    await mkdir(input.archiveRoot, { recursive: true });
  }
  const archiveRoot =
    (await canonicalPath(input.archiveRoot)) ?? resolve(input.archiveRoot);
  assertNotFilesystemRoot(archiveRoot, "The session archive");
  if (insideGnoDirs(archiveRoot)) {
    throw new SessionsError(
      "SESSIONS_UNSAFE_PATH",
      "The archive must live outside GNO's config/data/cache directories, which reset and cleanup may remove."
    );
  }
  await assertOutsideCuratedCollections(archiveRoot);
  let created = false;
  const result = await bindArchiveIndex(
    input.configPath,
    input.indexName,
    archiveRoot,
    () =>
      applyConfigFileChange(
        {
          configPath: input.configPath,
          createConfigIfMissing: () => {
            created = true;
            return createDefaultConfig();
          },
        },
        (config) => {
          const existing = config.sessions;
          if (
            existing &&
            (existing.index !== input.indexName ||
              resolve(existing.archiveRoot) !== archiveRoot)
          ) {
            return {
              ok: false,
              code: "SESSIONS_BINDING_MISMATCH",
              error:
                "This config is already bound to a different archive index or root; it is never retargeted silently.",
            };
          }
          if (!existing) {
            const unrelated = config.collections.filter(
              (collection) => !isWithin(archiveRoot, resolve(collection.path))
            );
            if (unrelated.length > 0) {
              return {
                ok: false,
                code: "SESSIONS_INVALID_INPUT",
                error:
                  "This config already holds collections outside the archive; use a new dedicated config file for the session archive.",
              };
            }
          }
          const sessions: SessionsConfig = existing ?? {
            index: input.indexName,
            archiveRoot,
            sources: [],
          };
          const collections = [...config.collections];
          const current = collections.find(
            (item) => item.name === input.collection
          );
          if (current) {
            if (
              resolve(current.path) !==
              resolve(join(archiveRoot, input.collection))
            ) {
              return {
                ok: false,
                code: "SESSIONS_INVALID_INPUT",
                error: `Collection "${input.collection}" already exists with a different path.`,
              };
            }
          } else {
            collections.push(
              archiveCollectionDefinition(archiveRoot, input.collection)
            );
          }
          return { ok: true, config: { ...config, sessions, collections } };
        }
      )
  );
  if (!result.ok) {
    throw new SessionsError(
      result.code === "SESSIONS_BINDING_MISMATCH"
        ? "SESSIONS_BINDING_MISMATCH"
        : "SESSIONS_INVALID_INPUT",
      result.error
    );
  }
  await mkdir(join(archiveRoot, input.collection), { recursive: true });
  return { config: result.config, archiveRoot, created };
}

export interface AddSourceInput {
  configPath: string;
  id: string;
  harness: SessionHarness;
  path: string;
  collection: string;
  projects?: Array<{ prefix: string; collection: string }>;
}

/** Register (or confirm) an owner source. Creates missing archive collections. */
export async function addSessionSource(input: AddSourceInput): Promise<Config> {
  if (!SESSION_HARNESSES.includes(input.harness)) {
    throw new SessionsError(
      "SESSIONS_UNSUPPORTED_FORMAT",
      `Unsupported harness "${String(input.harness)}". Supported: ${SESSION_HARNESSES.join(", ")}.`
    );
  }
  if (!isAbsolute(input.path)) {
    throw new SessionsError(
      "SESSIONS_INVALID_INPUT",
      "Source path must be absolute."
    );
  }
  assertNotFilesystemRoot(input.path, "A session source");
  const canonical = await canonicalPath(input.path);
  if (!canonical) {
    throw new SessionsError(
      "SESSIONS_SOURCE_UNAVAILABLE",
      "The source path does not exist or is not readable."
    );
  }
  assertNotFilesystemRoot(canonical, "A session source");
  const result = await applyConfigFileChange(
    { configPath: input.configPath },
    (config) => {
      const sessions = config.sessions;
      if (!sessions) {
        return {
          ok: false,
          code: "SESSIONS_NOT_CONFIGURED",
          error: "Run gno sessions init before registering sources.",
        };
      }
      try {
        assertSafeSourceRoot(canonical, protectedRoots(sessions));
      } catch (error) {
        return {
          ok: false,
          code: "SESSIONS_UNSAFE_PATH",
          error: (error as Error).message,
        };
      }
      const source: SessionSourceConfig = {
        id: input.id,
        harness: input.harness,
        path: canonical,
        collection: input.collection,
        ...(input.projects && input.projects.length > 0
          ? { projects: input.projects }
          : {}),
      };
      const existing = sessions.sources.find((item) => item.id === input.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(source)) {
        return {
          ok: false,
          code: "SESSIONS_INVALID_INPUT",
          error: `Source "${input.id}" is already registered with different settings; remove it first.`,
        };
      }
      const collections = [...config.collections];
      const needed = new Set([
        input.collection,
        ...(input.projects ?? []).map((mapping) => mapping.collection),
      ]);
      for (const name of needed) {
        const current = collections.find((item) => item.name === name);
        if (!current) {
          collections.push(
            archiveCollectionDefinition(sessions.archiveRoot, name)
          );
        } else if (
          resolve(current.path) !== resolve(join(sessions.archiveRoot, name))
        ) {
          return {
            ok: false,
            code: "SESSIONS_UNKNOWN_COLLECTION",
            error: `Collection "${name}" is not an archive collection of this archive.`,
          };
        }
      }
      return {
        ok: true,
        config: {
          ...config,
          collections,
          sessions: {
            ...sessions,
            sources: existing
              ? sessions.sources
              : [...sessions.sources, source],
          },
        },
      };
    }
  );
  if (!result.ok) {
    const code = [
      "SESSIONS_NOT_CONFIGURED",
      "SESSIONS_UNSAFE_PATH",
      "SESSIONS_UNKNOWN_COLLECTION",
    ].includes(result.code)
      ? (result.code as "SESSIONS_NOT_CONFIGURED")
      : "SESSIONS_INVALID_INPUT";
    throw new SessionsError(code, result.error);
  }
  for (const collection of result.config.collections) {
    if (
      isWithin(result.config.sessions!.archiveRoot, resolve(collection.path))
    ) {
      await mkdir(collection.path, { recursive: true });
    }
  }
  return result.config;
}

/** Unregister a source. Its archive files are retained. */
export async function removeSessionSource(input: {
  configPath: string;
  id: string;
}): Promise<Config> {
  const result = await applyConfigFileChange(
    { configPath: input.configPath },
    (config) => {
      const sessions = config.sessions;
      if (!sessions?.sources.some((item) => item.id === input.id)) {
        return {
          ok: false,
          code: "SESSIONS_UNKNOWN_SOURCE",
          error: `Unknown session source "${input.id}".`,
        };
      }
      return {
        ok: true,
        config: {
          ...config,
          sessions: {
            ...sessions,
            sources: sessions.sources.filter((item) => item.id !== input.id),
          },
        },
      };
    }
  );
  if (!result.ok) {
    throw new SessionsError(
      result.code === "SESSIONS_UNKNOWN_SOURCE"
        ? "SESSIONS_UNKNOWN_SOURCE"
        : "SESSIONS_INVALID_INPUT",
      result.error
    );
  }
  return result.config;
}
