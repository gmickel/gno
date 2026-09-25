/**
 * Transport-neutral session ingestion service.
 *
 * CLI, MCP, REST, SDK and Web UI are thin adapters over this module. The
 * service never runs on its own: nothing here watches, schedules or hooks
 * into a harness. Imports are explicit, serialized per archive, idempotent,
 * and only advance a unit's checkpoint after a clean, complete read.
 *
 * @module src/sessions/service
 */

// node:fs/promises: directory creation/removal and listing have no Bun equivalents.
import {
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
// node:path: no Bun path utilities.
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { SessionsConfig } from "./config";

import { hashRecordValue } from "../converters/adapters/shared/record-utils";
import { acquireWriteLock } from "../core/file-lock";
import { atomicWrite } from "../core/file-ops";
import { defaultSyncService, withContentTypeRules } from "../ingestion";
import {
  archiveFilePath,
  renderThread,
  threadRelPath,
  rescanArchiveContent,
  SESSION_STATE_DIRNAME,
} from "./archive";
import { canonicalConfigPath, writeIndexBinding } from "./binding";
import { redactionStamp, sanitizeValue } from "./sanitize";
import {
  archiveCollection,
  protectedRoots,
  requireSessionsConfig,
} from "./setup";
import {
  assertNotFilesystemRootAnyForm,
  assertSafeSourceRoot,
  canonicalPath,
  defaultDiscoveryRoots,
  detectHarness,
  detectRootHarness,
  enumerateUnits,
  isReadableRoot,
  type ReadDirectory,
  readFailureReason,
  parseUnit,
  SESSION_PARSERS,
  type SessionUnit,
} from "./sources";
import {
  importLockPath,
  loadState,
  saveState,
  type SourceState,
  unitFingerprint,
  unitKey,
  type UnitState,
  withheldPath,
} from "./state";
import {
  MAX_IMPORT_LIMIT,
  type ParsedThread,
  SESSION_ARCHIVE_FORMAT_VERSION,
  SESSION_HARNESSES,
  SESSION_LIMITS,
  type SessionDiscoveryCandidate,
  type SessionHarness,
  type SessionImportCounts,
  type SessionImportReceipt,
  type SessionsDiscovery,
  SessionsError,
  type SessionSourceStatus,
  type SessionsStatus,
  type SessionTurnCounts,
  type SessionUnitReceipt,
} from "./types";

const IMPORT_LOCK_WAIT_MS = 2_000;
const DISCOVERY_UNIT_LIMIT = 20_000;
const PATH_SOURCE_PREFIX = "path-";

export interface SessionsServiceDeps {
  config: Config;
  /** Actual config file path in use (the archive config). */
  configPath: string;
  indexName: string;
  /** Open store for this config/index pair; required for non-dry-run imports. */
  store?: SqliteAdapter;
  syncService?: Pick<typeof defaultSyncService, "syncPaths" | "syncCollection">;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Directory listing used for source roots (tests inject failures). */
  readDirectory?: ReadDirectory;
}

export interface SessionImportInput {
  /** Registered source profile to import. */
  sourceId?: string;
  /** Explicit host paths (local owner CLI/SDK only). */
  paths?: string[];
  /** Destination collection for path imports. */
  collection?: string;
  /** Harness override for path imports. */
  format?: SessionHarness;
  dryRun?: boolean;
  /** Maximum number of changed units processed in this run. */
  limit?: number;
}

export interface SessionImportOptions {
  /** Remote/unauthenticated surfaces may only import registered sources. */
  allowPaths: boolean;
}

export interface SessionPrunePreview {
  schemaVersion: "1";
  sourceId: string;
  applied: boolean;
  units: Array<{ locator: string; threads: number }>;
  archiveFiles: number;
  /** Set when the index sync failed; nothing was recorded and a rerun retries. */
  error?: string;
}

interface PendingWithdrawal {
  units: Record<string, UnitState>;
  key: string;
  thread: { collection: string; relPath: string };
}

interface ResolvedSource {
  id: string;
  harness: SessionHarness | null;
  /** Canonical root, or null when a registered root is gone (archive-only). */
  root: string | null;
  collection: string;
  projects: Array<{ prefix: string; collection: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const emptyCounts = (): SessionImportCounts => ({
  imported: 0,
  updated: 0,
  unchanged: 0,
  skippedPolicy: 0,
  unsupported: 0,
  incomplete: 0,
  failed: 0,
});

const emptyTurns = (): SessionTurnCounts => ({
  human: 0,
  assistant: 0,
  redactions: 0,
  injectedSkipped: 0,
  copiedHistorySkipped: 0,
  overLimit: 0,
});

/** Identity of the routing settings; a change re-imports the source's units. */
function destinationsStamp(source: ResolvedSource): string {
  const projects = [...source.projects]
    .map((mapping) => `${mapping.prefix}\0${mapping.collection}`)
    .sort();
  return hashRecordValue(
    "gno-session-destinations-v1",
    JSON.stringify([source.collection, projects])
  ).slice(0, 16);
}

function projectDestination(
  cwd: string | undefined,
  source: ResolvedSource
): string {
  if (!cwd) return source.collection;
  const normalized = cwd.replaceAll("\\", "/");
  let best: { prefix: string; collection: string } | undefined;
  for (const mapping of source.projects) {
    const prefix = mapping.prefix.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, collection: mapping.collection };
      }
    }
  }
  return best?.collection ?? source.collection;
}

