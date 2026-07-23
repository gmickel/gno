/** REST adapters for the shared Context Capsule application boundary. */

import type { GnoContextErrorCode } from "../sdk/types";
import type { ServerContext } from "./context";

import {
  formatContextCapsuleMarkdown,
  formatContextCapsuleVerificationMarkdown,
} from "../app/context-format";
import {
  buildContextCapsule,
  canonicalBuiltContextCapsuleJson,
  canonicalVerifiedContextCapsuleJson,
  validateContextCapsuleBuildInput,
  verifyContextCapsuleRuntime,
} from "../app/context-runtime";
import {
  contextSurfaceError,
  parseContextBuildSurfaceInput,
  parseContextVerifySurfaceInput,
} from "../app/context-surface";
import { ContextCapsuleContractError } from "../core/context-capsule";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new ContextCapsuleContractError("invalid_input", "Invalid JSON body");
  }
};

export type ContextRestErrorCode = GnoContextErrorCode | "runtime_error";

export const CONTEXT_REST_ERROR_STATUS = {
  invalid_goal: 400,
  invalid_budget: 400,
  invalid_filter: 400,
  invalid_uri: 400,
  invalid_input: 400,
  identity_mismatch: 400,
  no_evidence: 404,
  tokenizer_unavailable: 503,
  chunk_coordinate_mismatch: 409,
  stored_provenance_mismatch: 409,
  index_snapshot_mismatch: 409,
  index_changed_during_compile: 409,
  context_changed_during_compile: 409,
  capsule_mutated_during_verify: 409,
  context_changed_during_verify: 409,
  index_changed_during_verify: 409,
  retrieval_failed: 500,
  chunk_load_failed: 500,
  collection_load_failed: 500,
  content_load_failed: 500,
  context_load_failed: 500,
  document_load_failed: 500,
  index_snapshot_failed: 500,
  runtime_error: 500,
} as const satisfies Record<ContextRestErrorCode, number>;

export const contextRestStatusForCode = (code: string): number =>
  code in CONTEXT_REST_ERROR_STATUS
    ? CONTEXT_REST_ERROR_STATUS[code as ContextRestErrorCode]
    : 500;

const errorResponse = (error: unknown): Response => {
  const publicError = contextSurfaceError(error);
  return new Response(JSON.stringify({ error: publicError }), {
    status: contextRestStatusForCode(publicError.code),
    headers: JSON_HEADERS,
  });
};

export const handleContextBuild = async (
  context: ServerContext,
  request: Request
): Promise<Response> => {
  try {
    const { input, format } = parseContextBuildSurfaceInput(
      await parseJsonBody(request),
      context.indexName
    );
    validateContextCapsuleBuildInput(
      input,
      context.indexName,
      context.config.collections.map((collection) => collection.name)
    );
    const capsule = await buildContextCapsule(input, {
      store: context.store,
      config: context.config,
      indexName: context.indexName,
      vectorIndex: context.vectorIndex,
      embedPort: context.embedPort,
      rerankPort: context.rerankPort,
    });
    return format === "md"
      ? new Response(formatContextCapsuleMarkdown(capsule), {
          headers: MARKDOWN_HEADERS,
        })
      : new Response(canonicalBuiltContextCapsuleJson(capsule), {
          headers: JSON_HEADERS,
        });
  } catch (error) {
    return errorResponse(error);
  }
};

export const handleContextVerify = async (
  context: ServerContext,
  request: Request
): Promise<Response> => {
  try {
    const { capsule, format } = parseContextVerifySurfaceInput(
      await parseJsonBody(request)
    );
    const receipt = await verifyContextCapsuleRuntime(capsule, {
      store: context.store,
      config: context.config,
      indexName: context.indexName,
    });
    return format === "md"
      ? new Response(formatContextCapsuleVerificationMarkdown(receipt), {
          headers: MARKDOWN_HEADERS,
        })
      : new Response(canonicalVerifiedContextCapsuleJson(receipt), {
          headers: JSON_HEADERS,
        });
  } catch (error) {
    return errorResponse(error);
  }
};
