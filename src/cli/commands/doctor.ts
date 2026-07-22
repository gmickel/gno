/**
 * gno doctor command implementation.
 * Diagnose configuration and dependencies.
 *
 * @module src/cli/commands/doctor
 */

import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
// node:os: arch/platform detection (no Bun equivalent)
import { arch, platform } from "node:os";

import type { Config } from "../../config/types";
import type { ActivationStatus } from "../../core/activation-status";

import { getIndexDbPath, getModelsCachePath } from "../../app/constants";
import { getConfigPaths, isInitialized, loadConfig } from "../../config";
import { getCodeChunkingStatus } from "../../ingestion/chunker";
import { ModelCache } from "../../llm/cache";
import { getActivePreset, resolveModelUri } from "../../llm/registry";
import { SqliteAdapter } from "../../store/sqlite/adapter";
import { loadFts5Snowball } from "../../store/sqlite/fts5-snowball";
import {
  getCustomSqlitePath,
  getExtensionLoadingMode,
  getLoadAttempts,
} from "../../store/sqlite/setup";
import { getStoredEmbeddingFingerprint } from "../../store/vector/freshness";
import {
  buildDoctorActivation,
  checkConnectorActivation,
  checkRetrievalActivation,
} from "./doctor-activation";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DoctorCheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  /** Additional diagnostic details (shown in verbose/json output) */
  details?: string[];
  /** Embedding fingerprint diagnostics for machine consumers */
  embeddingFingerprint?: EmbeddingFingerprintHealth;
}

export interface EmbeddingFingerprintGroup {
  model: string;
  fingerprint: string;
  count: number;
  current: boolean;
  legacy: boolean;
}

export interface EmbeddingFingerprintHealth {
  model: string;
  currentFingerprint: string;
  pendingChunks: number;
  legacyChunks: number;
  mixedGroups: number;
  groups: EmbeddingFingerprintGroup[];
}

export interface DoctorOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
  activation: ActivationStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

async function checkConfig(configPath?: string): Promise<DoctorCheck> {
  const initialized = await isInitialized(configPath);
  if (!initialized) {
    return {
      name: "config",
      status: "error",
      message: "Config not found. Run: gno init",
    };
  }

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) {
    return {
      name: "config",
      status: "error",
      message: `Config invalid: ${configResult.error.message}`,
    };
  }

  const paths = getConfigPaths();
  return {
    name: "config",
    status: "ok",
    message: `Config loaded: ${paths.configFile}`,
  };
}

async function checkDatabase(indexName?: string): Promise<DoctorCheck> {
  const dbPath = getIndexDbPath(indexName);

  try {
    await stat(dbPath);
    return {
      name: "database",
      status: "ok",
      message: `Database found: ${dbPath}`,
    };
  } catch {
    return {
      name: "database",
      status: "warn",
      message: "Database not found. Run: gno init",
    };
  }
}

async function checkModels(config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cache = new ModelCache(getModelsCachePath());
  const preset = getActivePreset(config);

  for (const type of ["embed", "rerank", "gen"] as const) {
    const uri = preset[type];
    const cached = await cache.isCached(uri);

    checks.push({
      name: `${type}-model`,
      status: cached ? "ok" : "warn",
      message: cached
        ? `${type} model cached`
        : `${type} model not cached. Run: gno models pull --${type}`,
    });
  }

  return checks;
}

function checkCodeChunking(): DoctorCheck {
  const status = getCodeChunkingStatus();
  return {
    name: "code-chunking",
    status: "ok",
    message: `${status.mode} structural chunking for ${status.supportedExtensions.join(", ")}`,
    details: [
      "Unsupported extensions fall back to the default markdown chunker.",
      "Chunking mode is automatic-only in the first pass.",
    ],
  };
}

const FINGERPRINT_DISPLAY_LENGTH = 12;

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, FINGERPRINT_DISPLAY_LENGTH);
}

function describeFingerprintGroup(group: EmbeddingFingerprintGroup): string {
  if (group.current) {
    return "current";
  }
  if (group.legacy) {
    return "legacy";
  }
  return "stale";
}

