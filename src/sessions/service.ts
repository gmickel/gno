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
import { mkdir, readdir, unlink } from "node:fs/promises";
// node:path: no Bun path utilities.
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Collection, Config } from "../config/types";
import type { SessionSourceConfig, SessionsConfig } from "./config";

import { getIndexDbPath, resolveDirs } from "../app/constants";
import { canonicalizeIndexName, isValidIndexName } from "../app/index-name";
import { createDefaultConfig, getConfigPaths, loadConfig } from "../config";
import { applyConfigFileChange } from "../core/config-mutation";
import { acquireWriteLock } from "../core/file-lock";
import { atomicWrite } from "../core/file-ops";
import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { SqliteAdapter } from "../store/sqlite/adapter";
import {
  archiveFilePath,
  renderThread,
  rescanArchiveContent,
  SESSION_ARCHIVE_FIELD_MAPPING,
  SESSION_STATE_DIRNAME,
} from "./archive";
import {
  canonicalConfigPath,
  readIndexBinding,
  writeIndexBinding,
} from "./binding";
import { redactionStamp } from "./sanitize";
import {
  assertSafeSourceRoot,
  canonicalPath,
  defaultDiscoveryRoots,
  detectHarness,
  detectRootHarness,
  enumerateUnits,
  isWithin,
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
} from "./state";
import {
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
const MAX_IMPORT_LIMIT = 100_000;
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
}

