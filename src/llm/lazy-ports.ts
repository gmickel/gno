/** Defer model resolution/download until an actual inference operation. */
import type {
  EmbeddingPort,
  GenerationModelIdentity,
  GenerationPort,
  LlmResult,
  RerankPort,
} from "./types";

import { inferenceFailedError } from "./errors";
import { isHttpGenUri } from "./httpGeneration";

function lazyOwner<T extends { dispose(): Promise<void> }>(
  modelUri: string,
  create: () => Promise<LlmResult<T>>
) {
  let current: T | undefined;
  let pending: Promise<LlmResult<T>> | undefined;
  let disposed = false;
  const closed = (): LlmResult<T> => ({
    ok: false,
    error: inferenceFailedError(modelUri, new Error("Port is disposed")),
  });
  return {
    peek: () => current,
    get(): Promise<LlmResult<T>> {
      if (disposed) return Promise.resolve(closed());
      if (current) return Promise.resolve({ ok: true, value: current });
      pending ??= create()
        .then(async (result) => {
          if (disposed) {
            if (result.ok) await result.value.dispose();
            return closed();
          }
          if (result.ok) current = result.value;
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await pending;
      const owned = current;
      current = undefined;
      await owned?.dispose();
    },
  };
}

export function lazyEmbeddingPort(
  modelUri: string,
  create: () => Promise<LlmResult<EmbeddingPort>>
): EmbeddingPort {
  const owner = lazyOwner(modelUri, create);
  return {
    modelUri,
    async init() {
      const port = await owner.get();
      return port.ok ? port.value.init() : port;
    },
    async embed(text) {
      const port = await owner.get();
      return port.ok ? port.value.embed(text) : port;
    },
    async embedBatch(texts) {
      const port = await owner.get();
      return port.ok ? port.value.embedBatch(texts) : port;
    },
    dimensions() {
      const port = owner.peek();
      if (!port)
        throw new Error(
          "Call init() or embed() first to initialize dimensions"
        );
      return port.dimensions();
    },
    getIdentity: () => owner.peek()?.getIdentity?.(),
    dispose: () => owner.dispose(),
  };
}

export interface LazyGenerationPortOptions {
  /** Read-only identity probe used before the underlying port is initialized. */
  resolveModelIdentity?: () => Promise<GenerationModelIdentity | null>;
}

export function lazyGenerationPort(
  modelUri: string,
  create: () => Promise<LlmResult<GenerationPort>>,
  options?: LazyGenerationPortOptions
): GenerationPort {
  const owner = lazyOwner(modelUri, create);
  return {
    modelUri,
    get modelPath() {
      return owner.peek()?.modelPath;
    },
    get modelFingerprint() {
      return owner.peek()?.modelFingerprint;
    },
    async resolveModelIdentity() {
      const existing = owner.peek();
      if (existing) {
        return existing.modelPath || existing.modelFingerprint
          ? {
              modelPath: existing.modelPath,
              modelFingerprint: existing.modelFingerprint,
            }
          : null;
      }
      if (!options?.resolveModelIdentity) return null;
      try {
        return await options.resolveModelIdentity();
      } catch {
        return null;
      }
    },
    // These are the fixed native/HTTP adapter contracts; no probing required.
    structuredOutput: isHttpGenUri(modelUri) ? "none" : "json_schema",
    async generate(prompt, params, genOptions) {
      const port = await owner.get();
      return port.ok ? port.value.generate(prompt, params, genOptions) : port;
    },
    dispose: () => owner.dispose(),
  };
}

export function lazyRerankPort(
  modelUri: string,
  create: () => Promise<LlmResult<RerankPort>>
): RerankPort {
  const owner = lazyOwner(modelUri, create);
  return {
    modelUri,
    async rerank(query, documents) {
      const port = await owner.get();
      return port.ok ? port.value.rerank(query, documents) : port;
    },
    dispose: () => owner.dispose(),
  };
}
