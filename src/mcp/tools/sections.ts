/**
 * MCP gno_section — read-only section target create/resolve.
 *
 * Always registered. No writes, no target persistence, no parser fork.
 * Consumes shared core create/resolve + transport projection (fn-61.6).
 *
 * @module src/mcp/tools/sections
 */

import { z } from "zod";

import type { DocumentRow } from "../../store/types";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { parseRef } from "../../core/ref-parser";
import {
  CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
  createSectionTarget,
  extractSections,
  isBoundedSectionTarget,
  isTransportBoundedCanonicalUri,
  parseSectionTargetCreateSelector,
  parseSectionTargetV1,
  projectSectionTargetCreateResult,
  projectSectionTargetResolveResult,
  resolveSectionTarget,
  SECTION_TARGET_BOUNDS,
  type SectionCitationV1,
  type SectionResolutionDiagnostics,
  type SectionResolutionStatus,
  type SectionTargetV1,
} from "../../core/sections";
import { runTool, type ToolResult } from "./index";

export const SECTION_MCP_SCHEMA_VERSION = "1.0" as const;

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const REF_MAX_CHARS = 2048;

const positiveSafeInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const boundedNonEmpty = (max: number) => z.string().min(1).max(max);

/**
 * Closed SectionTargetV1 Zod mirror for MCP SDK validation.
 * Object (not union) so McpServer can publish/normalize JSON Schema.
 * Field bounds stay JSON-schema-compatible; cross-field rules via superRefine.
 */
export const sectionTargetInputSchema = z
  .object({
    schemaVersion: z.literal("1"),
    document: z
      .object({
        uri: boundedNonEmpty(SECTION_TARGET_BOUNDS.uriMaxChars),
      })
      .strict(),
    anchor: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars),
    headingPath: z
      .array(boundedNonEmpty(SECTION_TARGET_BOUNDS.headingPathItemMaxChars))
      .min(1)
      .max(SECTION_TARGET_BOUNDS.headingPathMaxItems),
    occurrence: positiveSafeInt,
    quote: z
      .object({
        exact: z.string().max(SECTION_TARGET_BOUNDS.exactMaxChars),
        prefix: z.string().max(SECTION_TARGET_BOUNDS.prefixMaxChars),
        suffix: z.string().max(SECTION_TARGET_BOUNDS.suffixMaxChars),
      })
      .strict(),
    sourceFingerprint: z.string().regex(FINGERPRINT_PATTERN),
    hints: z
      .object({
        line: positiveSafeInt,
        startOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        endOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (target.hints.endOffset < target.hints.startOffset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hints", "endOffset"],
        message: "hints.endOffset must be >= hints.startOffset",
      });
    }
    if (!isBoundedSectionTarget(target as SectionTargetV1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Section target exceeds size bounds",
      });
    }
  });

const refSchema = boundedNonEmpty(REF_MAX_CHARS).describe(
  "Document reference: gno:// URI, collection/path, or #docid"
);

/**
 * Closed create/resolve input. Single object schema (MCP SDK cannot list/validate
 * Zod unions as tool inputSchema/outputSchema).
 */
export const sectionInputSchema = z
  .object({
    action: z.enum(["create", "resolve"]),
    ref: refSchema,
    anchor: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars).optional(),
    line: positiveSafeInt.optional(),
    target: sectionTargetInputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "create") {
      const hasAnchor = value.anchor !== undefined;
      const hasLine = value.line !== undefined;
      if (hasAnchor === hasLine) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "create requires exactly one of anchor|line",
        });
      }
      if (value.target !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: "create forbids target",
        });
      }
      return;
    }
    if (value.target === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "resolve requires target",
      });
    }
    if (value.anchor !== undefined || value.line !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resolve forbids anchor|line",
      });
    }
  });

export type SectionInput = z.infer<typeof sectionInputSchema>;

const citationSchema = z
  .object({
    uri: boundedNonEmpty(SECTION_TARGET_BOUNDS.uriMaxChars),
    anchor: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars),
    title: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars),
    lineStart: positiveSafeInt,
    lineEnd: positiveSafeInt,
    sourceFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  })
  .strict()
  .superRefine((citation, ctx) => {
    if (citation.lineEnd < citation.lineStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "citation.lineEnd must be >= citation.lineStart",
      });
    }
  });

