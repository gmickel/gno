/**
 * gno sessions: discover, init, source, import, status and prune.
 *
 * Thin adapters over the transport-neutral sessions service. Nothing here
 * runs automatically; every import is an explicit invocation bound to one
 * archive config/index pair.
 *
 * @module src/cli/commands/sessions
 */

import type { Config } from "../../config/types";

import { getIndexDbPath } from "../../app/constants";
import { getConfigPaths, isInitialized, loadConfig } from "../../config";
import { assertSessionBinding } from "../../sessions/binding";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
  type SessionPrunePreview,
  SessionsService,
} from "../../sessions/service";
import {
  SESSION_HARNESSES,
  type SessionHarness,
  type SessionImportReceipt,
  type SessionsDiscovery,
  SessionsError,
  type SessionsStatus,
  SESSIONS_VALIDATION_CODES,
} from "../../sessions/types";
import { CliError } from "../errors";
import { initStore } from "./shared";

export interface SessionsCliContext {
  configPath?: string;
  indexName: string;
}

/** Map a service error onto the CLI error model. */
export function toCliError(error: unknown): unknown {
  if (!(error instanceof SessionsError)) return error;
  if (error.code === "SESSIONS_BUSY") {
    return new CliError("BUSY", error.message, {
      details: { sessionsCode: error.code },
    });
  }
  return new CliError(
    SESSIONS_VALIDATION_CODES.has(error.code) ? "VALIDATION" : "RUNTIME",
    error.message,
    { details: { sessionsCode: error.code } }
  );
}

async function withCliErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toCliError(error);
  }
}

function requireArchivePair(context: SessionsCliContext): string {
  if (!context.configPath) {
    throw new CliError(
      "VALIDATION",
      "Session commands need the archive pair explicitly: gno --config <archive.yml> --index <name> sessions ...",
      { details: { sessionsCode: "SESSIONS_NOT_CONFIGURED" } }
    );
  }
  return context.configPath;
}

async function loadArchiveConfig(
  context: SessionsCliContext
): Promise<{ config: Config; configPath: string }> {
  const configPath = requireArchivePair(context);
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) {
    throw new CliError("VALIDATION", loaded.error.message, {
      details: { sessionsCode: "SESSIONS_NOT_CONFIGURED" },
    });
  }
  await assertSessionBinding({
    config: loaded.value,
    configPath,
    indexName: context.indexName,
    dbPath: getIndexDbPath(context.indexName),
  });
  return { config: loaded.value, configPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export function discoverSessions(
  context: SessionsCliContext
): Promise<SessionsDiscovery> {
  return withCliErrors(async () => {
    let config: Config | undefined;
    const path = context.configPath ?? getConfigPaths().configFile;
    if (await isInitialized(context.configPath)) {
      const loaded = await loadConfig(path);
      if (loaded.ok) config = loaded.value;
    }
    const service = new SessionsService({
      config: config ?? ({ collections: [] } as unknown as Config),
      configPath: path,
      indexName: context.indexName,
    });
    return service.discover();
  });
}

export function initSessions(
  context: SessionsCliContext,
  options: { archive?: string; collection?: string }
): Promise<{
  configPath: string;
  index: string;
  archiveRoot: string;
  collection: string;
  created: boolean;
}> {
  return withCliErrors(async () => {
    const configPath = requireArchivePair(context);
    if (!options.archive || !options.collection) {
      throw new SessionsError(
        "SESSIONS_DESTINATION_REQUIRED",
        "sessions init needs --archive <dir> and --collection <name>."
      );
    }
    const result = await initSessionArchive({
      configPath,
      indexName: context.indexName,
      archiveRoot: options.archive,
      collection: options.collection,
    });
    return {
      configPath,
      index: context.indexName,
      archiveRoot: result.archiveRoot,
      collection: options.collection,
      created: result.created,
    };
  });
}

export function parseProjectMappings(
  values: readonly string[]
): Array<{ prefix: string; collection: string }> {
  return values.map((value) => {
    const split = value.lastIndexOf("=");
    const prefix = split > 0 ? value.slice(0, split) : "";
    const collection = split > 0 ? value.slice(split + 1) : "";
    if (!prefix || !collection) {
      throw new CliError(
        "VALIDATION",
        "--project expects <absolute-prefix>=<collection>",
        { details: { sessionsCode: "SESSIONS_INVALID_INPUT" } }
      );
    }
    return { prefix, collection };
  });
}

function parseHarness(value: unknown): SessionHarness | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (SESSION_HARNESSES as readonly string[]).includes(value)
  ) {
    return value as SessionHarness;
  }
  throw new CliError(
    "VALIDATION",
    `Unsupported format "${typeof value === "string" ? value : "?"}". Supported: ${SESSION_HARNESSES.join(", ")}.`,
    { details: { sessionsCode: "SESSIONS_UNSUPPORTED_FORMAT" } }
  );
}

