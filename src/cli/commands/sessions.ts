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
import { acquireCliWriteLease } from "../../core/write-lease";
import {
  type AutomationContext,
  admitHookTrigger,
  disableAutomation,
  enableAutomation,
  type HookAdmission,
  previewAutomationProfile,
  removeAutomationProfile,
  runAutomationProfile,
  type SessionAutomationChange,
  type SessionAutomationPreview,
  setAutomationProfile,
} from "../../sessions/automation";
import { HOOK_ADMISSION_DEADLINE_MS } from "../../sessions/automation-state";
import {
  formatAutomationRunText,
  formatImportReceiptText,
  formatStatusText,
} from "../../sessions/format";
import {
  type SessionPrunePreview,
  SessionsService,
} from "../../sessions/service";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../sessions/setup";
import {
  SESSION_HARNESSES,
  type SessionAutomationRunResult,
  type SessionHarness,
  type SessionImportReceipt,
  type SessionsDiscovery,
  SessionsError,
  type SessionsStatus,
  SESSIONS_VALIDATION_CODES,
} from "../../sessions/types";
import { SqliteAdapter } from "../../store/sqlite/adapter";
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

function parseProjectMappings(
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
// Automation (opt-in hooks and daemon schedules)
// ─────────────────────────────────────────────────────────────────────────────

function automationContext(context: SessionsCliContext): AutomationContext {
  return {
    configPath: requireArchivePair(context),
    indexName: context.indexName,
  };
}

function parseOptionalInt(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliError(
      "VALIDATION",
      `${flag} must be a non-negative integer.`,
      {
        details: { sessionsCode: "SESSIONS_INVALID_INPUT" },
      }
    );
  }
  return value;
}

export function setAutomation(
  context: SessionsCliContext,
  id: string,
  options: {
    sources: string[];
    cadence?: string;
    limit?: unknown;
    retries?: unknown;
  }
): Promise<SessionAutomationPreview> {
  return withCliErrors(() =>
    setAutomationProfile(automationContext(context), {
      id,
      sources: options.sources,
      cadence: options.cadence,
      limit: parseOptionalInt(options.limit, "--limit"),
      retries: parseOptionalInt(options.retries, "--retries"),
    })
  );
}

export function previewAutomation(
  context: SessionsCliContext,
  id: string,
  options: { settings?: string }
): Promise<SessionAutomationPreview> {
  return withCliErrors(() =>
    previewAutomationProfile(automationContext(context), id, options)
  );
}

export function enableAutomationCli(
  context: SessionsCliContext,
  id: string,
  options: {
    hook?: string;
    settings?: string;
    schedule?: boolean;
    cadence?: string;
  }
): Promise<SessionAutomationPreview> {
  return withCliErrors(() =>
    enableAutomation(automationContext(context), id, {
      ...(options.hook
        ? { hook: { harness: options.hook, settings: options.settings } }
        : {}),
      ...(options.schedule ? { schedule: { cadence: options.cadence } } : {}),
    })
  );
}

export function disableAutomationCli(
  context: SessionsCliContext,
  id: string,
  options: { hook?: boolean; schedule?: boolean }
): Promise<SessionAutomationChange> {
  return withCliErrors(() =>
    disableAutomation(automationContext(context), id, {
      ...(options.hook ? { hook: true } : {}),
      ...(options.schedule ? { schedule: true } : {}),
    })
  );
}

export function removeAutomation(
  context: SessionsCliContext,
  id: string
): Promise<SessionAutomationChange> {
  return withCliErrors(() =>
    removeAutomationProfile(automationContext(context), id)
  );
}

/** Explicit run-now through the same importer and pending marker as the daemon. */
export function runAutomation(
  context: SessionsCliContext,
  id: string
): Promise<SessionAutomationRunResult> {
  return withCliErrors(async () => {
    const ctx = automationContext(context);
    const { config } = await loadArchiveConfig(context);
    const dbPath = getIndexDbPath(context.indexName);
    // Open without projecting the config: the run syncs only what it needs,
    // so a busy index becomes a recorded `busy` run, not a raw lock error.
    const store = new SqliteAdapter();
    store.setConfigPath(ctx.configPath);
    const opened = await store.open(
      dbPath,
      config.ftsTokenizer,
      config.busyTimeoutMs
    );
    if (!opened.ok) throw new CliError("RUNTIME", opened.error.message);
    try {
      return await runAutomationProfile(
        {
          ...ctx,
          store,
          // Like the daemon: a concurrent writer is a recorded busy run.
          acquireLease: async () => {
            const lease = await acquireCliWriteLease({
              dbPath,
              waitMs: 0,
              noWait: true,
              command: "gno sessions automation run",
            });
            return lease.ok
              ? { ok: true, release: lease.release }
              : { ok: false };
          },
        },
        id,
        { trigger: "manual" }
      );
    } finally {
      await store.close();
    }
  });
}

/** Kill switch for every installed hook: `GNO_SESSIONS_HOOKS=off`. */
export const SESSIONS_HOOKS_ENV = "GNO_SESSIONS_HOOKS";
const HOOK_PAYLOAD_MAX_BYTES = 64 * 1024;

