/**
 * gno models use command implementation.
 * Switch active model preset.
 *
 * @module src/cli/commands/models/use
 */

import { createDefaultConfig } from "../../../config";
import { applyConfigFileChange } from "../../../core/config-mutation";
import { getPreset, listPresets, resolveModelUri } from "../../../llm/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelsUseOptions {
  /** Override config path */
  configPath?: string;
}

export type ModelsUseResult =
  | {
      success: true;
      preset: string;
      name: string;
      embedModelChanged: boolean;
    }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno models use command.
 */
export async function modelsUse(
  presetId: string,
  options: ModelsUseOptions = {}
): Promise<ModelsUseResult> {
  const mutation = await applyConfigFileChange(
    {
      configPath: options.configPath,
      createConfigIfMissing: createDefaultConfig,
    },
    (config) => {
      const preset = getPreset(config, presetId);
      if (!preset) {
        const available = listPresets(config)
          .map((item) => item.id)
          .join(", ");
        return {
          ok: false as const,
          error: `Unknown preset: ${presetId}. Available: ${available}`,
          code: "UNKNOWN_PRESET",
        };
      }
      const previousEmbedModel = resolveModelUri(config, "embed");
      return {
        ok: true as const,
        config: {
          ...config,
          models: {
            activePreset: presetId,
            presets: config.models?.presets ?? [],
            loadTimeout: config.models?.loadTimeout ?? 60_000,
            inferenceTimeout: config.models?.inferenceTimeout ?? 30_000,
            expandContextSize: config.models?.expandContextSize ?? 2_048,
            warmModelTtl: config.models?.warmModelTtl ?? 300_000,
          },
        },
        value: {
          name: preset.name,
          embedModelChanged: previousEmbedModel !== preset.embed,
        },
      };
    }
  );
  if (!mutation.ok) {
    return {
      success: false,
      error: mutation.error,
    };
  }

  return {
    success: true,
    preset: presetId,
    name: mutation.value!.name,
    embedModelChanged: mutation.value!.embedModelChanged,
  };
}

/**
 * Format models use result for output.
 */
export function formatModelsUse(result: ModelsUseResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }
  const lines = [`Switched to preset: ${result.preset} (${result.name})`];
  if (result.embedModelChanged) {
    lines.push("Embedding model changed. Run: gno embed");
  }
  return lines.join("\n");
}
