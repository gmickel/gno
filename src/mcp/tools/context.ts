/** MCP Context Capsule tools over the shared application runtime. */

import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type { ModelLease } from "../../llm/nodeLlamaCpp/lifecycle";
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../llm/types";
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
import { ContextCapsuleContractError } from "../../core/context-capsule";
import {
  ProjectAffinityInputError,
  resolveRemoteProjectAffinity,
} from "../../core/project-affinity-surface";
import {
  finishRetrievalTraceAfterError,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";

interface ContextToolResultData {
  structuredContent: Record<string, unknown>;
  text: string;
  traceId?: string;
}

const asToolResult = (data: ContextToolResultData): ToolResult => ({
  content: [{ type: "text", text: data.text }],
  structuredContent: data.structuredContent,
  ...(data.traceId
    ? { _meta: { gno: { retrievalTrace: { traceId: data.traceId } } } }
    : {}),
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
    const data = await (context.runWithSnapshot?.(operation) ?? operation());
    return asToolResult(data);
  } catch (error) {
    return asToolError(error);
  } finally {
    release();
  }
};

interface McpModelPorts {
  embedPort: EmbeddingPort | null;
  genPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  vectorIndex: VectorIndexPort | null;
  dispose(): Promise<void>;
}

export interface McpModelPortFactory {
  createEmbeddingPort: LlmAdapter["createEmbeddingPort"];
  createGenerationPort?: LlmAdapter["createGenerationPort"];
  createRerankPort: LlmAdapter["createRerankPort"];
  acquireModelLease?: LlmAdapter["acquireModelLease"];
}

export const disposeContextModelOwners = async (
  portOwners: readonly { dispose(): Promise<void> }[],
  lease?: ModelLease
): Promise<void> => {
  await Promise.allSettled(
    portOwners.map((owner) => Promise.resolve().then(() => owner.dispose()))
  );
  lease?.release();
};

export const createMcpModelPorts = async (
  context: ToolContext,
  collection?: string,
  factoryOverride?: McpModelPortFactory,
  options: { generation?: boolean } = {}
): Promise<McpModelPorts> => {
  const llm = new LlmAdapter(context.config);
  const factory = factoryOverride ?? llm;
  const lease = factory.acquireModelLease?.();
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
  let genPort: GenerationPort | null = null;
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
    if (options.generation && factory.createGenerationPort) {
      const genResult = await factory.createGenerationPort(
        resolveModelUri(context.config, "gen", undefined, collection),
        {
          policy,
          onProgress: (value) => progress("gen", value),
        }
      );
      if (genResult.ok) genPort = genResult.value;
    }
    return {
      embedPort,
      genPort,
      rerankPort,
      vectorIndex,
      async dispose() {
        await disposeContextModelOwners(
          [ownedEmbedPort, rerankPort, genPort].filter(
            (port): port is EmbeddingPort | RerankPort | GenerationPort =>
              port !== null
          ),
          lease
        );
      },
    };
  } catch (error) {
    await disposeContextModelOwners(
      [ownedEmbedPort, rerankPort, genPort].filter(
        (port): port is EmbeddingPort | RerankPort | GenerationPort =>
          port !== null
      ),
      lease
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
    const collection =
      parsed.input.collections?.length === 1
        ? parsed.input.collections[0]
        : undefined;
    const modelUris = useModels
      ? [
          resolveModelUri(context.config, "embed", undefined, collection),
          resolveModelUri(context.config, "rerank", undefined, collection),
        ]
      : [];
    let modelPorts: Awaited<ReturnType<typeof createMcpModelPorts>> | null =
      null;
    let traceSession: RetrievalTraceSession | undefined;
    try {
      let projectAffinity;
      try {
        projectAffinity = await resolveRemoteProjectAffinity(
          context.config,
          parsed.projectHints
        );
      } catch (error) {
        if (error instanceof ProjectAffinityInputError) {
          throw new ContextCapsuleContractError("invalid_input", error.message);
        }
        throw error;
      }
      const traceStart = await startRetrievalTraceRequest({
        store: context.store,
        config: context.config,
        query: parsed.input.query ?? parsed.input.goal,
        goal: parsed.input.goal,
        filters: {
          limit: parsed.input.limit,
          collection,
          collections: [...(parsed.input.collections ?? [])].sort(),
          lang: parsed.input.lang,
          tagsAll: parsed.input.tagsAll,
          tagsAny: parsed.input.tagsAny,
          since: parsed.input.since,
          until: parsed.input.until,
          categories: parsed.input.categories,
          author: parsed.input.author,
          graph: parsed.input.graph,
          candidateLimit: parsed.input.candidateLimit,
          queryModes: parsed.input.queryModes,
          uriPrefix: parsed.input.uriPrefix ?? undefined,
        },
        pipeline: "context",
        indexName: context.indexName,
        modelUris,
      });
      if (!traceStart.ok) throw new Error(traceStart.error.message);
      traceSession = traceStart.value ?? undefined;
      modelPorts = useModels
        ? await createMcpModelPorts(context, collection)
        : null;
      const capsule = await buildContextCapsule(parsed.input, {
        store: context.store,
        config: context.config,
        indexName: context.indexName,
        vectorIndex: modelPorts?.vectorIndex ?? null,
        embedPort: modelPorts?.embedPort ?? null,
        rerankPort: modelPorts?.rerankPort ?? null,
        projectAffinity,
        traceSession,
      });
      const finalized = await traceSession?.finish("completed");
      if (finalized && !finalized.ok) throw new Error(finalized.error.message);
      return {
        structuredContent: capsule as unknown as Record<string, unknown>,
        // MCP model context receives this projection exactly once. The full
        // canonical capsule remains available to application clients through
        // structuredContent and is deliberately not duplicated in text.
        text: formatContextCapsuleAgentJson(capsule),
        traceId: traceSession?.metadata()?.traceId,
      };
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
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