const diagnosticsSchema = z
  .object({
    reason: z.string().min(1).max(256).optional(),
    candidates: z
      .array(
        z
          .object({
            anchor: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars),
            line: positiveSafeInt,
            title: boundedNonEmpty(SECTION_TARGET_BOUNDS.anchorMaxChars),
            headingPath: z
              .array(
                boundedNonEmpty(SECTION_TARGET_BOUNDS.headingPathItemMaxChars)
              )
              .min(1)
              .max(SECTION_TARGET_BOUNDS.headingPathMaxItems),
            occurrence: positiveSafeInt,
          })
          .strict()
      )
      .max(32)
      .optional(),
    candidateCount: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    candidatesTruncated: z.boolean().optional(),
  })
  .strict()
  .superRefine((diagnostics, ctx) => {
    const hasCandidates = diagnostics.candidates !== undefined;
    const hasCount = diagnostics.candidateCount !== undefined;
    const hasTruncated = diagnostics.candidatesTruncated !== undefined;
    if (hasCandidates || hasCount || hasTruncated) {
      if (!(hasCandidates && hasCount && hasTruncated)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "diagnostics candidates, candidateCount, and candidatesTruncated are co-required",
        });
      }
    }
  });

/**
 * SDK-validated structured output for gno_section.
 * Single object (not union) so McpServer can publish/validate outputSchema.
 */
export const sectionOutputSchema = z
  .object({
    schemaVersion: z.literal(SECTION_MCP_SCHEMA_VERSION),
    action: z.enum(["create", "resolve"]),
    uri: boundedNonEmpty(SECTION_TARGET_BOUNDS.uriMaxChars),
    target: sectionTargetInputSchema,
    status: z
      .enum(["exact", "recovered", "ambiguous", "stale", "missing"])
      .optional(),
    currentFingerprint: z.string().regex(FINGERPRINT_PATTERN).optional(),
    diagnostics: diagnosticsSchema.optional(),
    citation: citationSchema.optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.action === "create") {
      if (
        result.status !== undefined ||
        result.currentFingerprint !== undefined ||
        result.diagnostics !== undefined ||
        result.citation !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "create result forbids resolve-only fields",
        });
      }
      return;
    }
    if (
      result.status === undefined ||
      result.currentFingerprint === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resolve requires status and currentFingerprint",
      });
      return;
    }
    if (result.diagnostics === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnostics"],
        message: "resolve requires diagnostics",
      });
    }
    const navigable =
      result.status === "exact" || result.status === "recovered";
    if (navigable && result.citation === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citation"],
        message: "exact/recovered require citation",
      });
    }
    if (!navigable && result.citation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citation"],
        message: "ambiguous/stale/missing forbid citation",
      });
    }
  });

export type SectionMcpResult = z.infer<typeof sectionOutputSchema>;

export const SECTION_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

async function lookupDocument(
  ctx: ToolContext,
  ref: string
): Promise<
  { ok: true; doc: DocumentRow } | { ok: false; code: string; message: string }
> {
  const parsed = parseRef(ref);
  if ("error" in parsed) {
    return {
      ok: false,
      code: MCP_ERRORS.INVALID_INPUT.code,
      message: `Invalid ref format: ${parsed.error}`,
    };
  }

  let doc: DocumentRow | null = null;
  switch (parsed.type) {
    case "docid": {
      const result = await ctx.store.getDocumentByDocid(parsed.value);
      doc = result.ok ? result.value : null;
      break;
    }
    case "uri": {
      const result = await ctx.store.getDocumentByUri(parsed.value);
      doc = result.ok ? result.value : null;
      break;
    }
    case "collPath": {
      if (!(parsed.collection && parsed.relPath)) {
        return {
          ok: false,
          code: MCP_ERRORS.INVALID_INPUT.code,
          message: "Invalid collection/path format",
        };
      }
      const canonical = ctx.collections.find(
        (c) => c.name.toLowerCase() === parsed.collection!.toLowerCase()
      );
      const collectionName = canonical?.name ?? parsed.collection;
      const result = await ctx.store.getDocument(
        collectionName,
        parsed.relPath
      );
      doc = result.ok ? result.value : null;
      break;
    }
  }

  if (!doc) {
    return {
      ok: false,
      code: MCP_ERRORS.NOT_FOUND.code,
      message: `Document not found: ${ref}`,
    };
  }
  return { ok: true, doc };
}

async function loadIndexedContent(
  ctx: ToolContext,
  ref: string
): Promise<{ doc: DocumentRow; content: string }> {
  const lookup = await lookupDocument(ctx, ref);
  if (!lookup.ok) {
    throw new Error(`${lookup.code}: ${lookup.message}`);
  }
  const { doc } = lookup;
  if (!doc.mirrorHash) {
    throw new Error(
      `${MCP_ERRORS.NOT_FOUND.code}: Document content unavailable`
    );
  }
  const contentResult = await ctx.store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    throw new Error("RUNTIME: Mirror content unavailable");
  }
  if (!isTransportBoundedCanonicalUri(doc.uri)) {
    throw new Error(`VALIDATION: ${CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS}`);
  }
  return { doc, content: contentResult.value };
}