/** Read the small JSON event a host hook writes on stdin (bounded). */
export async function readHookPayload(
  stream?: ReadableStream<Uint8Array>
): Promise<unknown> {
  if (!stream && process.stdin.isTTY) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (stream ?? Bun.stdin.stream()).getReader();
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      size += value.byteLength;
      if (size > HOOK_PAYLOAD_MAX_BYTES) return false;
      chunks.push(value);
    }
  })();
  const timer = Bun.sleep(HOOK_ADMISSION_DEADLINE_MS / 2).then(() => null);
  const complete = await Promise.race([read, timer]);
  // A host that keeps stdin open must not cost the admission: cleanup
  // failures are ignored.
  await reader.cancel().catch(() => undefined);
  try {
    reader.releaseLock();
  } catch {
    // Still locked by the abandoned read; the process exits right after.
  }
  if (complete === false) return "oversized";
  if (complete === null || size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return "invalid";
  }
}

/**
 * Host hook entrypoint. Tiny by design: it validates the event, durably
 * marks the profile pending and returns. It never imports, parses sessions
 * or touches the network; its one-line output is content-free.
 */
export async function runSessionsHook(
  context: SessionsCliContext,
  harness: string,
  options: { profile?: string }
): Promise<string> {
  const profileId = options.profile ?? "";
  const killSwitch = process.env[SESSIONS_HOOKS_ENV]?.trim().toLowerCase();
  if (killSwitch === "off" || killSwitch === "0") {
    return `gno sessions hook: skipped (${SESSIONS_HOOKS_ENV}=${killSwitch})`;
  }
  if (harness !== "claude-code" || !profileId) {
    throw new CliError(
      "VALIDATION",
      "gno sessions hook: not accepted (usage: sessions hook claude-code --profile <id>)",
      { details: { sessionsCode: "SESSIONS_UNSUPPORTED_INTEGRATION" } }
    );
  }
  const payload = await readHookPayload();
  if (payload === "invalid" || payload === "oversized") {
    return `gno sessions hook: skipped (profile ${profileId}: ${payload}_event)`;
  }
  let admission: HookAdmission;
  try {
    admission = await admitHookTrigger(automationContext(context), {
      harness: "claude-code",
      profileId,
      payload,
    });
  } catch (error) {
    const code =
      error instanceof SessionsError ? error.code : "SESSIONS_RUNTIME_FAILURE";
    const reason =
      code === "SESSIONS_BUSY" ? "admission_deadline" : code.toLowerCase();
    throw new CliError(
      "RUNTIME",
      `gno sessions hook: not accepted (profile ${profileId}: ${reason}); nothing was archived`,
      { details: { sessionsCode: code } }
    );
  }
  if (admission.outcome === "skipped") {
    return `gno sessions hook: skipped (profile ${profileId}: ${admission.reason})`;
  }
  const next =
    admission.daemon === "running"
      ? "the daemon imports it on its next tick"
      : `not running: no daemon; run gno sessions automation run ${profileId}`;
  return `gno sessions hook: accepted (profile ${profileId} pending, not yet archived; ${next})`;
}

export function formatAutomationPreview(
  preview: SessionAutomationPreview,
  asJson: boolean
): string {
  if (asJson) return json(preview);
  const lines = [
    `Automation profile ${preview.profileId} (archive ${preview.archiveRoot}, index ${preview.index}, config ${preview.configPath})`,
    "Sources:",
    ...preview.sources.map((source) => {
      const projects = source.projects
        .map((mapping) => `${mapping.prefix}=${mapping.collection}`)
        .join(", ");
      return source.harness
        ? `- ${source.id} (${source.harness}) ${source.path}${source.available ? "" : " [UNAVAILABLE]"} -> ${source.collection}${projects ? ` (projects: ${projects})` : ""}`
        : `- ${source.id}: NOT REGISTERED`;
    }),
    `Destination collections: ${preview.collections.join(", ") || "(none)"}`,
    `Hook ${preview.hook.harness}: ${preview.hook.enabled ? "on" : "off"}; settings ${preview.hook.settings} (entry ${preview.hook.installed === null ? "unreadable" : preview.hook.installed ? "installed" : "not installed"})`,
    `  command: ${preview.hook.command}`,
    `Schedule: ${preview.schedule.enabled ? `on, every ${preview.schedule.cadence}` : `off${preview.schedule.cadence ? ` (cadence ${preview.schedule.cadence})` : ""}`}; minimum ${preview.schedule.minimum}`,
    `Budget: ${preview.limit} changed units per source per run; ${preview.retries} automatic retries`,
    `Daemon: ${preview.daemon.state === "running" ? "running" : "not running: no daemon"} (${preview.daemon.command})`,
    ...preview.notes.map((note) =>
      note.startsWith("warning: ") ? note : `note: ${note}`
    ),
  ];
  return lines.join("\n");
}

export function formatAutomationChange(
  change: SessionAutomationChange,
  asJson: boolean
): string {
  if (asJson) return json(change);
  const lines = [
    change.removed
      ? `Automation profile ${change.profileId} removed; archived sessions were retained.`
      : `Automation profile ${change.profileId} paused.`,
  ];
  if (change.hook) {
    lines.push(
      `hook: off (${change.hook.entriesRemoved} owned settings entr${change.hook.entriesRemoved === 1 ? "y" : "ies"} removed)`
    );
  }
  if (change.schedule) lines.push("schedule: off");
  if (change.pendingCleared) lines.push("pending work: cleared");
  if (change.running) {
    lines.push(
      `a run started at ${change.running.startedAt} finishes its bounded batch; nothing new starts`
    );
  }
  for (const warning of change.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

export function formatAutomationRun(
  result: SessionAutomationRunResult,
  asJson: boolean
): string {
  return asJson ? json(result) : formatAutomationRunText(result);
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
  return asJson ? json(receipt) : formatImportReceiptText(receipt);
}

export function formatStatus(status: SessionsStatus, asJson: boolean): string {
  return asJson ? json(status) : formatStatusText(status);
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