interface ResolvedSource {
  id: string;
  harness: SessionHarness | null;
  root: string;
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

function archiveCollection(
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
  if (/ENOENT|no such file/i.test(message)) return "source_missing";
  if (/EACCES|EPERM|permission/i.test(message)) return "permission_denied";
  return "read_failed";
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
        });
      } catch {
        warnings.push(`${root.harness}: source root could not be read`);
        continue;
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
      if (canonical) {
        try {
          units = (
            await enumerateUnits({
              harness: source.harness,
              root: canonical,
              excluded: protectedRoots(sessions),
            })
          ).units;
        } catch {
          warnings.push(`${source.id}: source could not be read`);
        }
      }
      const present = new Set<string>();
      let pending = 0;
      for (const unit of units) {
        const key = unitKey(unit.path);
        present.add(key);
        const previous = known[key];
        if (
          !previous ||
          previous.status !== "complete" ||
          previous.fingerprint !== (await unitFingerprint(unit).catch(() => ""))
        ) {
          pending += 1;
        }
      }
      const stateUnits = Object.entries(known);
      sources.push({
        id: source.id,
        harness: source.harness,
        collection: source.collection,
        available: canonical !== null,
        units: {
          total: units.length,
          complete: stateUnits.filter(([, unit]) => unit.status === "complete")
            .length,
          incomplete: stateUnits.filter(
            ([, unit]) => unit.status === "incomplete"
          ).length,
          failed: stateUnits.filter(
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
      const canonical = await canonicalPath(source.path);
      if (!canonical) {
        throw new SessionsError(
          "SESSIONS_SOURCE_UNAVAILABLE",
          `Session source "${source.id}" is not readable right now; its archive is retained.`
        );
      }
      assertSafeSourceRoot(canonical, protectedRoots(sessions));
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
    const resolved: ResolvedSource[] = [];
    for (const path of paths) {
      if (!isAbsolute(path)) {
        throw new SessionsError(
          "SESSIONS_INVALID_INPUT",
          "Session paths must be absolute."
        );
      }
      const canonical = await canonicalPath(path);
      if (!canonical) {
        throw new SessionsError(
          "SESSIONS_SOURCE_UNAVAILABLE",
          "A selected session path does not exist or is not readable."
        );
      }
      assertSafeSourceRoot(canonical, protectedRoots(sessions));
      resolved.push({
        id: `${PATH_SOURCE_PREFIX}${unitKey(canonical).slice(0, 12)}`,
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

    for (const source of sources) {
      const sourceState: SourceState = state.sources[source.id] ?? {
        lastImportAt: null,
        units: {},
      };
      let enumerated: { units: SessionUnit[]; truncated: boolean };
      try {
        const harness =
          source.harness ?? (await detectRootHarness(source.root, excluded));
        enumerated = harness
          ? await enumerateUnits({ harness, root: source.root, excluded })
          : { units: [], truncated: false };
        if (!harness) {
          counts.unsupported += 1;
          recordUnit({
            sourceId: source.id,
            harness: null,
            locator: ".",
            outcome: "unsupported",
            reason: "format_not_recognised",
            threads: 0,
            turns: 0,
            collections: [],
          });
          continue;
        }
      } catch (error) {
        counts.failed += 1;
        recordUnit({
          sourceId: source.id,
          harness: source.harness,
          locator: ".",
          outcome: "failed",
          reason: unitReason(error),
          threads: 0,
          turns: 0,
          collections: [],
        });
        continue;
      }
      if (enumerated.truncated) {
        warnings.push(
          `${source.id}: more than ${SESSION_LIMITS.maxUnitsPerSource} units; the rest are left for a later run`
        );
      }
      const present = new Set<string>();
      for (const unit of enumerated.units) {
        const key = unitKey(unit.path);
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
          previous.format === SESSION_ARCHIVE_FORMAT_VERSION;
        if (current) continue;
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
        const outcome = await this.importUnit({
          source,
          unit,
          key,
          fingerprint,
          previous,
          sourceState,
          dryRun: options.dryRun,
          redaction,
          counts,
          turns,
          markChanged,
        });
        recordUnit(outcome);
      }

      // Units whose source vanished keep their archive. Stale redaction is
      // rescanned in place from the durable sanitized archive.
      for (const [key, unitState] of Object.entries(sourceState.units)) {
        if (present.has(key)) continue;
        if (unitState.redaction !== stamp && !options.dryRun) {
          await this.rescanUnavailable(
            sessions,
            unitState,
            redaction,
            markChanged
          );
        }
        if (
          unitState.parser !== null &&
          (unitState.format !== SESSION_ARCHIVE_FORMAT_VERSION ||
            unitState.parser !==
              SESSION_PARSERS[unitState.harness ?? source.harness ?? "codex"])
        ) {
          warnings.push(
            `${source.id}: ${unitState.locator} was archived by an older parser and its source is unavailable; the archive is retained without reparsing`
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
      await saveState(sessions.archiveRoot, state);
      lexical = await this.syncChanged(sessions, changed);
      backlog = await this.embeddingBacklog();
    }

    const failures = counts.failed + counts.incomplete + counts.unsupported;
    const work =
      counts.imported +
      counts.updated +
      counts.unchanged +
      counts.skippedPolicy;
    let status: SessionImportReceipt["status"] = "complete";
    if (failures > 0 && work === 0 && counts.failed > 0) status = "failed";
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
    fingerprint: string;
    previous: UnitState | undefined;
    sourceState: SourceState;
    dryRun: boolean;
    redaction: { literals: readonly string[] };
    counts: SessionImportCounts;
    turns: SessionTurnCounts;
    markChanged: (collection: string, relPath: string) => void;
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
    for (const thread of parsed.threads) {
      const destination = threadDestination(thread, source);
      if (destination === null) {
        counts.skippedPolicy += 1;
        unitSkipped += 1;
        receiptWarnings.push(
          "a thread spans working directories mapped to different collections and was quarantined (mixed_domain)"
        );
        continue;
      }
      archiveCollection(this.deps.config, sessions, destination);
      const rendered = renderThread({
        thread,
        sourceId: source.id,
        unitLocator: unit.locator,
        parser: parsed.parser,
        redaction: options.redaction,
      });
      if (rendered.overLimit) {
        counts.skippedPolicy += 1;
        unitSkipped += 1;
        receiptWarnings.push(
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

    const complete = parsed.complete;
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

  private async rescanUnavailable(
    sessions: SessionsConfig,
    unitState: UnitState,
    redaction: { literals: readonly string[] },
    markChanged: (collection: string, relPath: string) => void
  ): Promise<void> {
    for (const thread of unitState.threads) {
      const path = archiveFilePath(
        sessions.archiveRoot,
        thread.collection,
        thread.relPath
      );
      const content = await readText(path);
      if (content === null) continue;
      const rescanned = rescanArchiveContent(content, redaction);
      if (!rescanned) continue;
      if (rescanned.content !== content) {
        await atomicWrite(path, rescanned.content);
        markChanged(thread.collection, thread.relPath);
      }
    }
    unitState.redaction = redactionStamp(redaction);
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
            error: `${name}: ${failed.errorCode ?? "sync error"}. Run gno update with the archive config to retry.`,
          };
        }
      } catch (error) {
        return {
          status: "failed",
          collections: names,
          error: `${name}: ${error instanceof Error ? error.message : String(error)}`,
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
    const source = sessions.sources.find(
      (item) => item.id === options.sourceId
    );
    const state = await loadState(sessions.archiveRoot);
    const sourceState = state.sources[options.sourceId];
    if (!source && !sourceState) {
      throw new SessionsError(
        "SESSIONS_UNKNOWN_SOURCE",
        `Unknown session source "${options.sourceId}".`
      );
    }
    const present = new Set<string>();
    const canonical = source ? await canonicalPath(source.path) : null;
    if (source && canonical) {
      const { units } = await enumerateUnits({
        harness: source.harness,
        root: canonical,
        excluded: protectedRoots(sessions),
      });
      for (const unit of units) present.add(unitKey(unit.path));
    }
    const removable = Object.entries(sourceState?.units ?? {}).filter(
      ([key]) => !present.has(key)
    );
    const preview: SessionPrunePreview = {
      schemaVersion: "1",
      sourceId: options.sourceId,
      applied: false,
      units: removable.map(([, unit]) => ({
        locator: unit.locator,
        threads: unit.threads.length,
      })),
      archiveFiles: removable.reduce(
        (sum, [, unit]) => sum + unit.threads.length,
        0
      ),
    };
    if (!options.apply || removable.length === 0 || !sourceState)
      return preview;
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
      const changed = new Map<string, Set<string>>();
      for (const [key, unit] of removable) {
        for (const thread of unit.threads) {
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
        delete sourceState.units[key];
      }
      await saveState(sessions.archiveRoot, state);
      await this.syncChanged(sessions, changed);
    } finally {
      await lock.release();
    }
    return { ...preview, applied: true };
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

// ─────────────────────────────────────────────────────────────────────────────
// Configuration mutations (owner-local surfaces only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record the archive binding in the index at init time, so the index refuses
 * other configs before the first import has written anything.
 */
async function bindArchiveIndex(
  configPath: string,
  indexName: string,
  archiveRoot: string
): Promise<void> {
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
    writeIndexBinding(db, canonical);
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

export function archiveCollectionDefinition(
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
  const insideGnoDirs = (path: string): boolean =>
    protectedRoots(undefined).some((root) => isWithin(resolve(root), path));
  if (!insideGnoDirs(resolve(input.archiveRoot))) {
    await mkdir(input.archiveRoot, { recursive: true });
  }
  const archiveRoot =
    (await canonicalPath(input.archiveRoot)) ?? resolve(input.archiveRoot);
  for (const root of [archiveRoot]) {
    if (insideGnoDirs(root)) {
      throw new SessionsError(
        "SESSIONS_UNSAFE_PATH",
        "The archive must live outside GNO's config/data/cache directories, which reset and cleanup may remove."
      );
    }
  }
  await bindArchiveIndex(input.configPath, input.indexName, archiveRoot);
  let created = false;
  const result = await applyConfigFileChange(
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
          resolve(current.path) !== resolve(join(archiveRoot, input.collection))
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
  const canonical = await canonicalPath(input.path);
  if (!canonical) {
    throw new SessionsError(
      "SESSIONS_SOURCE_UNAVAILABLE",
      "The source path does not exist or is not readable."
    );
  }
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
