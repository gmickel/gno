/** MCP Context Capsule tools over the shared application runtime. */

import type { EmbeddingPort, RerankPort } from "../../llm/types";
import type { VectorIndexPort } from "../../store/vector";
import type { ToolContext } from "../server";
import type { ToolResult } from "./index";

import { formatContextCapsuleAgentJson } from "../../app/context-agent-projection";
import { formatContextCapsuleVerificationMarkdown } from "../../app/context-format";
import {
  buildContextCapsule,
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

interface McpModelPortFactory {
  createEmbeddingPort: LlmAdapter["createEmbeddingPort"];
  createRerankPort: LlmAdapter["createRerankPort"];
  dispose: LlmAdapter["dispose"];
}

export const disposeContextModelOwners = async (
  owners: readonly { dispose(): Promise<void> }[]
): Promise<void> => {
  await Promise.allSettled(owners.map((owner) => owner.dispose()));
};

const modelOwners = (
  factory: McpModelPortFactory,
  ownedEmbedPort: EmbeddingPort | null,
  rerankPort: RerankPort | null
): { dispose(): Promise<void> }[] => {
  const owners: { dispose(): Promise<void> }[] = [];
  if (ownedEmbedPort) owners.push(ownedEmbedPort);
  if (rerankPort) owners.push(rerankPort);
  owners.push(factory);
  return owners;
};

export const createMcpModelPorts = async (
  context: ToolContext,
  collection?: string,
  factoryOverride?: McpModelPortFactory
): Promise<McpModelPorts> => {
  const llm = new LlmAdapter(context.config);
  const factory = factoryOverride ?? llm;
  const policy = resolveDownloadPolicy(process.env, {});
  const progress = createNonTtyProgressRenderer();
  const embedUri = resolveModelUri(
    context.config,
    "embed",
    undefined,
    collection
  );
  let embedPort: EmbeddingPort | null = null;
  let ownedEmbedPort: EmbeddingPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;
  try {
    const embedResult = await factory.createEmbeddingPort(embedUri, {
      policy,
      onProgress: (value) => progress("embed", value),
    });
    if (embedResult.ok) {
      // Take ownership before init: init failures must not leak the port.
      ownedEmbedPort = embedResult.value;
      const initialized = await ownedEmbedPort.init();
      if (initialized.ok) {
        embedPort = ownedEmbedPort;
        const vectorResult = await createVectorIndexPort(
          context.store.getRawDb(),
          { model: embedUri, dimensions: ownedEmbedPort.dimensions() }
        );
        if (vectorResult.ok) vectorIndex = vectorResult.value;
      }
    }
    const rerankResult = await factory.createRerankPort(
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
        await disposeContextModelOwners(
          modelOwners(factory, ownedEmbedPort, rerankPort)
        );
      },
    };
  } catch (error) {
    await disposeContextModelOwners(
      modelOwners(factory, ownedEmbedPort, rerankPort)
    );
    throw error;
  }
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
        // MCP model context receives this projection exactly once. The full
        // canonical capsule remains available to application clients through
        // structuredContent and is deliberately not duplicated in text.
        text: formatContextCapsuleAgentJson(capsule),
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
