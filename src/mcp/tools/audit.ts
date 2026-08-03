/** MCP gno_audit read-only knowledge-integrity tool. */

import { z } from "zod";

import type { AuditCategory, AuditReport } from "../../core/audit";
import type { ToolContext } from "../server";

import { AUDIT_CATEGORIES } from "../../core/audit";
import { runWorkspaceAudit } from "../../core/audit-workspace";
import { normalizeTag, validateTag } from "../../core/tags";
import { normalizeCollectionName } from "../../core/validation";
import { runTool, type ToolResult } from "./index";

export const auditInputSchema = z
  .object({
    category: z
      .enum(["links", "provenance", "freshness", "all"])
      .default("all"),
    collections: z.array(z.string().min(1)).max(256).default([]),
    paths: z.array(z.string().min(1)).max(256).default([]),
    tags: z.array(z.string().min(1)).max(256).default([]),
    maxFindings: z.number().int().min(1).max(1000).default(100),
    maxAgeDays: z.number().int().min(1).optional(),
    orphanRoots: z.array(z.string().min(1)).max(256).default([]),
    orphanIgnorePrefixes: z.array(z.string().min(1)).max(256).default([]),
  })
  .strict();

export type AuditMcpInput = z.infer<typeof auditInputSchema>;

export const AUDIT_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const categoriesFor = (category: AuditMcpInput["category"]): AuditCategory[] =>
  category === "all" ? [...AUDIT_CATEGORIES] : [category];

const formatAudit = (report: AuditReport): string =>
  [
    `Audit: ${report.status}`,
    `Categories: ${report.scope.categories.join(", ")}`,
    `Rules: ${report.counts.rules.total}`,
    `Findings: ${report.counts.findings.total} (${report.counts.findings.returned} returned)`,
    ...report.findings.map(
      (finding) =>
        `[${finding.severity}] ${finding.ruleId}: ${finding.subject}${finding.location ? ` ${finding.location}` : ""} — ${finding.message}`
    ),
  ].join("\n");

export const handleAudit = (
  input: AuditMcpInput,
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_audit",
    async () => {
      const normalizedCollections = input.collections.map(
        normalizeCollectionName
      );
      const normalizedTags = input.tags.map(normalizeTag);
      const invalidTag = normalizedTags.find((tag) => !validateTag(tag));
      if (invalidTag) throw new Error(`Invalid tag: "${invalidTag}"`);
      const missingCollection = normalizedCollections.find(
        (name) =>
          !ctx.collections.some((collection) => collection.name === name)
      );
      if (missingCollection) {
        throw new Error(`Collection not found: ${missingCollection}`);
      }
      const result = await runWorkspaceAudit({
        store: ctx.store,
        config: ctx.config,
        collections: ctx.collections,
        indexName: ctx.indexName,
        categories: categoriesFor(input.category),
        collectionFilters: normalizedCollections,
        pathFilters: input.paths,
        tagFilters: normalizedTags,
        maxFindings: input.maxFindings,
        agePolicy:
          input.maxAgeDays === undefined
            ? undefined
            : { maxAgeDays: input.maxAgeDays },
        orphanRoots: input.orphanRoots,
        orphanIgnorePrefixes: input.orphanIgnorePrefixes,
        signal,
      });
      if (!result.ok) throw new Error(result.error);
      return result.report;
    },
    formatAudit
  );
