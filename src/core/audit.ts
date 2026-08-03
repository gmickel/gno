/** Deterministic read-only knowledge integrity audit runner. */

import type {
  AuditCapabilitySnapshot,
  AuditCategory,
  AuditFinding,
  AuditFingerprints,
  AuditForbiddenStoreMethod,
  AuditReport,
  AuditReportStatus,
  AuditRuleContribution,
  AuditRuleContext,
  AuditRuleEvaluator,
  AuditRuleResult,
  AuditRunInput,
  AuditRunResult,
  AuditScope,
  AuditVersions,
} from "./audit-contract";

import { VERSION } from "../app/constants";
import {
  AUDIT_CATEGORIES,
  AUDIT_DEFAULT_MAX_FINDINGS,
  AUDIT_FORBIDDEN_STORE_METHODS,
  AUDIT_MAX_CODE_CHARS,
  AUDIT_MAX_FINDINGS_LIMIT,
  AUDIT_MAX_IDENTIFIER_CHARS,
  AUDIT_MAX_MESSAGE_CHARS,
  AUDIT_MAX_SCOPE_ITEMS,
  AUDIT_MAX_SCOPE_VALUE_CHARS,
  AUDIT_MAX_SNAPSHOT_ATTEMPTS,
  AUDIT_RULE_SET_VERSION,
  AUDIT_SCHEMA_VERSION,
} from "./audit-contract";
import {
  auditCategoryRank,
  boundAuditText,
  compareAuditCodeUnits,
  compareAuditFindings,
  compareAuditRules,
  deriveAuditExitKind,
  deriveAuditReportStatus,
  materializeAuditFinding,
  normalizeAuditText,
  tallyAuditRuleCounts,
} from "./audit-report";

export * from "./audit-contract";
export * from "./audit-report";

// ─────────────────────────────────────────────────────────────────────────────
// Scope / input validation
// ─────────────────────────────────────────────────────────────────────────────

const isAuditCategory = (value: string): value is AuditCategory =>
  (AUDIT_CATEGORIES as readonly string[]).includes(value);

export const normalizeAuditScope = (
  scope: AuditScope
): { ok: true; scope: AuditScope } | { ok: false; error: string } => {
  const indexName = normalizeAuditText(scope.indexName);
  if (indexName.length < 1) {
    return { ok: false, error: "indexName is required" };
  }
  if (Array.from(indexName).length > 64) {
    return { ok: false, error: "indexName must be at most 64 characters" };
  }

  const categories =
    scope.categories.length === 0
      ? [...AUDIT_CATEGORIES]
      : [...new Set(scope.categories.map((item) => normalizeAuditText(item)))];
  for (const category of categories) {
    if (!isAuditCategory(category)) {
      return { ok: false, error: `unknown audit category: ${category}` };
    }
  }
  categories.sort(
    (left, right) =>
      auditCategoryRank(left as AuditCategory) -
      auditCategoryRank(right as AuditCategory)
  );

  const collections = [
    ...new Set(scope.collections.map((item) => normalizeAuditText(item))),
  ]
    .filter((item) => item.length > 0)
    .sort(compareAuditCodeUnits);
  const paths = [
    ...new Set(scope.paths.map((item) => normalizeAuditText(item))),
  ]
    .filter((item) => item.length > 0)
    .sort(compareAuditCodeUnits);
  const tags = [...new Set(scope.tags.map((item) => normalizeAuditText(item)))]
    .filter((item) => item.length > 0)
    .sort(compareAuditCodeUnits);

  for (const [name, values, maxChars] of [
    ["collections", collections, AUDIT_MAX_SCOPE_VALUE_CHARS],
    ["paths", paths, AUDIT_MAX_IDENTIFIER_CHARS],
    ["tags", tags, AUDIT_MAX_SCOPE_VALUE_CHARS],
  ] as const) {
    if (values.length > AUDIT_MAX_SCOPE_ITEMS) {
      return {
        ok: false,
        error: `${name} must contain at most ${AUDIT_MAX_SCOPE_ITEMS} values`,
      };
    }
    if (values.some((value) => Array.from(value).length > maxChars)) {
      return {
        ok: false,
        error: `${name} entries must be at most ${maxChars} characters`,
      };
    }
  }

  return {
    ok: true,
    scope: {
      categories: categories as AuditCategory[],
      collections,
      paths,
      tags,
      indexName,
    },
  };
};

