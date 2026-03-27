/**
 * Model preset registry.
 * Resolves active preset and model URIs from config.
 *
 * @module src/llm/registry
 */

import type { Config, ModelConfig, ModelPreset } from "../config/types";
import type { ModelType } from "./types";

import { DEFAULT_MODEL_PRESETS } from "../config/types";

// ─────────────────────────────────────────────────────────────────────────────
// Registry Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get model config with defaults.
 */
export function getModelConfig(config: Config): ModelConfig {
  const customPresets = config.models?.presets ?? [];
  const presetsById = new Map(
    DEFAULT_MODEL_PRESETS.map((preset) => [preset.id, preset] as const)
  );

  for (const preset of customPresets) {
    presetsById.set(preset.id, preset);
  }

  const mergedPresets = [
    ...DEFAULT_MODEL_PRESETS.map(
      (preset) => presetsById.get(preset.id) ?? preset
    ),
    ...customPresets.filter(
      (preset) => !DEFAULT_MODEL_PRESETS.some((base) => base.id === preset.id)
    ),
  ];

  return {
    activePreset: config.models?.activePreset ?? "slim-tuned",
    presets: mergedPresets,
    loadTimeout: config.models?.loadTimeout ?? 60_000,
    inferenceTimeout: config.models?.inferenceTimeout ?? 30_000,
    expandContextSize: config.models?.expandContextSize ?? 2_048,
    warmModelTtl: config.models?.warmModelTtl ?? 300_000,
  };
}

/**
 * Get the active preset from config.
 * Falls back to first preset if active not found.
 */
export function getActivePreset(config: Config): ModelPreset {
  const modelConfig = getModelConfig(config);
  const presetId = modelConfig.activePreset;
  const preset = modelConfig.presets.find((p) => p.id === presetId);

  if (preset) {
    return preset;
  }

  // Fallback to first preset
  const fallback = modelConfig.presets[0];
  if (fallback) {
    return fallback;
  }

  // Return built-in default (guaranteed to exist)
  const builtIn = DEFAULT_MODEL_PRESETS[0];
  if (!builtIn) {
    throw new Error("No default model presets configured");
  }
  return builtIn;
}

export function getExpandModelUri(config: Config, override?: string): string {
  if (override) {
    return override;
  }

  const preset = getActivePreset(config);
  return preset.expand ?? preset.gen;
}

export function getAnswerModelUri(config: Config, override?: string): string {
  if (override) {
    return override;
  }

  const preset = getActivePreset(config);
  return preset.gen;
}

/**
 * Resolve a model URI for a given type.
 * Uses override if provided, otherwise from active preset.
 */
export function resolveModelUri(
  config: Config,
  type: ModelType,
  override?: string
): string {
  if (override) {
    return override;
  }
  const preset = getActivePreset(config);
  if (type === "expand") {
    return preset.expand ?? preset.gen;
  }
  return preset[type];
}

/**
 * List all available presets.
 */
export function listPresets(config: Config): ModelPreset[] {
  const modelConfig = getModelConfig(config);
  return modelConfig.presets;
}

/**
 * Get a specific preset by ID.
 */
export function getPreset(config: Config, id: string): ModelPreset | undefined {
  const modelConfig = getModelConfig(config);
  return modelConfig.presets.find((p) => p.id === id);
}
