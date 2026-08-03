/** Read-only knowledge-integrity audit CLI adapter. */

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
  onProgress?: (progress: WorkspaceAuditProgress) => void;
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
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, invalid: true, error: configResult.error.message };
  }
  const config = configResult.value;
  const requestedCollections = options.collections ?? [];
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
      tagFilters: options.tags,
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
  await Bun.write(path, `${formatAuditReport(report, options)}\n`, {
    createPath: false,
    mode: 0o600,
  });
};