export function addSource(
  context: SessionsCliContext,
  options: {
    id: string;
    harness?: string;
    path?: string;
    collection?: string;
    projects?: string[];
  }
): Promise<{ id: string; registered: true }> {
  return withCliErrors(async () => {
    const { configPath } = await loadArchiveConfig(context);
    const harness = parseHarness(options.harness);
    if (!harness || !options.path || !options.collection) {
      throw new SessionsError(
        "SESSIONS_INVALID_INPUT",
        "sessions source add needs --harness, --path and --collection."
      );
    }
    await addSessionSource({
      configPath,
      id: options.id,
      harness,
      path: options.path,
      collection: options.collection,
      projects: parseProjectMappings(options.projects ?? []),
    });
    return { id: options.id, registered: true };
  });
}

export function removeSource(
  context: SessionsCliContext,
  id: string
): Promise<{ id: string; removed: true; archiveRetained: true }> {
  return withCliErrors(async () => {
    const { configPath } = await loadArchiveConfig(context);
    await removeSessionSource({ configPath, id });
    return { id, removed: true, archiveRetained: true };
  });
}

function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError("VALIDATION", "--limit must be a positive integer.", {
      details: { sessionsCode: "SESSIONS_INVALID_INPUT" },
    });
  }
  return value;
}

export function importSessions(
  context: SessionsCliContext,
  options: {
    paths: string[];
    source?: string;
    collection?: string;
    format?: string;
    dryRun?: boolean;
    limit?: unknown;
  }
): Promise<SessionImportReceipt> {
  return withCliErrors(async () => {
    const { config, configPath } = await loadArchiveConfig(context);
    const format = parseHarness(options.format);
    const limit = parseLimit(options.limit);
    const input = {
      sourceId: options.source,
      paths: options.paths,
      collection: options.collection,
      format,
      dryRun: options.dryRun === true,
      limit,
    };
    if (input.dryRun) {
      return new SessionsService({
        config,
        configPath,
        indexName: context.indexName,
      }).import(input, { allowPaths: true });
    }
    const opened = await initStore({
      configPath,
      indexName: context.indexName,
      allowEmptyCollections: true,
    });
    if (!opened.ok) {
      throw new CliError("RUNTIME", opened.error);
    }
    try {
      return await new SessionsService({
        config: opened.config,
        configPath,
        indexName: context.indexName,
        store: opened.store,
      }).import(input, { allowPaths: true });
    } finally {
      await opened.store.close();
    }
  });
}

export function sessionsStatus(
  context: SessionsCliContext
): Promise<SessionsStatus> {
  return withCliErrors(async () => {
    const { config, configPath } = await loadArchiveConfig(context);
    return new SessionsService({
      config,
      configPath,
      indexName: context.indexName,
    }).status();
  });
}