function formatSectionResult(data: SectionMcpResult): string {
  const json = JSON.stringify(data, null, 2);
  if (data.action === "create") {
    return [
      `Created section target for ${data.uri} (anchor=${data.target.anchor}, line=${data.target.hints.line}).`,
      "",
      json,
    ].join("\n");
  }

  if (data.citation) {
    const citation: SectionCitationV1 = data.citation;
    const lineCount = citation.lineEnd - citation.lineStart + 1;
    return [
      `Resolved section (${data.status}) in ${citation.uri}: ${citation.title} (#${citation.anchor}), lines ${citation.lineStart}-${citation.lineEnd}.`,
      `Follow up with gno_get: {"ref":${JSON.stringify(citation.uri)},"fromLine":${citation.lineStart},"lineCount":${lineCount}}`,
      "",
      json,
    ].join("\n");
  }

  const status = data.status as SectionResolutionStatus;
  return [
    `Section resolution status is ${status}; this result is not safe to navigate or cite.`,
    "",
    json,
  ].join("\n");
}

async function handleCreate(
  ctx: ToolContext,
  ref: string,
  selectorRaw: { anchor?: string; line?: number }
): Promise<SectionMcpResult> {
  const selector = parseSectionTargetCreateSelector(selectorRaw);
  if (!selector.ok) {
    throw new Error(`VALIDATION: ${selector.error}`);
  }

  const { doc, content } = await loadIndexedContent(ctx, ref);
  const target = await createSectionTarget({
    content,
    uri: doc.uri,
    ...selector.value,
  });

  if (!target) {
    const sections = extractSections(content);
    const matched =
      selector.value.anchor !== undefined
        ? sections.some((section) => section.anchor === selector.value.anchor)
        : sections.some((section) => section.line === selector.value.line);
    if (!matched) {
      throw new Error(`${MCP_ERRORS.NOT_FOUND.code}: Section not found`);
    }
    throw new Error("VALIDATION: Section target exceeds size bounds");
  }

  const projected = projectSectionTargetCreateResult(doc.uri, target);
  return {
    schemaVersion: SECTION_MCP_SCHEMA_VERSION,
    action: "create",
    ...projected,
  };
}

async function handleResolve(
  ctx: ToolContext,
  ref: string,
  targetRaw: unknown
): Promise<SectionMcpResult> {
  const parsed = parseSectionTargetV1(targetRaw);
  if (!parsed.ok) {
    throw new Error(`VALIDATION: ${parsed.error}`);
  }

  const { doc, content } = await loadIndexedContent(ctx, ref);
  const resolution = await resolveSectionTarget({
    content,
    target: parsed.value,
    uri: doc.uri,
  });
  const projected = projectSectionTargetResolveResult(doc.uri, resolution);

  if (projected.citation) {
    return {
      schemaVersion: SECTION_MCP_SCHEMA_VERSION,
      action: "resolve",
      uri: projected.uri,
      status: projected.status as "exact" | "recovered",
      currentFingerprint: projected.currentFingerprint,
      target: projected.target,
      diagnostics: projected.diagnostics as SectionResolutionDiagnostics,
      citation: projected.citation,
    };
  }

  return {
    schemaVersion: SECTION_MCP_SCHEMA_VERSION,
    action: "resolve",
    uri: projected.uri,
    status: projected.status as "ambiguous" | "stale" | "missing",
    currentFingerprint: projected.currentFingerprint,
    target: projected.target,
    diagnostics: projected.diagnostics as SectionResolutionDiagnostics,
  };
}

/**
 * Handle gno_section tool call. Read-only — never mutates store or disk.
 */
export function handleSection(
  args: SectionInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_section",
    async () => {
      if (args.action === "create") {
        if (args.anchor !== undefined) {
          return handleCreate(ctx, args.ref, { anchor: args.anchor });
        }
        if (args.line !== undefined) {
          return handleCreate(ctx, args.ref, { line: args.line });
        }
        throw new Error(
          "VALIDATION: create requires exactly one of anchor|line"
        );
      }
      if (args.target === undefined) {
        throw new Error("VALIDATION: resolve requires target");
      }
      return handleResolve(ctx, args.ref, args.target);
    },
    formatSectionResult
  );
}
