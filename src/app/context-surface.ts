/** Closed wire contracts shared by Context Capsule REST and MCP surfaces. */

import { z } from "zod";

import type { ContextCapsuleBuildInput } from "./context-runtime-types";

import { ContextCapsuleContractError } from "../core/context-capsule";

const queryModeSchema = z
  .object({
    mode: z.enum(["term", "intent", "hyde"]),
    text: z.string(),
  })
  .strict();

const stringList = z.array(z.string());
const positiveInteger = z.number().int().positive();
const nonnegativeInteger = z.number().int().nonnegative();

/** Host-owned index identity is deliberately absent from this public input. */
export const contextBuildSurfaceSchema = z
  .object({
    goal: z.string(),
    query: z.string().optional(),
    collections: stringList.optional(),
    uriPrefix: z.string().nullable().optional(),
    queryModes: z.array(queryModeSchema).optional(),
    tagsAll: stringList.optional(),
    tagsAny: stringList.optional(),
    categories: stringList.optional(),
    author: z.string().optional(),
    lang: z.string().optional(),
    intent: z.string().optional(),
    exclude: stringList.optional(),
    minScore: z.number().min(0).max(1).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    graph: z.boolean().optional(),
    noRerank: z.boolean().optional(),
    limit: positiveInteger.optional(),
    candidateLimit: positiveInteger.optional(),
    budgetTokens: positiveInteger,
    budgetBytes: positiveInteger.optional(),
    safetyMarginTokens: nonnegativeInteger.optional(),
    safetyMarginBytes: nonnegativeInteger.optional(),
    depthPolicy: z.enum(["fast", "balanced", "thorough"]).optional(),
    projectHints: z.array(z.string()).max(16).optional(),
    format: z.enum(["json", "md"]).optional(),
  })
  .strict();

export const contextVerifySurfaceSchema = z
  .object({
    capsule: z.record(z.string(), z.unknown()),
    format: z.enum(["json", "md"]).optional(),
  })
  .strict();

export type ContextSurfaceFormat = "json" | "md";

export interface ParsedContextBuildSurfaceInput {
  input: ContextCapsuleBuildInput;
  format: ContextSurfaceFormat;
  projectHints?: string[];
}

export interface ParsedContextVerifySurfaceInput {
  capsule: Record<string, unknown>;
  format: ContextSurfaceFormat;
}

const CONTEXT_SURFACE_ERROR_MESSAGES = {
  capsule_mutated_during_verify:
    "The Context Capsule changed during verification.",
  chunk_coordinate_mismatch:
    "Indexed evidence coordinates do not match the source.",
  chunk_load_failed: "Context Capsule evidence chunks could not be loaded.",
  collection_load_failed: "Context Capsule collections could not be loaded.",
  content_load_failed: "Context Capsule source content could not be loaded.",
  context_changed_during_compile:
    "Configured context changed during compilation.",
  context_changed_during_verify:
    "Configured context changed during verification.",
  context_load_failed: "Configured context could not be loaded.",
  document_load_failed: "Context Capsule documents could not be loaded.",
  identity_mismatch: "The Context Capsule identity does not match its content.",
  index_changed_during_compile: "The index changed during compilation.",
  index_changed_during_verify: "The index changed during verification.",
  index_snapshot_failed: "The index snapshot could not be loaded.",
  index_snapshot_mismatch:
    "Indexed evidence does not match the captured snapshot.",
  invalid_budget: "The Context Capsule budget is invalid.",
  invalid_filter: "A Context Capsule filter is invalid.",
  invalid_goal: "The Context Capsule goal is invalid.",
  invalid_input: "The Context Capsule request is invalid.",
  invalid_uri: "The Context Capsule URI is invalid.",
  no_evidence: "No in-scope evidence was available for the Context Capsule.",
  retrieval_failed: "Context Capsule retrieval failed.",
  runtime_error: "The Context Capsule request failed.",
  stored_provenance_mismatch:
    "Stored evidence provenance does not match the source.",
  tokenizer_unavailable: "The required tokenizer is unavailable.",
} as const;

export type ContextSurfaceErrorCode =
  keyof typeof CONTEXT_SURFACE_ERROR_MESSAGES;

const invalidInput = (error: z.ZodError): ContextCapsuleContractError =>
  new ContextCapsuleContractError(
    "invalid_input",
    error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ")
  );

export const parseContextBuildSurfaceInput = (
  value: unknown,
  indexName: string
): ParsedContextBuildSurfaceInput => {
  const parsed = contextBuildSurfaceSchema.safeParse(value);
  if (!parsed.success) throw invalidInput(parsed.error);
  const { format = "json", projectHints, ...input } = parsed.data;
  return { input: { ...input, indexName }, format, projectHints };
};

export const parseContextVerifySurfaceInput = (
  value: unknown
): ParsedContextVerifySurfaceInput => {
  const parsed = contextVerifySurfaceSchema.safeParse(value);
  if (!parsed.success) throw invalidInput(parsed.error);
  return {
    capsule: parsed.data.capsule,
    format: parsed.data.format ?? "json",
  };
};

export const contextSurfaceError = (
  error: unknown
): { code: ContextSurfaceErrorCode; message: string } => {
  const candidate =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "runtime_error";
  const code = Object.hasOwn(CONTEXT_SURFACE_ERROR_MESSAGES, candidate)
    ? (candidate as ContextSurfaceErrorCode)
    : "runtime_error";
  return { code, message: CONTEXT_SURFACE_ERROR_MESSAGES[code] };
};