export function pruneSessions(
  context: SessionsCliContext,
  options: { source?: string; apply?: boolean }
): Promise<SessionPrunePreview> {
  return withCliErrors(async () => {
    if (!options.source) {
      throw new SessionsError(
        "SESSIONS_SELECTION_REQUIRED",
        "sessions prune needs --source <id>."
      );
    }
    const { config, configPath } = await loadArchiveConfig(context);
    if (!options.apply) {
      return new SessionsService({
        config,
        configPath,
        indexName: context.indexName,
      }).prune({ sourceId: options.source, apply: false });
    }
    const opened = await initStore({
      configPath,
      indexName: context.indexName,
      allowEmptyCollections: true,
    });
    if (!opened.ok) throw new CliError("RUNTIME", opened.error);
    try {
      return await new SessionsService({
        config: opened.config,
        configPath,
        indexName: context.indexName,
        store: opened.store,
      }).prune({ sourceId: options.source, apply: true });
    } finally {
      await opened.store.close();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function formatDiscovery(
  result: SessionsDiscovery,
  asJson: boolean
): string {
  if (asJson) return json(result);
  if (result.candidates.length === 0) {
    return "No supported local session sources found (Codex, Claude Code, OpenClaw, Hermes).";
  }
  const lines = ["Supported local session sources (nothing imported):", ""];
  for (const candidate of result.candidates) {
    lines.push(
      `- ${candidate.harness}: ${candidate.path}`,
      `  units: ${candidate.units}${candidate.truncated ? "+" : ""}, ${(candidate.bytes / 1024 / 1024).toFixed(1)} MiB, versions: ${candidate.formatVersions.join(", ") || "unknown"}${candidate.registeredAs ? `, registered as ${candidate.registeredAs}` : ""}`
    );
  }
  lines.push(
    "",
    "Import explicitly: gno --config <archive.yml> --index <name> sessions import --source <id>"
  );
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatImportReceipt(
  receipt: SessionImportReceipt,
  asJson: boolean
): string {
  if (asJson) return json(receipt);
  const c = receipt.counts;
  const lines = [
    `Session import ${receipt.dryRun ? "(dry run, nothing written) " : ""}${receipt.status}`,
    `threads: ${c.imported} imported, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skippedPolicy} skipped by policy`,
    `units: ${c.incomplete} incomplete, ${c.failed} failed, ${c.unsupported} unsupported${receipt.deferredUnits > 0 ? `, ${receipt.deferredUnits} deferred by --limit` : ""}`,
    `turns: ${receipt.turns.human} human, ${receipt.turns.assistant} assistant, ${receipt.turns.redactions} redactions, ${receipt.turns.injectedSkipped} injected skipped`,
    `lexical: ${receipt.lexical.status}${receipt.lexical.error ? ` (${receipt.lexical.error})` : ""}; embedding backlog: ${receipt.embedding.backlog ?? "n/a"}`,
  ];
  const notable = receipt.units.filter(
    (unit) =>
      unit.outcome !== "unchanged" &&
      unit.outcome !== "imported" &&
      unit.outcome !== "updated"
  );
  for (const unit of notable.slice(0, 20)) {
    lines.push(
      `- ${unit.sourceId} ${unit.locator}: ${unit.outcome}${unit.reason ? ` (${unit.reason})` : ""}`
    );
  }
  for (const warning of receipt.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatStatus(status: SessionsStatus, asJson: boolean): string {
  if (asJson) return json(status);
  const lines = [`Session archive (index ${status.index})`];
  for (const collection of status.collections) {
    lines.push(
      `- collection ${collection.name}: ${collection.threads} threads`
    );
  }
  for (const source of status.sources) {
    lines.push(
      `- source ${source.id} (${source.harness} -> ${source.collection}): ${source.available ? "available" : "UNAVAILABLE"}; units ${source.units.complete} complete, ${source.units.incomplete} incomplete, ${source.units.failed} failed, ${source.units.pending} pending; last import ${source.lastImportAt ?? "never"}`
    );
    if (source.sourceUnavailable > 0) {
      lines.push(
        `  ${source.sourceUnavailable} archived units no longer have a source (archive retained${source.staleParser > 0 ? `, ${source.staleParser} from an older parser` : ""})`
      );
    }
  }
  for (const warning of status.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatPrune(
  result: SessionPrunePreview,
  asJson: boolean
): string {
  if (asJson) return json(result);
  if (result.units.length === 0) {
    return `Nothing to prune for ${result.sourceId}: every archived unit still has a source.`;
  }
  const lines = [
    `${result.applied ? "Pruned" : "Would prune"} ${result.archiveFiles} archive files from ${result.units.length} units whose source is gone (${result.sourceId}):`,
    ...result.units
      .slice(0, 50)
      .map((unit) => `- ${unit.locator} (${unit.threads} threads)`),
  ];
  if (!result.applied)
    lines.push("", "Re-run with --apply to delete these archive files.");
  return lines.join("\n");
}