async function checkEmbeddingFingerprints(
  config: Config,
  indexName?: string
): Promise<DoctorCheck> {
  const dbPath = getIndexDbPath(indexName);
  try {
    await stat(dbPath);
  } catch {
    return {
      name: "embedding-fingerprint",
      status: "warn",
      message: "Database not found. Run: gno init",
    };
  }

  const store = new SqliteAdapter();
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return {
      name: "embedding-fingerprint",
      status: "warn",
      message: `Fingerprint health unavailable: ${openResult.error.message}`,
      details: ["Run: gno doctor --json", "Then run: gno embed"],
    };
  }

  try {
    const db = store.getRawDb();
    const model = resolveModelUri(config, "embed");
    const currentFingerprint = getStoredEmbeddingFingerprint(db, model);
    const statusResult = await store.getStatus({ embedModel: model });
    if (!statusResult.ok) {
      return {
        name: "embedding-fingerprint",
        status: "warn",
        message: `Fingerprint health unavailable: ${statusResult.error.message}`,
        details: ["Run: gno embed"],
      };
    }

    const legacyChunks =
      db
        .query<{ count: number }, [string]>(
          `
          SELECT COUNT(*) as count
          FROM content_vectors v
          JOIN content_chunks c
            ON c.mirror_hash = v.mirror_hash
           AND c.seq = v.seq
          WHERE v.model = ?
            AND v.embed_fingerprint = ''
            AND EXISTS (
              SELECT 1 FROM documents d
              WHERE d.mirror_hash = c.mirror_hash
                AND d.active = 1
            )
        `
        )
        .get(model)?.count ?? 0;

    const groups = db
      .query<{ model: string; fingerprint: string; count: number }, []>(
        `
        SELECT
          v.model as model,
          v.embed_fingerprint as fingerprint,
          COUNT(*) as count
        FROM content_vectors v
        JOIN content_chunks c
          ON c.mirror_hash = v.mirror_hash
         AND c.seq = v.seq
        WHERE EXISTS (
          SELECT 1 FROM documents d
          WHERE d.mirror_hash = c.mirror_hash
            AND d.active = 1
        )
        GROUP BY v.model, v.embed_fingerprint
        ORDER BY count DESC, v.model ASC, v.embed_fingerprint ASC
      `
      )
      .all()
      .map((group) => ({
        model: group.model,
        fingerprint: group.fingerprint,
        count: group.count,
        current:
          group.model === model && group.fingerprint === currentFingerprint,
        legacy: group.fingerprint === "",
      }));

    const mixedGroups = groups.length;
    const pendingChunks = statusResult.value.embeddingBacklog;
    const hasWarnings =
      pendingChunks > 0 || legacyChunks > 0 || mixedGroups > 1;

    const health: EmbeddingFingerprintHealth = {
      model,
      currentFingerprint,
      pendingChunks,
      legacyChunks,
      mixedGroups,
      groups,
    };

    const message =
      `current ${shortFingerprint(currentFingerprint)}, ` +
      `${pendingChunks} pending/stale, ${legacyChunks} legacy, ` +
      `${mixedGroups} group${mixedGroups === 1 ? "" : "s"}`;
    const details: string[] = [];

    if (hasWarnings) {
      details.push("Run: gno embed");
      details.push("If vectors still look stale, run: gno embed --force");
      for (const group of groups) {
        const label = describeFingerprintGroup(group);
        const fingerprint = group.legacy
          ? "(empty)"
          : shortFingerprint(group.fingerprint);
        details.push(
          `${label}: ${group.count} chunks model=${group.model} fingerprint=${fingerprint}`
        );
      }
    }

    return {
      name: "embedding-fingerprint",
      status: hasWarnings ? "warn" : "ok",
      message,
      details: details.length > 0 ? details : undefined,
      embeddingFingerprint: health,
    };
  } finally {
    await store.close();
  }
}

function checkNodeLlamaCpp(): DoctorCheck {
  try {
    import.meta.resolve("node-llama-cpp");
    return {
      name: "node-llama-cpp",
      status: "ok",
      message: "node-llama-cpp package available (runtime not initialized)",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      name: "node-llama-cpp",
      status: "error",
      message: `node-llama-cpp failed: ${message}`,
    };
  }
}

/**
 * Check SQLite extension support (FTS5, sqlite-vec).
 * Uses runtime capability probes instead of compile_options strings.
 */
