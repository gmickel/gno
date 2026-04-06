import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { MutationResult } from "../../src/core/config-mutation";
import type { ServerContext } from "../../src/serve/context";
import type { ContextHolder } from "../../src/serve/routes/api";

import { handleSetPreset } from "../../src/serve/routes/api";

function makeConfig(): Config {
  return {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    models: {
      activePreset: "slim-tuned",
      presets: [
        {
          id: "slim-tuned",
          name: "GNO Slim Tuned",
          embed: "hf:custom/embed.gguf",
          rerank: "hf:custom/rerank.gguf",
          expand: "hf:custom/expand.gguf",
          gen: "hf:custom/gen.gguf",
        },
      ],
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
    },
  };
}

function makeContextHolder(config: Config): ContextHolder {
  return {
    current: {
      store: {} as ContextHolder["current"]["store"],
      config,
      vectorIndex: null,
      embedPort: null,
      expandPort: null,
      answerPort: null,
      rerankPort: null,
      capabilities: {
        bm25: true,
        vector: false,
        hybrid: false,
        answer: true,
      },
      scheduler: null,
      eventBus: null,
      watchService: null,
    },
    config,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

describe("POST /api/presets", () => {
  test("persists active preset change without expanding raw custom presets", async () => {
    const config = makeConfig();
    const ctxHolder = makeContextHolder(config);
    const state: { mutatedConfig?: Config } = {};

    const res = await handleSetPreset(
      ctxHolder,
      new Request("http://localhost/api/presets", {
        method: "POST",
        body: JSON.stringify({ presetId: "balanced" }),
      }),
      {
        applyConfigChangeFn: async (_ctxHolder, _store, mutate) => {
          const result = await mutate(config);
          if (!result.ok) {
            return result;
          }
          state.mutatedConfig = result.config;
          return result as MutationResult;
        },
        reloadServerContextFn: async (
          current,
          nextConfig
        ): Promise<ServerContext> => ({
          ...current,
          config: nextConfig ?? current.config,
          capabilities: {
            ...current.capabilities,
            answer: true,
          },
        }),
      }
    );

    expect(res.status).toBe(200);
    expect(state.mutatedConfig).toBeDefined();
    if (!state.mutatedConfig) {
      throw new Error("Expected mutated config");
    }
    expect(state.mutatedConfig.models?.activePreset).toBe("balanced");
    expect(state.mutatedConfig.models?.presets).toEqual(config.models?.presets);
    expect(ctxHolder.config.models?.activePreset).toBe("balanced");
    const body = (await res.json()) as {
      success: boolean;
      activePreset: string;
      embedModelChanged: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.activePreset).toBe("balanced");
    expect(body.embedModelChanged).toBe(true);
  });
});
