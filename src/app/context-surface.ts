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
    since: z.string().optional(),
    until: z.string().optional(),
    graph: z.boolean().optional(),
    limit: positiveInteger.optional(),
    candidateLimit: positiveInteger.optional(),
    budgetTokens: positiveInteger,
    budgetBytes: positiveInteger.optional(),
    safetyMarginTokens: nonnegativeInteger.optional(),
    safetyMarginBytes: nonnegativeInteger.optional(),
    depthPolicy: z.enum(["fast", "balanced", "thorough"]).optional(),
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
}

export interface ParsedContextVerifySurfaceInput {
  capsule: Record<string, unknown>;
  format: ContextSurfaceFormat;
}

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
  const { format = "json", ...input } = parsed.data;
  return { input: { ...input, indexName }, format };
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
): { code: string; message: string } => ({
  code:
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "runtime_error",
  message: error instanceof Error ? error.message : String(error),
});