// oxlint-disable-next-line max-lines-per-function -- diagnostic checks with platform-specific handling
async function checkSqliteExtensions(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const plat = platform();
  const archName = arch();
  const mode = getExtensionLoadingMode();
  const customPath = getCustomSqlitePath();
  const attempts = getLoadAttempts();

  // Platform/mode info
  let modeDesc = "unavailable";
  if (mode === "native") {
    modeDesc = "native (bundled SQLite supports extensions)";
  } else if (mode === "custom") {
    modeDesc = `custom (${customPath})`;
  }

  const details: string[] = [
    `Platform: ${plat}-${archName}`,
    `Mode: ${modeDesc}`,
  ];

  // Add load attempt details if there were failures
  if (attempts.length > 0) {
    details.push("Load attempts:");
    for (const attempt of attempts) {
      details.push(`  ${attempt.path}: ${attempt.error}`);
    }
  }

  // Create in-memory DB for probes
  const db = new Database(":memory:");
  let version = "unknown";

  try {
    const row = db.query("SELECT sqlite_version() as v").get() as { v: string };
    version = row.v;
    details.push(`SQLite version: ${version}`);
  } catch {
    // Continue with unknown version
  }

  // Probe FTS5 capability
  let fts5Available = false;
  try {
    db.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)");
    db.exec("DROP TABLE _fts5_probe");
    fts5Available = true;
  } catch {
    // FTS5 not available
  }

  checks.push({
    name: "sqlite-fts5",
    status: fts5Available ? "ok" : "error",
    message: fts5Available ? "FTS5 available" : "FTS5 not available (required)",
    details: fts5Available
      ? undefined
      : ["Full-text search requires FTS5 support"],
  });

  // Probe JSON capability
  let jsonAvailable = false;
  try {
    db.query("SELECT json_valid('{}')").get();
    jsonAvailable = true;
  } catch {
    // JSON not available
  }

  checks.push({
    name: "sqlite-json",
    status: jsonAvailable ? "ok" : "warn",
    message: jsonAvailable ? "JSON1 available" : "JSON1 not available",
  });

  // Probe vendored fts5-snowball extension
  const snowballResult = loadFts5Snowball(db);
  checks.push({
    name: "fts5-snowball",
    status: snowballResult.loaded ? "ok" : "error",
    message: snowballResult.loaded
      ? "fts5-snowball loaded"
      : (snowballResult.error ?? "fts5-snowball failed to load"),
    details: snowballResult.path ? [`Path: ${snowballResult.path}`] : undefined,
  });

  // Probe sqlite-vec extension
  let sqliteVecAvailable = false;
  let sqliteVecVersion = "";
  let sqliteVecError = "";
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    sqliteVecAvailable = true;
    // Try to get version
    try {
      const vrow = db.query("SELECT vec_version() as v").get() as { v: string };
      sqliteVecVersion = vrow.v;
    } catch {
      // No version available
    }
  } catch (e) {
    sqliteVecError = e instanceof Error ? e.message : String(e);
  }

  let vecMessage: string;
  if (sqliteVecAvailable) {
    const formattedVersion = sqliteVecVersion.startsWith("v")
      ? sqliteVecVersion
      : `v${sqliteVecVersion}`;
    vecMessage = sqliteVecVersion
      ? `sqlite-vec loaded (${formattedVersion})`
      : "sqlite-vec loaded";
  } else if (mode === "unavailable") {
    vecMessage =
      "sqlite-vec unavailable (no extension support on macOS without Homebrew)";
  } else {
    vecMessage = sqliteVecError
      ? `sqlite-vec failed: ${sqliteVecError}`
      : "sqlite-vec failed to load";
  }

  const vecDetails = [...details];
  if (!sqliteVecAvailable && plat === "darwin" && mode === "unavailable") {
    vecDetails.push("Install Homebrew SQLite: brew install sqlite3");
  }
  if (sqliteVecError) {
    vecDetails.push(`Load error: ${sqliteVecError}`);
  }

  checks.push({
    name: "sqlite-vec",
    status: sqliteVecAvailable ? "ok" : "warn",
    message: vecMessage,
    details: vecDetails,
  });

  db.close();
  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno doctor command.
 */
export async function doctor(
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // Config check
  checks.push(await checkConfig(options.configPath));

  // Database check
  checks.push(await checkDatabase(options.indexName));

  // Load config for model checks (if available)
  const { createDefaultConfig } = await import("../../config");
  const configResult = await loadConfig(options.configPath);
  const config = configResult.ok ? configResult.value : createDefaultConfig();

  // Model checks
  const modelChecks = await checkModels(config);
  checks.push(...modelChecks);

  // node-llama-cpp check
  checks.push(checkNodeLlamaCpp());

  // SQLite extension checks
  const sqliteChecks = await checkSqliteExtensions();
  checks.push(...sqliteChecks);

  // Code chunking capability
  checks.push(checkCodeChunking());

  // Embedding fingerprint freshness
  checks.push(await checkEmbeddingFingerprints(config, options.indexName));

  const activation = await buildDoctorActivation(config, options);
  checks.push(checkRetrievalActivation(activation));
  const connectorActivation = checkConnectorActivation(activation);
  if (connectorActivation) {
    checks.push(connectorActivation);
  }

  // Determine overall health
  const hasErrors = checks.some((c) => c.status === "error");

  return {
    healthy:
      !hasErrors &&
      activation.healthy &&
      !activation.connectorProjection.truncated,
    checks,
    activation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function statusIcon(status: DoctorCheckStatus): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "error":
      return "✗";
    default:
      return "?";
  }
}

function formatTerminal(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push("GNO Health Check");
  lines.push("");

  for (const check of result.checks) {
    lines.push(`  ${statusIcon(check.status)} ${check.name}: ${check.message}`);
    // Show details for non-ok checks
    if (check.details && check.status !== "ok") {
      for (const detail of check.details) {
        lines.push(`      ${detail}`);
      }
    }
  }

  lines.push("");
  lines.push(`Overall: ${result.healthy ? "HEALTHY" : "UNHEALTHY"}`);

  return lines.join("\n");
}

function formatMarkdown(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push("# GNO Health Check");
  lines.push("");
  lines.push(`**Status**: ${result.healthy ? "✓ Healthy" : "✗ Unhealthy"}`);
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| Check | Status | Message |");
  lines.push("|-------|--------|---------|");

  for (const check of result.checks) {
    lines.push(
      `| ${check.name} | ${statusIcon(check.status)} | ${check.message} |`
    );
  }

  return lines.join("\n");
}

/**
 * Format doctor result for output.
 */
export function formatDoctor(
  result: DoctorResult,
  options: DoctorOptions
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result);
  }

  return formatTerminal(result);
}
