/** Read-only knowledge-integrity audit CLI adapter. */

// node:fs/promises provides atomic filesystem structure operations with no Bun equivalent.
import { chmod, mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  AuditCategory,
  AuditReport,
  AuditRunResult,
} from "../../core/audit";
import type { WorkspaceAuditProgress } from "../../core/audit-workspace";

import { getIndexDbPath } from "../../app/constants";
import { loadConfig } from "../../config";
import {
  auditExitCode,
  AUDIT_CATEGORIES,
  serializeAuditReportCanonical,
} from "../../core/audit";
import { runWorkspaceAudit } from "../../core/audit-workspace";
import { normalizeTag, validateTag } from "../../core/tags";
import { normalizeCollectionName } from "../../core/validation";
import { SqliteAdapter } from "../../store/sqlite/adapter";

export interface AuditCommandOptions {
  category?: string;
  configPath?: string;
  indexName?: string;
  collections?: string[];
  paths?: string[];
  tags?: string[];
  maxFindings?: number;
  maxAgeDays?: number;
  orphanRoots?: string[];
  orphanIgnorePrefixes?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceAuditProgress) => void | Promise<void>;
}

export type AuditCommandResult =
  | { success: true; report: AuditReport; exitCode: number }
  | { success: false; error: string; invalid: boolean };

const resolveCategories = (
  value: string | undefined
): AuditCategory[] | null => {
  const normalized = (value ?? "all").trim().toLowerCase();
  if (normalized === "all") return [...AUDIT_CATEGORIES];
  return (AUDIT_CATEGORIES as readonly string[]).includes(normalized)
    ? [normalized as AuditCategory]
    : null;
};

const invalidPositiveInteger = (value: number | undefined): boolean =>
  value !== undefined && (!Number.isSafeInteger(value) || value < 1);

const AUDIT_SCOPE_FILTER_MAX_ITEMS = 256;

const oversizedScopeFilter = (
  options: AuditCommandOptions
): "collections" | "paths" | "tags" | null => {
  for (const name of ["collections", "paths", "tags"] as const) {
    if ((options[name]?.length ?? 0) > AUDIT_SCOPE_FILTER_MAX_ITEMS) {
      return name;
    }
  }
  return null;
};

export const audit = async (
  options: AuditCommandOptions
): Promise<AuditCommandResult> => {
  const categories = resolveCategories(options.category);
  if (!categories) {
    return {
      success: false,
      invalid: true,
      error: "category must be links, provenance, freshness, or all",
    };
  }
  if (invalidPositiveInteger(options.maxFindings)) {
    return {
      success: false,
      invalid: true,
      error: "maxFindings must be a positive integer",
    };
  }
  if (invalidPositiveInteger(options.maxAgeDays)) {
    return {
      success: false,
      invalid: true,
      error: "maxAgeDays must be a positive integer",
    };
  }
  const oversizedFilter = oversizedScopeFilter(options);
  if (oversizedFilter) {
    return {
      success: false,
      invalid: true,
      error: `${oversizedFilter} must contain at most ${AUDIT_SCOPE_FILTER_MAX_ITEMS} values`,
    };
  }
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, invalid: true, error: configResult.error.message };
  }
  const config = configResult.value;
  const requestedCollections = (options.collections ?? []).map(
    normalizeCollectionName
  );
  const requestedTags = (options.tags ?? []).map(normalizeTag);
  const invalidTag = requestedTags.find((tag) => !validateTag(tag));
  if (invalidTag) {
    return {
      success: false,
      invalid: true,
      error: `Invalid tag: "${invalidTag}"`,
    };
  }
  const knownCollections = new Set(
    config.collections.map((collection) => collection.name)
  );
  const missingCollection = requestedCollections.find(
    (collection) => !knownCollections.has(collection)
  );
  if (missingCollection) {
    return {
      success: false,
      invalid: true,
      error: `Collection not found: ${missingCollection}`,
    };
  }
  const dbPath = getIndexDbPath(options.indexName);
  if (!(await Bun.file(dbPath).exists())) {
    return {
      success: false,
      invalid: false,
      error: `Index database not found: ${dbPath}. Run gno index first.`,
    };
  }
  const store = new SqliteAdapter();
  const opened = store.openReadOnly(dbPath);
  if (!opened.ok) {
    return { success: false, invalid: false, error: opened.error.message };
  }
  try {
    const result: AuditRunResult = await runWorkspaceAudit({
      store,
      config,
      collections: config.collections,
      indexName: options.indexName ?? "default",
      categories,
      collectionFilters: requestedCollections,
      pathFilters: options.paths,
      tagFilters: requestedTags,
      maxFindings: options.maxFindings,
      agePolicy:
        options.maxAgeDays === undefined
          ? undefined
          : { maxAgeDays: options.maxAgeDays },
      orphanRoots: options.orphanRoots,
      orphanIgnorePrefixes: options.orphanIgnorePrefixes,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (!result.ok) {
      return { success: false, invalid: true, error: result.error };
    }
    return {
      success: true,
      report: result.report,
      exitCode: auditExitCode(result.exit),
    };
  } finally {
    await store.close();
  }
};

export const formatAuditReport = (
  report: AuditReport,
  options: { json?: boolean } = {}
): string => {
  if (options.json) return serializeAuditReportCanonical(report);
  const lines = [
    `Audit: ${report.status}`,
    `Categories: ${report.scope.categories.join(", ")}`,
    `Rules: ${report.counts.rules.total} (${report.counts.rules.fail} failed, ${report.counts.rules.unavailable} unavailable, ${report.counts.rules.inconclusive} inconclusive)`,
    `Findings: ${report.counts.findings.total}${report.counts.findings.truncated ? ` (${report.counts.findings.returned} shown)` : ""}`,
    `Examined: ${report.counts.examined.documents} document/rule observations`,
    `Duration: ${report.durationMs}ms`,
  ];
  for (const finding of report.findings) {
    const location = finding.location ? ` ${finding.location}` : "";
    lines.push(
      `- [${finding.severity}] ${finding.ruleId}: ${finding.subject}${location} — ${finding.message}`
    );
  }
  for (const rule of report.rules) {
    if (
      rule.status === "skip" ||
      rule.status === "unavailable" ||
      rule.status === "inconclusive"
    ) {
      lines.push(`- [${rule.status}] ${rule.ruleId}: ${rule.message}`);
    }
  }
  return lines.join("\n");
};

export const writeAuditReport = async (
  path: string,
  report: AuditReport,
  options: { json?: boolean } = {}
): Promise<void> => {
  const temporaryDirectory = await mkdtemp(
    join(dirname(path), `.${basename(path)}-`)
  );
  const temporaryPath = join(temporaryDirectory, "report");
  try {
    await Bun.write(temporaryPath, `${formatAuditReport(report, options)}\n`, {
      createPath: false,
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    await rmdir(temporaryDirectory).catch(() => undefined);
  }
};