const resolveMaxFindings = (
  value: number | undefined
): { ok: true; maxFindings: number } | { ok: false; error: string } => {
  const maxFindings = value ?? AUDIT_DEFAULT_MAX_FINDINGS;
  if (
    !Number.isSafeInteger(maxFindings) ||
    maxFindings < 1 ||
    maxFindings > AUDIT_MAX_FINDINGS_LIMIT
  ) {
    return {
      ok: false,
      error: `maxFindings must be an integer between 1 and ${AUDIT_MAX_FINDINGS_LIMIT}`,
    };
  }
  return { ok: true, maxFindings };
};

const fingerprintsEqual = (
  left: AuditFingerprints,
  right: AuditFingerprints
): boolean =>
  left.config === right.config &&
  left.source === right.source &&
  left.index === right.index &&
  left.rules === right.rules;

const normalizeFingerprints = (
  fingerprints: AuditFingerprints
): AuditFingerprints => ({
  config: normalizeAuditText(fingerprints.config),
  source: normalizeAuditText(fingerprints.source),
  index: normalizeAuditText(fingerprints.index),
  rules: normalizeAuditText(fingerprints.rules),
});

const defaultCapabilities = (
  capabilities: AuditCapabilitySnapshot
): AuditCapabilitySnapshot => ({
  ...capabilities,
  offline: true,
  llmDisabled: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const materializeRule = (
  contribution: AuditRuleContribution
): AuditRuleResult => {
  const ruleId = boundAuditText(contribution.ruleId, AUDIT_MAX_CODE_CHARS);
  const findings = (contribution.findings ?? [])
    .map((draft) =>
      materializeAuditFinding(ruleId, contribution.category, draft)
    )
    .sort(compareAuditFindings);

  let status = contribution.status;
  if (findings.length > 0 && status === "pass") {
    status = "fail";
  }

  return {
    ruleId,
    category: contribution.category,
    status,
    message: boundAuditText(contribution.message, AUDIT_MAX_MESSAGE_CHARS),
    findings,
    findingCount: Math.max(
      findings.length,
      contribution.findingCount ?? findings.length
    ),
    examinedCount: Math.max(0, contribution.examinedCount ?? 0),
    durationMs: Math.max(0, Math.round(contribution.durationMs ?? 0)),
    skipReason:
      contribution.skipReason === undefined || contribution.skipReason === null
        ? null
        : boundAuditText(contribution.skipReason, AUDIT_MAX_MESSAGE_CHARS),
  };
};

const collectContributions = async (
  evaluators: readonly AuditRuleEvaluator[],
  ctx: AuditRuleContext
): Promise<AuditRuleContribution[]> => {
  const collected: AuditRuleContribution[] = [];
  for (const evaluator of evaluators) {
    const result = await evaluator(ctx);
    if (Array.isArray(result)) {
      collected.push(...result);
    } else {
      collected.push(result);
    }
  }
  return collected;
};

const buildReportFromRules = (input: {
  scope: AuditScope;
  capabilities: AuditCapabilitySnapshot;
  fingerprints: AuditFingerprints;
  versions: AuditVersions;
  rules: AuditRuleResult[];
  status: AuditReportStatus;
  maxFindings: number;
  startedAt: string;
  completedAt: string;
  snapshotMs: number;
  rulesMs: number;
  totalMs: number;
}): AuditReport => {
  const materializedRules = [...input.rules]
    .sort(compareAuditRules)
    .map((rule) => ({
      ...rule,
      findings: [...rule.findings].sort(compareAuditFindings),
    }));

  const allFindings = materializedRules
    .flatMap((rule) => rule.findings)
    .sort(compareAuditFindings);
  // Deduplicate by stable id while preserving canonical order.
  const seen = new Set<string>();
  const uniqueFindings: AuditFinding[] = [];
  for (const finding of allFindings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    uniqueFindings.push(finding);
  }

  const exactFindingCount = materializedRules.reduce(
    (sum, rule) => sum + rule.findingCount,
    0
  );
  const truncated = exactFindingCount > input.maxFindings;
  const returnedFindings = truncated
    ? uniqueFindings.slice(0, input.maxFindings)
    : uniqueFindings;
  const returnedFindingIds = new Set(
    returnedFindings.map((finding) => finding.id)
  );
  // Rule details and the top-level list share one global payload budget. Exact
  // per-rule totals remain in findingCount, so truncation never hides scale.
  const rules = materializedRules.map((rule) => ({
    ...rule,
    findings: rule.findings.filter((finding) =>
      returnedFindingIds.has(finding.id)
    ),
  }));

  const examinedDocuments = rules.reduce(
    (sum, rule) => sum + rule.examinedCount,
    0
  );

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    ruleSetVersion: AUDIT_RULE_SET_VERSION,
    status: input.status,
    scope: input.scope,
    capabilities: input.capabilities,
    fingerprints: input.fingerprints,
    versions: input.versions,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Math.round(input.totalMs)),
    rules,
    findings: returnedFindings,
    counts: {
      rules: tallyAuditRuleCounts(rules),
      findings: {
        total: exactFindingCount,
        returned: returnedFindings.length,
        truncated,
      },
      examined: {
        documents: examinedDocuments,
      },
    },
    truncation: {
      findingsTruncated: truncated,
      maxFindings: input.maxFindings,
    },
    timing: {
      snapshotMs: Math.max(0, Math.round(input.snapshotMs)),
      rulesMs: Math.max(0, Math.round(input.rulesMs)),
      totalMs: Math.max(0, Math.round(input.totalMs)),
    },
  };
};

