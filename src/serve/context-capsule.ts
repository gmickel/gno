/** REST adapters for the shared Context Capsule application boundary. */

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

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), {
      code: "invalid_input",
    });
  }
};

const errorStatus = (code: string): number => {
  if (code === "no_evidence") return 404;
  if (
    code.includes("changed_during") ||
    code === "capsule_mutated_during_verify"
  ) {
    return 409;
  }
  return code === "runtime_error" || code === "retrieval_failed" ? 500 : 400;
};

const errorResponse = (error: unknown): Response => {
  const publicError = contextSurfaceError(error);
  return new Response(JSON.stringify({ error: publicError }), {
    status: errorStatus(publicError.code),
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