/** Destination for a thread; null when its working directories disagree. */
function threadDestination(
  thread: ParsedThread,
  source: ResolvedSource
): string | null {
  const cwds = new Set<string | undefined>([thread.cwd]);
  for (const turn of thread.turns) if (turn.cwd) cwds.add(turn.cwd);
  const destinations = new Set(
    [...cwds].map((cwd) => projectDestination(cwd, source))
  );
  return destinations.size === 1 ? [...destinations][0]! : null;
}

async function readText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

function unitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/database|sqlite|SQLITE/i.test(message)) return "snapshot_read_failed";
  return readFailureReason(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class SessionsService {
  private readonly deps: SessionsServiceDeps;

  constructor(deps: SessionsServiceDeps) {
    this.deps = deps;
  }

  private get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Preview supported local sources on this host. Never imports. */
  async discover(): Promise<SessionsDiscovery> {
    const sessions = this.deps.config.sessions;
    const excluded = protectedRoots(sessions);
    const candidates: SessionDiscoveryCandidate[] = [];
    const warnings: string[] = [];
    for (const root of defaultDiscoveryRoots(this.deps.env)) {
      const canonical = await canonicalPath(root.path);
      if (!canonical) continue;
      let enumerated;
      try {
        enumerated = await enumerateUnits({
          harness: root.harness,
          root: canonical,
          excluded,
          limit: DISCOVERY_UNIT_LIMIT,
          readDirectory: this.deps.readDirectory,
        });
      } catch {
        warnings.push(`${root.harness}: source root could not be read`);
        continue;
      }
      if (enumerated.unreadable.length > 0) {
        warnings.push(
          `${root.harness}: ${enumerated.unreadable.length} entries under the source root could not be read`
        );
      }
      if (enumerated.units.length === 0) continue;
      const registered = sessions?.sources.find(
        (source) =>
          source.harness === root.harness && resolve(source.path) === canonical
      );
      candidates.push({
        harness: root.harness,
        path: canonical,
        units: enumerated.units.length,
        bytes: enumerated.units.reduce((sum, unit) => sum + unit.size, 0),
        truncated: enumerated.truncated,
        formatVersions: await sampleVersions(enumerated.units),
        registeredAs: registered?.id ?? null,
      });
    }
    return { schemaVersion: "1", candidates, warnings };
  }

  /** Archive, source and checkpoint status. Never modifies anything. */
  async status(): Promise<SessionsStatus> {
    const sessions = requireSessionsConfig(this.deps.config);
    const state = await loadState(sessions.archiveRoot);
    const warnings: string[] = [];
    const collections: SessionsStatus["collections"] = [];
    const archiveNames = new Set(
      sessions.sources.flatMap((source) => [
        source.collection,
        ...(source.projects ?? []).map((mapping) => mapping.collection),
      ])
    );
    for (const collection of this.deps.config.collections) {
      if (
        resolve(collection.path) ===
        resolve(join(sessions.archiveRoot, collection.name))
      ) {
        archiveNames.add(collection.name);
      }
    }
    for (const name of [...archiveNames].sort()) {
      collections.push({
        name,
        threads: await countArchiveFiles(join(sessions.archiveRoot, name)),
      });
    }

    const sources: SessionSourceStatus[] = [];
    for (const source of sessions.sources) {
      const sourceState = state.sources[source.id];
      const known = sourceState?.units ?? {};
      const canonical = await canonicalPath(source.path);
      let units: SessionUnit[] = [];
      let readable = false;
      if (canonical) {
        try {
          const enumerated = await enumerateUnits({
            harness: source.harness,
            root: canonical,
            excluded: protectedRoots(sessions),
            readDirectory: this.deps.readDirectory,
          });
          units = enumerated.units;
          readable = true;
          if (enumerated.unreadable.length > 0) {
            warnings.push(
              `${source.id}: ${enumerated.unreadable.length} entries could not be read; their units are not counted`
            );
          }
        } catch {
          warnings.push(`${source.id}: source could not be read`);
        }
      }
      const present = new Set<string>();
      let pending = 0;
      const destinations = destinationsStamp({
        id: source.id,
        harness: source.harness,
        root: canonical ?? source.path,
        collection: source.collection,
        projects: source.projects ?? [],
      });
      for (const unit of units) {
        const key = unitKey(source.id, unit.locator);
        present.add(key);
        const previous = known[key];
        if (
          !previous ||
          previous.status !== "complete" ||
          previous.destinations !== destinations ||
          previous.fingerprint !== (await unitFingerprint(unit).catch(() => ""))
        ) {
          pending += 1;
        }
      }
      const stateUnits = Object.entries(known);
      const presentUnits = stateUnits.filter(([key]) => present.has(key));
      sources.push({
        id: source.id,
        harness: source.harness,
        collection: source.collection,
        available: readable,
        units: {
          total: units.length,
          // Counted over present units only; units whose source is gone
          // are reported as sourceUnavailable.
          complete: presentUnits.filter(
            ([, unit]) => unit.status === "complete"
          ).length,
          incomplete: presentUnits.filter(
            ([, unit]) => unit.status === "incomplete"
          ).length,
          failed: presentUnits.filter(
            ([, unit]) =>
              unit.status === "failed" || unit.status === "unsupported"
          ).length,
          pending,
        },
        archivedThreads: stateUnits.reduce(
          (sum, [, unit]) => sum + unit.threads.length,
          0
        ),
        staleParser: stateUnits.filter(
          ([key, unit]) =>
            unit.parser !== null &&
            !present.has(key) &&
            (unit.format !== SESSION_ARCHIVE_FORMAT_VERSION ||
              unit.parser !== SESSION_PARSERS[unit.harness ?? source.harness])
        ).length,
        sourceUnavailable: stateUnits.filter(([key]) => !present.has(key))
          .length,
        lastImportAt: sourceState?.lastImportAt ?? null,
      });
    }
    return {
      schemaVersion: "1",
      configured: true,
      index: this.deps.indexName,
      collections,
      sources,
      warnings,
    };
  }

  private async resolveSources(
    sessions: SessionsConfig,
    input: SessionImportInput,
    options: SessionImportOptions
  ): Promise<ResolvedSource[]> {
    const paths = (input.paths ?? []).filter((path) => path.trim());
    if (paths.length > 0 && !options.allowPaths) {
      throw new SessionsError(
        "SESSIONS_UNSAFE_PATH",
        "Host paths cannot be named on this surface; import a registered source by its ID."
      );
    }
    if (input.sourceId && paths.length > 0) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "Select either a registered source or explicit paths, not both."
      );
    }
    if (input.format && !SESSION_HARNESSES.includes(input.format)) {
      throw new SessionsError(
        "SESSIONS_UNSUPPORTED_FORMAT",
        `Unsupported format "${String(input.format)}". Supported: ${SESSION_HARNESSES.join(", ")}.`
      );
    }
    if (input.sourceId) {
      if (input.collection) {
        throw new SessionsError(
          "SESSIONS_INVALID_INPUT",
          "A registered source imports into its registered collection and project mappings; --collection applies to path imports only."
        );
      }
      const source = sessions.sources.find(
        (item) => item.id === input.sourceId
      );
      if (!source) {
        throw new SessionsError(
          "SESSIONS_UNKNOWN_SOURCE",
          `Unknown session source "${input.sourceId}". Registered: ${sessions.sources.map((item) => item.id).join(", ") || "(none)"}.`
        );
      }
      await assertNotFilesystemRootAnyForm(source.path, "A session source");
      const found = await canonicalPath(source.path);
      if (found) assertSafeSourceRoot(found, protectedRoots(sessions));
      const canonical = found && (await isReadableRoot(found)) ? found : null;
      if (!canonical) {
        // With archived units the run still maintains the retained archive
        // (redaction rescans) before failing; without any there is nothing
        // to maintain.
        const state = await loadState(sessions.archiveRoot);
        const archived = Object.keys(state.sources[source.id]?.units ?? {});
        if (archived.length === 0) {
          throw new SessionsError(
            "SESSIONS_SOURCE_UNAVAILABLE",
            `Session source "${source.id}" is not readable right now.`
          );
        }
      }
      return [
        {
          id: source.id,
          harness: input.format ?? source.harness,
          root: canonical,
          collection: source.collection,
          projects: source.projects ?? [],
        },
      ];
    }
    if (paths.length === 0) {
      throw new SessionsError(
        "SESSIONS_SELECTION_REQUIRED",
        "Select what to import: --source <id> for a registered source, or explicit session paths. Run gno sessions discover to preview local sources."
      );
    }
    if (!input.collection) {
      throw new SessionsError(
        "SESSIONS_DESTINATION_REQUIRED",
        "Path imports need an explicit destination: --collection <archive collection>."
      );
    }
    // Validate the destination before touching the filesystem.
    archiveCollection(this.deps.config, sessions, input.collection);
    const resolved: ResolvedSource[] = [];
    for (const path of paths) {
      if (!isAbsolute(path)) {
        throw new SessionsError(
          "SESSIONS_INVALID_INPUT",
          "Session paths must be absolute."
        );
      }
      await assertNotFilesystemRootAnyForm(path, "A session source");
      const canonical = await canonicalPath(path);
      if (!(canonical && (await isReadableRoot(canonical)))) {
        throw new SessionsError(
          "SESSIONS_SOURCE_UNAVAILABLE",
          "A selected session path does not exist or is not readable."
        );
      }
      assertSafeSourceRoot(canonical, protectedRoots(sessions));
      resolved.push({
        id: `${PATH_SOURCE_PREFIX}${hashRecordValue("gno-session-path-source-v1", canonical).slice(0, 12)}`,
        harness: input.format ?? null,
        root: canonical,
        collection: input.collection,
        projects: [],
      });
    }
    return resolved;
  }

  /** Import selected sources into the archive and sync affected collections. */
  async import(
    input: SessionImportInput,
    options: SessionImportOptions
  ): Promise<SessionImportReceipt> {
    const sessions = requireSessionsConfig(this.deps.config);
    const dryRun = input.dryRun === true;
    const limit = input.limit;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_IMPORT_LIMIT)
    ) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        `limit must be an integer between 1 and ${MAX_IMPORT_LIMIT}.`
      );
    }
    const sources = await this.resolveSources(sessions, input, options);
    for (const source of sources) {
      archiveCollection(this.deps.config, sessions, source.collection);
      for (const mapping of source.projects) {
        archiveCollection(this.deps.config, sessions, mapping.collection);
      }
    }
    if (!dryRun && !this.deps.store) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "An open archive index is required to import."
      );
    }

    if (!dryRun) {
      await mkdir(join(sessions.archiveRoot, SESSION_STATE_DIRNAME), {
        recursive: true,
      });
    }
    const lock = dryRun
      ? null
      : await acquireWriteLock(
          importLockPath(sessions.archiveRoot),
          IMPORT_LOCK_WAIT_MS
        );
    if (!dryRun && !lock) {
      throw new SessionsError(
        "SESSIONS_BUSY",
        "Another session import is running for this archive; retry when it finishes."
      );
    }
    try {
      return await this.runImport(sessions, sources, { dryRun, limit });
    } finally {
      await lock?.release();
    }
  }

  private async runImport(
    sessions: SessionsConfig,
    sources: ResolvedSource[],
    options: { dryRun: boolean; limit?: number }
  ): Promise<SessionImportReceipt> {
    const state = await loadState(sessions.archiveRoot);
    const counts = emptyCounts();
    const turns = emptyTurns();
    const units: SessionUnitReceipt[] = [];
    const warnings: string[] = [];
    const changed = new Map<string, Set<string>>();
    const excluded = protectedRoots(sessions);
    const redaction = { literals: sessions.redaction?.literals ?? [] };
    const stamp = redactionStamp(redaction);
    // Units whose state changed this run; reverted if the index sync fails so
    // completion is only recorded once the archive is searchable.
    const touched: Array<{ units: Record<string, UnitState>; key: string }> =
      [];
    const revertStamp = new Map<UnitState, string>();
    const pendingWithdrawals: PendingWithdrawal[] = [];
    let processed = 0;
    let deferred = 0;
    let unitsTruncated = false;

    const recordUnit = (receipt: SessionUnitReceipt): void => {
      if (units.length < SESSION_LIMITS.maxReceiptUnits) units.push(receipt);
      else unitsTruncated = true;
    };
    const markChanged = (collection: string, relPath: string): void => {
      const set = changed.get(collection) ?? new Set<string>();
      set.add(relPath);
      changed.set(collection, set);
    };

    // Sources whose root is missing or cannot be read: their retained
    // archive is still maintained, then the run fails.
    const unavailable: string[] = [];
    const nothingListed: Awaited<ReturnType<typeof enumerateUnits>> = {
      units: [],
      truncated: false,
      unreadable: [],
    };

    for (const source of sources) {
      const sourceState: SourceState = state.sources[source.id] ?? {
        lastImportAt: null,
        units: {},
      };
      let enumerated: Awaited<ReturnType<typeof enumerateUnits>>;
      if (source.root === null) {
        unavailable.push(source.id);
        enumerated = nothingListed;
      } else {
        try {
          const root = source.root;
          const harness =
            source.harness ??
            (await detectRootHarness(root, excluded, this.deps.readDirectory));
          enumerated = harness
            ? await enumerateUnits({
                harness,
                root,
                excluded,
                readDirectory: this.deps.readDirectory,
              })
            : nothingListed;
          if (!harness) {
            counts.unsupported += 1;
            // A selected file is named by its safe (redacted) file name.
            const selectedFile = (await stat(root)).isFile();
            recordUnit({
              sourceId: source.id,
              harness: null,
              locator: selectedFile
                ? sanitizeValue(basename(root), redaction)
                : ".",
              outcome: "unsupported",
              reason: "format_not_recognised",
              threads: 0,
              turns: 0,
              collections: [],
            });
            continue;
          }
        } catch (error) {
          const reason = unitReason(error);
          if (reason === "source_missing" || reason === "permission_denied") {
            // The root became unreadable after preflight.
            unavailable.push(source.id);
            enumerated = nothingListed;
          } else {
            counts.failed += 1;
            recordUnit({
              sourceId: source.id,
              harness: source.harness,
              locator: ".",
              outcome: "failed",
              reason,
              threads: 0,
              turns: 0,
              collections: [],
            });
            continue;
          }
        }
      }
      if (enumerated.truncated) {
        warnings.push(
          `${source.id}: more than ${SESSION_LIMITS.maxUnitsPerSource} units; the rest are left for a later run`
        );
      }
      // Unread parts of a source fail explicitly; their units keep their
      // checkpoints and archives untouched.
      for (const entry of enumerated.unreadable) {
        counts.failed += 1;
        recordUnit({
          sourceId: source.id,
          harness: source.harness,
          locator:
            entry.locator === null
              ? "."
              : sanitizeValue(entry.locator, redaction),
          outcome: "failed",
          reason: entry.reason,
          threads: 0,
          turns: 0,
          collections: [],
        });
      }
      const present = new Set<string>();
      const destinations = destinationsStamp(source);
      for (const found of enumerated.units) {
        const key = unitKey(source.id, found.locator);
        // Receipts, warnings and checkpoint state show the locator with the
        // owner's redaction applied; identity stays in the opaque key.
        const unit: SessionUnit = {
          ...found,
          locator: sanitizeValue(found.locator, redaction),
        };
        if (present.has(key)) {
          // Two units with the same locator would share archive files.
          counts.failed += 1;
          recordUnit({
            sourceId: source.id,
            harness: unit.harness,
            locator: unit.locator,
            outcome: "failed",
            reason: "unit_conflict",
            threads: 0,
            turns: 0,
            collections: [],
          });
          continue;
        }
        present.add(key);
        let fingerprint: string;
        try {
          fingerprint = await unitFingerprint(unit);
        } catch (error) {
          counts.failed += 1;
          recordUnit({
            sourceId: source.id,
            harness: unit.harness,
            locator: unit.locator,
            outcome: "failed",
            reason: unitReason(error),
            threads: 0,
            turns: 0,
            collections: [],
          });
          continue;
        }
        const previous = sourceState.units[key];
        const current =
          previous?.status === "complete" &&
          previous.fingerprint === fingerprint &&
          previous.parser ===
            SESSION_PARSERS[previous.harness ?? unit.harness] &&
          previous.redaction === stamp &&
          previous.destinations === destinations &&
          previous.format === SESSION_ARCHIVE_FORMAT_VERSION;
        if (current) {
          // Already archived and up to date: reported, not re-read.
          counts.unchanged += previous.threads.length;
          continue;
        }
        if (options.limit !== undefined && processed >= options.limit) {
          deferred += 1;
          continue;
        }
        processed += 1;
        if (unit.size > SESSION_LIMITS.maxSourceBytes) {
          counts.skippedPolicy += 1;
          recordUnit({
            sourceId: source.id,
            harness: unit.harness,
            locator: unit.locator,
            outcome: "skipped_policy",
            reason: "over_limit",
            threads: 0,
            turns: 0,
            collections: [],
          });
          continue;
        }
        touched.push({ units: sourceState.units, key });
        const outcome = await this.importUnit({
          source,
          unit,
          key,
          destinations,
          fingerprint,
          previous,
          sourceState,
          dryRun: options.dryRun,
          redaction,
          counts,
          turns,
          markChanged,
          pendingWithdrawals,
        });
        recordUnit(outcome);
      }

      // Units whose source vanished keep their archive. Stale redaction is
      // rescanned in place from the durable sanitized archive.
      for (const [key, unitState] of Object.entries(sourceState.units)) {
        if (present.has(key)) continue;
        // Retained locators follow the current redaction policy too.
        const locator = sanitizeValue(unitState.locator, redaction);
        if (!options.dryRun) unitState.locator = locator;
        if (unitState.redaction !== stamp && !options.dryRun) {
          const previousStamp = unitState.redaction;
          const withheld = await this.rescanUnavailable(
            sessions,
            unitState,
            redaction,
            markChanged
          );
          if (withheld > 0) {
            warnings.push(
              `${source.id}: ${withheld} archived threads of ${locator} could not be rescanned with the current redaction rules and were withheld from retrieval`
            );
          } else {
            unitState.redaction = stamp;
            touched.push({ units: sourceState.units, key });
            revertStamp.set(unitState, previousStamp);
          }
        }
        if (
          unitState.parser !== null &&
          (unitState.format !== SESSION_ARCHIVE_FORMAT_VERSION ||
            unitState.parser !==
              SESSION_PARSERS[unitState.harness ?? source.harness ?? "codex"])
        ) {
          warnings.push(
            `${source.id}: ${locator} was archived by an older parser and its source is unavailable; the archive is retained without reparsing`
          );
        }
      }
      if (!options.dryRun) {
        sourceState.lastImportAt = this.now.toISOString();
        state.sources[source.id] = sourceState;
      }
    }

    let lexical: SessionImportReceipt["lexical"] = {
      status: "skipped",
      collections: [],
    };
    let backlog: number | null = null;
    if (!options.dryRun) {
      lexical = await this.syncChanged(sessions, changed);
      if (lexical.status === "ready") {
        for (const { units: stateUnits, key, thread } of pendingWithdrawals) {
          const unitState = stateUnits[key];
          if (!unitState) continue;
          unitState.threads = unitState.threads.filter(
            (item) =>
              item.collection !== thread.collection ||
              item.relPath !== thread.relPath
          );
        }
      }
      if (lexical.status === "failed") {
        for (const { units: stateUnits, key } of touched) {
          const unitState = stateUnits[key];
          if (!unitState) continue;
          const previousStamp = revertStamp.get(unitState);
          if (previousStamp !== undefined) unitState.redaction = previousStamp;
          else if (unitState.status === "complete")
            unitState.status = "incomplete";
        }
      }
      await saveState(sessions.archiveRoot, state);
      backlog = await this.embeddingBacklog();
    }
    if (unavailable.length > 0) {
      // State is saved: the retained archive was maintained; the run failed.
      throw new SessionsError(
        "SESSIONS_SOURCE_UNAVAILABLE",
        `Session source "${unavailable[0]}" is missing or not readable right now; its archive is retained.`
      );
    }

    const failures = counts.failed + counts.incomplete + counts.unsupported;
    const work =
      counts.imported +
      counts.updated +
      counts.unchanged +
      counts.skippedPolicy;
    let status: SessionImportReceipt["status"] = "complete";
    if (failures > 0 && work === 0 && counts.incomplete === 0)
      status = "failed";
    else if (failures > 0 || deferred > 0 || lexical.status === "failed") {
      status = "partial";
    } else if (processed === 0) status = "nothing_to_do";

    return {
      schemaVersion: "1",
      dryRun: options.dryRun,
      index: this.deps.indexName,
      sourceIds: sources.map((source) => source.id),
      status,
      counts,
      turns,
      units,
      unitsTruncated,
      deferredUnits: deferred,
      lexical,
      embedding: { backlog },
      warnings,
    };
  }

  private async importUnit(options: {
    source: ResolvedSource;
    unit: SessionUnit;
    key: string;
    destinations: string;
    fingerprint: string;
    previous: UnitState | undefined;
    sourceState: SourceState;
    dryRun: boolean;
    redaction: { literals: readonly string[] };
    counts: SessionImportCounts;
    turns: SessionTurnCounts;
    markChanged: (collection: string, relPath: string) => void;
    pendingWithdrawals: PendingWithdrawal[];
  }): Promise<SessionUnitReceipt> {
    const { source, counts, turns } = options;
    const sessions = this.deps.config.sessions as SessionsConfig;
    let unit = options.unit;
    const base: SessionUnitReceipt = {
      sourceId: source.id,
      harness: unit.harness,
      locator: unit.locator,
      outcome: "unchanged",
      threads: 0,
      turns: 0,
      collections: [],
    };
    const setState = (patch: Partial<UnitState>): void => {
      if (options.dryRun) return;
      options.sourceState.units[options.key] = {
        locator: unit.locator,
        fingerprint: options.fingerprint,
        status: "failed",
        parser: null,
        redaction: redactionStamp(options.redaction),
        destinations: options.destinations,
        format: SESSION_ARCHIVE_FORMAT_VERSION,
        threads: options.previous?.threads ?? [],
        updatedAt: this.now.toISOString(),
        ...patch,
      };
    };

    if (source.harness === null) {
      const detected = await detectHarness(unit.path);
      if (!detected) {
        counts.unsupported += 1;
        setState({ status: "unsupported" });
        return {
          ...base,
          harness: null,
          outcome: "unsupported",
          reason: "format_not_recognised",
        };
      }
      unit = {
        ...unit,
        harness: detected,
        storage: /\.(?:sqlite|db)$/i.test(unit.path) ? "sqlite" : "jsonl",
      };
    }

    let parsed;
    try {
      parsed = await parseUnit(unit);
    } catch (error) {
      counts.failed += 1;
      setState({ status: "failed" });
      return {
        ...base,
        harness: unit.harness,
        outcome: "failed",
        reason: unitReason(error),
      };
    }
    const { diagnostics } = parsed;
    turns.injectedSkipped += diagnostics.injectedSkipped;
    turns.copiedHistorySkipped += diagnostics.copiedHistorySkipped;
    turns.overLimit +=
      diagnostics.overLimitTurns + diagnostics.overLimitRecords;
    const receiptWarnings: string[] = [];
    if (diagnostics.truncatedTail) {
      receiptWarnings.push(
        "final record is incomplete (file still being written)"
      );
    }
    if (diagnostics.threadsWithoutHuman > 0) {
      receiptWarnings.push(
        `${diagnostics.threadsWithoutHuman} main threads have assistant turns but no recognised human turn`
      );
    }
    if (diagnostics.threadsOverLimit > 0) {
      receiptWarnings.push(
        `${diagnostics.threadsOverLimit} threads beyond the per-unit thread limit were not read`
      );
    }
    if (diagnostics.humanTurnsMissing) {
      receiptWarnings.push(
        "assistant turns without any recognised human turn: possible format drift"
      );
    }
    if (diagnostics.malformedRecords > 0) {
      receiptWarnings.push(
        `${diagnostics.malformedRecords} malformed records skipped`
      );
    }
    if (diagnostics.overLimitRecords + diagnostics.overLimitTurns > 0) {
      receiptWarnings.push(
        `${diagnostics.overLimitRecords + diagnostics.overLimitTurns} over-limit records or turns skipped`
      );
    }
    if (parsed.threads.length === 0 && parsed.complete) {
      receiptWarnings.push("no conversation threads recognised");
    }

    const written: Array<{ collection: string; relPath: string }> = [];
    const collections = new Set<string>();
    let unitImported = 0;
    let unitUpdated = 0;
    let unitSkipped = 0;
    let unitTurns = 0;
    // Threads withheld by policy; an earlier archived copy is withdrawn too.
    const withdrawn = new Set<string>();
    const withhold = (thread: ParsedThread, warning: string): void => {
      counts.skippedPolicy += 1;
      unitSkipped += 1;
      receiptWarnings.push(warning);
      withdrawn.add(
        threadRelPath(source.id, thread.harness, options.key, thread.threadId)
      );
    };
    for (const thread of parsed.threads) {
      const destination = threadDestination(thread, source);
      if (destination === null) {
        withhold(
          thread,
          "a thread spans working directories mapped to different collections and was quarantined (mixed_domain)"
        );
        continue;
      }
      if (thread.turns.length >= SESSION_LIMITS.maxTurnsPerThread) {
        withhold(
          thread,
          "a thread reached the per-thread turn limit and was skipped rather than archived truncated (over_limit)"
        );
        continue;
      }
      archiveCollection(this.deps.config, sessions, destination);
      const rendered = renderThread({
        thread,
        sourceId: source.id,
        unitKey: options.key,
        unitLocator: unit.locator,
        parser: parsed.parser,
        redaction: options.redaction,
      });
      if (rendered.overLimit) {
        withhold(
          thread,
          "a thread exceeded the archive size limit and was skipped (over_limit)"
        );
        continue;
      }
      if (rendered.lines === 0) continue;
      turns.human += rendered.humanTurns;
      turns.assistant += rendered.assistantTurns;
      turns.redactions += rendered.redactions;
      unitTurns += rendered.lines;
      collections.add(destination);
      written.push({ collection: destination, relPath: rendered.relPath });
      const path = archiveFilePath(
        sessions.archiveRoot,
        destination,
        rendered.relPath
      );
      const existing = await readText(path);
      if (existing === rendered.content) {
        counts.unchanged += 1;
        // Re-sync anyway: a run interrupted after writing but before syncing
        // leaves an archive file the index has not seen. Syncing an unchanged
        // file is a cheap hash comparison.
        if (!options.dryRun) {
          options.markChanged(destination, rendered.relPath);
        }
        continue;
      }
      if (existing === null) {
        counts.imported += 1;
        unitImported += 1;
      } else {
        counts.updated += 1;
        unitUpdated += 1;
      }
      if (!options.dryRun) {
        await mkdir(dirname(path), { recursive: true });
        await atomicWrite(path, rendered.content);
        options.markChanged(destination, rendered.relPath);
      }
    }

    // A thread that moved to another collection leaves its old copy behind;
    // remove it so no stale searchable duplicate survives. Threads that are
    // simply absent from the source now stay archived and tracked.
    const retained: Array<{ collection: string; relPath: string }> = [];
    const keep = new Set(
      written.map((item) => `${item.collection}\0${item.relPath}`)
    );
    for (const old of options.previous?.threads ?? []) {
      if (withdrawn.has(old.relPath)) {
        // Stays tracked until the index sync confirms the removal, so a
        // failed sync is retried by the next run.
        retained.push(old);
        if (!options.dryRun) {
          await this.withdraw(sessions, old, options.markChanged);
          options.pendingWithdrawals.push({
            units: options.sourceState.units,
            key: options.key,
            thread: old,
          });
        }
        continue;
      }
      const moved =
        !keep.has(`${old.collection}\0${old.relPath}`) &&
        written.some((item) => item.relPath === old.relPath);
      if (!moved) {
        retained.push(old);
        continue;
      }
      if (!options.dryRun) {
        const oldPath = archiveFilePath(
          sessions.archiveRoot,
          old.collection,
          old.relPath
        );
        await unlink(oldPath).catch(() => undefined);
        options.markChanged(old.collection, old.relPath);
      }
    }

    // Dropped malformed input keeps the unit incomplete, so it is retried and
    // never reported as fully imported.
    const complete = parsed.complete && diagnostics.malformedRecords === 0;
    if (!complete) counts.incomplete += 1;
    setState({
      status: complete ? "complete" : "incomplete",
      harness: unit.harness,
      parser: parsed.parser,
      threads: mergeThreads(retained, written),
    });

    let outcome: SessionUnitReceipt["outcome"] = "unchanged";
    if (!complete) outcome = "incomplete";
    else if (unitImported > 0) outcome = "imported";
    else if (unitUpdated > 0) outcome = "updated";
    else if (unitSkipped > 0 && written.length === 0)
      outcome = "skipped_policy";

    const unknownKinds = Object.keys(diagnostics.unknownKinds).length
      ? diagnostics.unknownKinds
      : undefined;
    return {
      ...base,
      harness: unit.harness,
      outcome,
      ...(outcome === "incomplete"
        ? {
            reason: diagnostics.truncatedTail
              ? "truncated_tail"
              : diagnostics.threadsOverLimit > 0
                ? "over_limit"
                : diagnostics.malformedRecords > 0
                  ? "malformed_records"
                  : "format_drift",
          }
        : {}),
      threads: written.length,
      turns: unitTurns,
      collections: [...collections].sort(),
      ...(unknownKinds ? { unknownKinds } : {}),
      ...(receiptWarnings.length > 0 ? { warnings: receiptWarnings } : {}),
    };
  }

  /**
   * Rescan the archive of a unit whose source is gone. Files that no longer
   * parse are moved out of their collection (withheld from retrieval) and
   * counted; the caller only records the new redaction stamp when none were.
   */
  private async rescanUnavailable(
    sessions: SessionsConfig,
    unitState: UnitState,
    redaction: { literals: readonly string[] },
    markChanged: (collection: string, relPath: string) => void
  ): Promise<number> {
    let withheld = 0;
    for (const thread of unitState.threads) {
      // Always resync: a rescan whose earlier sync failed left the archive
      // already rewritten, and the index must still catch up.
      markChanged(thread.collection, thread.relPath);
      const path = archiveFilePath(
        sessions.archiveRoot,
        thread.collection,
        thread.relPath
      );
      const content = await readText(path);
      if (content === null) {
        if (
          await Bun.file(
            withheldPath(
              sessions.archiveRoot,
              thread.collection,
              thread.relPath
            )
          ).exists()
        ) {
          withheld += 1;
        }
        continue;
      }
      const rescanned = rescanArchiveContent(content, redaction);
      if (!rescanned) {
        await this.withdraw(sessions, thread, markChanged);
        withheld += 1;
        continue;
      }
      if (rescanned.content !== content) {
        await atomicWrite(path, rescanned.content);
      }
    }
    return withheld;
  }

  /** Move an archive file out of its collection (out of retrieval). */
  private async withdraw(
    sessions: SessionsConfig,
    thread: { collection: string; relPath: string },
    markChanged: (collection: string, relPath: string) => void
  ): Promise<void> {
    const path = archiveFilePath(
      sessions.archiveRoot,
      thread.collection,
      thread.relPath
    );
    markChanged(thread.collection, thread.relPath);
    if (!(await Bun.file(path).exists())) return;
    const aside = withheldPath(
      sessions.archiveRoot,
      thread.collection,
      thread.relPath
    );
    await mkdir(dirname(aside), { recursive: true });
    await rename(path, aside);
  }

  private async syncChanged(
    sessions: SessionsConfig,
    changed: Map<string, Set<string>>
  ): Promise<SessionImportReceipt["lexical"]> {
    const store = this.deps.store;
    if (!store || changed.size === 0) {
      return { status: "ready", collections: [] };
    }
    const database = store.getRawDb();
    writeIndexBinding(
      database,
      await canonicalConfigPath(this.deps.configPath)
    );
    const syncService = this.deps.syncService ?? defaultSyncService;
    const names = [...changed.keys()].sort();
    for (const name of names) {
      const collection = archiveCollection(this.deps.config, sessions, name);
      const relPaths = [...(changed.get(name) ?? [])].sort();
      try {
        const result = await syncService.syncPaths(
          collection,
          store,
          relPaths,
          withContentTypeRules(
            { runUpdateCmd: false, gitPull: false },
            this.deps.config
          )
        );
        const failed = (result.files ?? []).find(
          (file) => file.status === "error"
        );
        if (failed) {
          return {
            status: "failed",
            collections: names,
            error: `${name}: ${failed.errorCode ?? "sync_error"}; the next import retries the sync.`,
          };
        }
      } catch {
        // The message can carry host paths; receipts stay path-free.
        return {
          status: "failed",
          collections: names,
          error: `${name}: sync_failed; the next import retries the sync.`,
        };
      }
    }
    return { status: "ready", collections: names };
  }

  private async embeddingBacklog(): Promise<number | null> {
    const status = await this.deps.store?.getStatus();
    return status?.ok ? status.value.embeddingBacklog : null;
  }

  /**
   * Preview (or apply) removal of archived threads whose source unit no
   * longer exists. Source deletion alone never removes archive files.
   */
  async prune(options: {
    sourceId: string;
    apply: boolean;
  }): Promise<SessionPrunePreview> {
    const sessions = requireSessionsConfig(this.deps.config);
    if (!options.apply) {
      return (await this.planPrune(sessions, options.sourceId)).preview;
    }
    if (!this.deps.store) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "An open archive index is required to prune."
      );
    }
    const lock = await acquireWriteLock(
      importLockPath(sessions.archiveRoot),
      IMPORT_LOCK_WAIT_MS
    );
    if (!lock) {
      throw new SessionsError(
        "SESSIONS_BUSY",
        "A session import is running for this archive; retry when it finishes."
      );
    }
    try {
      // Plan under the lock so a concurrent import cannot change the state
      // this run acts on.
      const plan = await this.planPrune(sessions, options.sourceId);
      if (plan.removable.length === 0 || !plan.sourceState) return plan.preview;
      const changed = new Map<string, Set<string>>();
      for (const [, unit] of plan.removable) {
        for (const thread of unit.threads) {
          if (plan.referenced.has(`${thread.collection}\0${thread.relPath}`)) {
            continue;
          }
          await unlink(
            archiveFilePath(
              sessions.archiveRoot,
              thread.collection,
              thread.relPath
            )
          ).catch(() => undefined);
          const set = changed.get(thread.collection) ?? new Set<string>();
          set.add(thread.relPath);
          changed.set(thread.collection, set);
        }
      }
      const lexical = await this.syncChanged(sessions, changed);
      if (lexical.status === "failed") {
        // State keeps the units, so the next prune retries the removal.
        return { ...plan.preview, error: lexical.error };
      }
      for (const [key] of plan.removable) delete plan.sourceState.units[key];
      await saveState(sessions.archiveRoot, plan.state);
      return { ...plan.preview, applied: true };
    } finally {
      await lock.release();
    }
  }

  private async planPrune(sessions: SessionsConfig, sourceId: string) {
    const source = sessions.sources.find((item) => item.id === sourceId);
    const state = await loadState(sessions.archiveRoot);
    const sourceState = state.sources[sourceId];
    if (!source && !sourceState) {
      throw new SessionsError(
        "SESSIONS_UNKNOWN_SOURCE",
        `Unknown session source "${sourceId}".`
      );
    }
    const present = new Set<string>();
    let canonical: string | null = null;
    if (source) {
      try {
        canonical = await realpath(source.path);
      } catch (error) {
        // Only a root that is really gone counts as deleted; a root that
        // cannot be resolved (for example an unreadable parent) is unread.
        if (readFailureReason(error) !== "source_missing") {
          throw new SessionsError(
            "SESSIONS_SOURCE_UNAVAILABLE",
            `Session source "${sourceId}" could not be read completely; prune needs a complete listing.`
          );
        }
      }
    }
    if (source && canonical) {
      // Prune removes archives whose unit is absent, so it runs only over a
      // complete listing: an unread part of the source is not a deletion.
      let enumerated;
      try {
        enumerated = await enumerateUnits({
          harness: source.harness,
          root: canonical,
          excluded: protectedRoots(sessions),
          readDirectory: this.deps.readDirectory,
        });
      } catch {
        enumerated = null;
      }
      if (
        !enumerated ||
        enumerated.truncated ||
        enumerated.unreadable.length > 0
      ) {
        throw new SessionsError(
          "SESSIONS_SOURCE_UNAVAILABLE",
          `Session source "${sourceId}" could not be read completely; prune needs a complete listing.`
        );
      }
      for (const unit of enumerated.units) {
        present.add(unitKey(source.id, unit.locator));
      }
    }
    const entries = Object.entries(sourceState?.units ?? {});
    const removable = entries.filter(([key]) => !present.has(key));
    // A file a present unit still references is never removed.
    const referenced = new Set(
      entries
        .filter(([key]) => present.has(key))
        .flatMap(([, unit]) =>
          unit.threads.map(
            (thread) => `${thread.collection}\0${thread.relPath}`
          )
        )
    );
    const preview: SessionPrunePreview = {
      schemaVersion: "1",
      sourceId,
      applied: false,
      units: removable.map(([, unit]) => ({
        locator: sanitizeValue(unit.locator, {
          literals: sessions.redaction?.literals ?? [],
        }),
        threads: unit.threads.length,
      })),
      archiveFiles: removable.reduce(
        (sum, [, unit]) =>
          sum +
          unit.threads.filter(
            (thread) =>
              !referenced.has(`${thread.collection}\0${thread.relPath}`)
          ).length,
        0
      ),
    };
    return { preview, removable, referenced, state, sourceState };
  }
}

function mergeThreads(
  previous: Array<{ collection: string; relPath: string }>,
  written: Array<{ collection: string; relPath: string }>
): Array<{ collection: string; relPath: string }> {
  const merged = new Map<string, { collection: string; relPath: string }>();
  for (const item of [...previous, ...written]) {
    merged.set(`${item.collection}\0${item.relPath}`, item);
  }
  return [...merged.values()];
}

async function countArchiveFiles(root: string): Promise<number> {
  let count = 0;
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  return count;
}

async function sampleVersions(
  units: readonly SessionUnit[]
): Promise<string[]> {
  const versions = new Set<string>();
  const newest = [...units].sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const unit of newest.slice(0, 3)) {
    try {
      const parsed = await parseUnit(unit);
      if (parsed.diagnostics.formatVersion) {
        versions.add(parsed.diagnostics.formatVersion);
      }
    } catch {
      // Discovery reports structure only; unreadable samples are skipped.
    }
  }
  return [...versions].sort();
}