/**
 * Run the read-only audit runner against injected rule evaluators.
 * Snapshots fingerprints before and after rule evaluation; mid-run changes
 * retry up to `maxAttempts` and otherwise yield `changed_during_audit` —
 * never a clean report.
 */
export async function runAudit(input: AuditRunInput): Promise<AuditRunResult> {
  const scopeResult = normalizeAuditScope(input.scope);
  if (!scopeResult.ok) {
    return { ok: false, exit: "invalid", error: scopeResult.error };
  }
  const maxFindingsResult = resolveMaxFindings(input.maxFindings);
  if (!maxFindingsResult.ok) {
    return { ok: false, exit: "invalid", error: maxFindingsResult.error };
  }

  const maxAttempts = Math.max(
    1,
    Math.min(
      input.maxAttempts ?? AUDIT_MAX_SNAPSHOT_ATTEMPTS,
      AUDIT_MAX_SNAPSHOT_ATTEMPTS
    )
  );
  const clock = input.clock ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const capabilities = defaultCapabilities(input.capabilities);
  const versions: AuditVersions = {
    gno: input.gnoVersion ?? VERSION,
    schema: AUDIT_SCHEMA_VERSION,
    ruleSet: AUDIT_RULE_SET_VERSION,
  };

  const runStartedAt = clock();
  const runStartedMs = monotonicNow();
  let snapshotMs = 0;
  let rulesMs = 0;
  let lastRules: AuditRuleResult[] = [];
  let lastFingerprints: AuditFingerprints | null = null;
  let snapshotChanged = false;
  let failed = false;
  let failureMessage = "Audit failed";
  const cancellationRule = (): AuditRuleResult =>
    materializeRule({
      ruleId: "audit.cancelled",
      category: scopeResult.scope.categories[0] ?? "links",
      status: "inconclusive",
      message: "Audit was cancelled",
      findings: [],
      findingCount: 0,
      skipReason: "cancelled",
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.signal?.aborted) {
      lastRules = [cancellationRule()];
      break;
    }
    const snapshotStarted = monotonicNow();
    let before: AuditFingerprints;
    try {
      before = normalizeFingerprints(await input.captureFingerprints());
    } catch (cause) {
      if (input.signal?.aborted) {
        lastRules = [cancellationRule()];
        break;
      }
      failed = true;
      failureMessage =
        cause instanceof Error
          ? cause.message
          : "Failed to capture audit fingerprints";
      break;
    }
    snapshotMs += Math.max(0, monotonicNow() - snapshotStarted);
    lastFingerprints = before;

    const ruleCtx: AuditRuleContext = {
      scope: scopeResult.scope,
      capabilities,
      fingerprints: before,
      attempt,
    };

    const rulesStarted = monotonicNow();
    try {
      const contributions = await collectContributions(input.rules, ruleCtx);
      lastRules = contributions.map(materializeRule);
    } catch (cause) {
      if (input.signal?.aborted) {
        lastRules = [cancellationRule()];
        break;
      }
      failed = true;
      failureMessage =
        cause instanceof Error ? cause.message : "Audit rule evaluation failed";
      break;
    }
    rulesMs += Math.max(0, monotonicNow() - rulesStarted);

    if (input.signal?.aborted) {
      lastRules = [cancellationRule()];
      break;
    }

    const afterStarted = monotonicNow();
    let after: AuditFingerprints;
    try {
      after = normalizeFingerprints(await input.captureFingerprints());
    } catch (cause) {
      if (input.signal?.aborted) {
        lastRules = [cancellationRule()];
        break;
      }
      failed = true;
      failureMessage =
        cause instanceof Error
          ? cause.message
          : "Failed to re-capture audit fingerprints";
      break;
    }
    snapshotMs += Math.max(0, monotonicNow() - afterStarted);

    if (fingerprintsEqual(before, after)) {
      snapshotChanged = false;
      lastFingerprints = after;
      break;
    }

    snapshotChanged = true;
    lastFingerprints = after;
    if (attempt === maxAttempts) {
      break;
    }
    // Discard rule results from a drifted attempt; retry with a fresh snapshot.
    lastRules = [];
  }

  const completedAt = clock();
  const totalMs = Math.max(0, monotonicNow() - runStartedMs);
  const fingerprints = lastFingerprints ?? {
    config: "",
    source: "",
    index: "",
    rules: "",
  };

  if (failed) {
    const report = buildReportFromRules({
      scope: scopeResult.scope,
      capabilities,
      fingerprints,
      versions,
      rules: [
        {
          ruleId: "audit.runner",
          category: scopeResult.scope.categories[0] ?? "links",
          status: "unavailable",
          message: failureMessage,
          findings: [],
          findingCount: 0,
          examinedCount: 0,
          durationMs: 0,
          skipReason: failureMessage,
        },
      ],
      status: "failed",
      maxFindings: maxFindingsResult.maxFindings,
      startedAt: runStartedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      snapshotMs,
      rulesMs,
      totalMs,
    });
    return { ok: true, report, exit: deriveAuditExitKind(report) };
  }

  const status = deriveAuditReportStatus({
    rules: lastRules,
    snapshotChanged,
  });

  // Mid-run drift must never report clean, even if evaluators emitted no findings.
  const rulesForReport =
    status === "changed_during_audit" && lastRules.length === 0
      ? [
          {
            ruleId: "audit.snapshot",
            category: scopeResult.scope.categories[0] ?? "links",
            status: "inconclusive" as const,
            message:
              "Source or index fingerprints changed during audit; results are not authoritative",
            findings: [] as AuditFinding[],
            findingCount: 0,
            examinedCount: 0,
            durationMs: 0,
            skipReason: "changed_during_audit",
          },
        ]
      : lastRules;

  const report = buildReportFromRules({
    scope: scopeResult.scope,
    capabilities,
    fingerprints,
    versions,
    rules: rulesForReport,
    status:
      status === "changed_during_audit"
        ? "changed_during_audit"
        : deriveAuditReportStatus({
            rules: rulesForReport,
            snapshotChanged: false,
          }),
    maxFindings: maxFindingsResult.maxFindings,
    startedAt: runStartedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    snapshotMs,
    rulesMs,
    totalMs,
  });

  return { ok: true, report, exit: deriveAuditExitKind(report) };
}

/**
 * Assert a store-like object does not expose callable mutating methods used
 * by audits. Tests wrap ports to prove no writes occur during a run.
 */
export function createAuditWriteGuard<T extends object>(
  port: T,
  forbidden: readonly AuditForbiddenStoreMethod[] = AUDIT_FORBIDDEN_STORE_METHODS
): T & { readonly writeAttempts: readonly string[] } {
  const writeAttempts: string[] = [];
  const forbiddenMethods = new Set<string>(forbidden);
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === "writeAttempts") return writeAttempts;
      if (typeof property === "string" && forbiddenMethods.has(property)) {
        return (..._args: unknown[]) => {
          writeAttempts.push(property);
          throw new Error(
            `Audit must not call mutating store method ${property}`
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as T & { readonly writeAttempts: readonly string[] };
}
