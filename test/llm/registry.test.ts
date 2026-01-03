/**
 * Tests for model preset registry.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";

import { DEFAULT_MODEL_PRESETS } from "../../src/config/types";
import {
  getActivePreset,
  getModelConfig,
  getPreset,
  listPresets,
  resolveModelUri,
} from "../../src/llm/registry";

function makeConfig(models?: Config["models"]): Config {
  return {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    models,
  };
}

describe("getModelConfig", () => {
  test("returns defaults when models not configured", () => {
    const config = makeConfig();
    const modelConfig = getModelConfig(config);

    expect(modelConfig.activePreset).toBe("slim");
    expect(modelConfig.presets).toEqual(DEFAULT_MODEL_PRESETS);
    expect(modelConfig.loadTimeout).toBe(60_000);
    expect(modelConfig.inferenceTimeout).toBe(30_000);
    expect(modelConfig.warmModelTtl).toBe(300_000);
  });

  test("uses configured values", () => {
    const config = makeConfig({
      activePreset: "quality",
      presets: DEFAULT_MODEL_PRESETS,
      loadTimeout: 120_000,
      inferenceTimeout: 60_000,
      warmModelTtl: 600_000,
    });
    const modelConfig = getModelConfig(config);

    expect(modelConfig.activePreset).toBe("quality");
    expect(modelConfig.loadTimeout).toBe(120_000);
    expect(modelConfig.inferenceTimeout).toBe(60_000);
    expect(modelConfig.warmModelTtl).toBe(600_000);
  });
});

describe("getActivePreset", () => {
  test("returns slim preset by default", () => {
    const config = makeConfig();
    const preset = getActivePreset(config);

    expect(preset.id).toBe("slim");
    expect(preset.name).toBe("Slim (Default, ~1GB)");
    expect(preset.embed).toContain("bge-m3");
  });

  test("returns configured active preset", () => {
    const config = makeConfig({
      activePreset: "quality",
      presets: DEFAULT_MODEL_PRESETS,
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      warmModelTtl: 300_000,
    });
    const preset = getActivePreset(config);

    expect(preset.id).toBe("quality");
    expect(preset.gen).toContain("Qwen3-4B");
  });

  test("falls back to first preset if active not found", () => {
    const config = makeConfig({
      activePreset: "nonexistent",
      presets: DEFAULT_MODEL_PRESETS,
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      warmModelTtl: 300_000,
    });
    const preset = getActivePreset(config);

    expect(preset.id).toBe("slim");
  });
});

describe("resolveModelUri", () => {
  test("returns active preset URI for type", () => {
    const config = makeConfig();

    expect(resolveModelUri(config, "embed")).toContain("bge-m3");
    expect(resolveModelUri(config, "rerank")).toContain("qwen3-reranker");
    expect(resolveModelUri(config, "gen")).toContain("Qwen3-1.7B");
  });

  test("returns override when provided", () => {
    const config = makeConfig();
    const override = "file:/custom/model.gguf";

    expect(resolveModelUri(config, "embed", override)).toBe(override);
  });
});

describe("listPresets", () => {
  test("returns all presets", () => {
    const config = makeConfig();
    const presets = listPresets(config);

    expect(presets).toHaveLength(DEFAULT_MODEL_PRESETS.length);
    expect(presets.map((p) => p.id)).toContain("slim");
    expect(presets.map((p) => p.id)).toContain("balanced");
    expect(presets.map((p) => p.id)).toContain("quality");
  });

  test("returns custom presets", () => {
    const customPreset = {
      id: "custom",
      name: "Custom Preset",
      embed: "hf:custom/embed/model.gguf",
      rerank: "hf:custom/rerank/model.gguf",
      gen: "hf:custom/gen/model.gguf",
    };
    const config = makeConfig({
      activePreset: "custom",
      presets: [customPreset],
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      warmModelTtl: 300_000,
    });
    const presets = listPresets(config);

    expect(presets).toHaveLength(1);
    expect(presets[0]?.id).toBe("custom");
  });
});

describe("getPreset", () => {
  test("returns preset by ID", () => {
    const config = makeConfig();
    const preset = getPreset(config, "quality");

    expect(preset).toBeDefined();
    expect(preset?.id).toBe("quality");
  });

  test("returns undefined for unknown ID", () => {
    const config = makeConfig();
    const preset = getPreset(config, "nonexistent");

    expect(preset).toBeUndefined();
  });
});
