/** MCP Context Capsule tools over the shared application runtime. */

import type { EmbeddingPort, RerankPort } from "../../llm/types";
import type { VectorIndexPort } from "../../store/vector";
import type { ToolContext } from "../server";
import type { ToolResult } from "./index";

import {
  formatContextCapsuleMarkdown,
  formatContextCapsuleVerificationMarkdown,
} from "../../app/context-format";
import {
  buildContextCapsule,
  canonicalBuiltContextCapsuleJson,
  canonicalVerifiedContextCapsuleJson,
  validateContextCapsuleBuildInput,
  verifyContextCapsuleRuntime,
} from "../../app/context-runtime";
import {
  contextSurfaceError,
  parseContextBuildSurfaceInput,
  parseContextVerifySurfaceInput,
} from "../../app/context-surface";
import { createNonTtyProgressRenderer } from "../../cli/progress";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";

interface ContextToolResultData {
  structuredContent: Record<string, unknown>;
  text: string;
}

const asToolResult = (data: ContextToolResultData): ToolResult => ({
  content: [{ type: "text", text: data.text }],
  structuredContent: data.structuredContent,
});

const asToolError = (error: unknown): ToolResult => {
  const publicError = contextSurfaceError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error [${publicError.code}]: ${publicError.message}`,
      },
    ],
    structuredContent: {
      error: publicError.code,
      message: publicError.message,
    },
  };
};

const runContextTool = async (
  context: ToolContext,
  operation: () => Promise<ContextToolResultData>
): Promise<ToolResult> => {
  if (context.isShuttingDown()) {
    return asToolError(
      Object.assign(new Error("Server is shutting down"), {
        code: "runtime_error",
      })
    );
  }
  const release = await context.toolMutex.acquire();
  try {
    return asToolResult(await operation());
  } catch (error) {
    return asToolError(error);
  } finally {
    release();
  }
};

interface McpModelPorts {
  embedPort: EmbeddingPort | null;
  rerankPort: RerankPort | null;
  vectorIndex: VectorIndexPort | null;
  dispose(): Promise<void>;
}

const createMcpModelPorts = async (
  context: ToolContext,
  collection?: string
): Promise<McpModelPorts> => {
  const llm = new LlmAdapter(context.config);
  const policy = resolveDownloadPolicy(process.env, {});
  const progress = createNonTtyProgressRenderer();
  const embedUri = resolveModelUri(
    context.config,
    "embed",
    undefined,
    collection
  );
  let embedPort: EmbeddingPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;
  const embedResult = await llm.createEmbeddingPort(embedUri, {
    policy,
    onProgress: (value) => progress("embed", value),
  });
  if (embedResult.ok) {
    embedPort = embedResult.value;
    const initialized = await embedPort.init();
    if (initialized.ok) {
      const vectorResult = await createVectorIndexPort(
        context.store.getRawDb(),
        { model: embedUri, dimensions: embedPort.dimensions() }
      );
      if (vectorResult.ok) vectorIndex = vectorResult.value;
    }
  }
  const rerankResult = await llm.createRerankPort(
    resolveModelUri(context.config, "rerank", undefined, collection),
    {
      policy,
      onProgress: (value) => progress("rerank", value),
    }
  );
  if (rerankResult.ok) rerankPort = rerankResult.value;
  return {
    embedPort,
    rerankPort,
    vectorIndex,
    async dispose() {
      await embedPort?.dispose();
      await rerankPort?.dispose();
    },
  };
};

export const handleContext = (
  args: unknown,
  context: ToolContext
): Promise<ToolResult> =>
  runContextTool(context, async () => {
    const parsed = parseContextBuildSurfaceInput(args, context.indexName);
    // This guard is intentionally before any model construction/download.
    validateContextCapsuleBuildInput(
      parsed.input,
      context.indexName,
      context.config.collections.map((collection) => collection.name)
    );
    const useModels = parsed.input.depthPolicy !== "fast";
    const modelPorts = useModels
      ? await createMcpModelPorts(
          context,
          parsed.input.collections?.length === 1
            ? parsed.input.collections[0]
            : undefined
        )
      : null;
    try {
      const capsule = await buildContextCapsule(parsed.input, {
        store: context.store,
        config: context.config,
        indexName: context.indexName,
        vectorIndex: modelPorts?.vectorIndex ?? null,
        embedPort: modelPorts?.embedPort ?? null,
        rerankPort: modelPorts?.rerankPort ?? null,
      });
      return {
        structuredContent: capsule as unknown as Record<string, unknown>,
        text:
          parsed.format === "md"
            ? formatContextCapsuleMarkdown(capsule)
            : canonicalBuiltContextCapsuleJson(capsule),
      };
    } finally {
      await modelPorts?.dispose();
    }
  });

export const handleContextVerify = (
  args: unknown,
  context: ToolContext
): Promise<ToolResult> =>
  runContextTool(context, async () => {
    const parsed = parseContextVerifySurfaceInput(args);
    const receipt = await verifyContextCapsuleRuntime(parsed.capsule, {
      store: context.store,
      config: context.config,
      indexName: context.indexName,
    });
    return {
      structuredContent: receipt as unknown as Record<string, unknown>,
      text:
        parsed.format === "md"
          ? formatContextCapsuleVerificationMarkdown(receipt)
          : canonicalVerifiedContextCapsuleJson(receipt),
    };
  });
