/**
 * gno models use command implementation.
 * Switch active model preset.
 *
 * @module src/cli/commands/models/use
 */

import { createDefaultConfig, loadConfig } from '../../../config';
import { saveConfig } from '../../../config/saver';
import { getPreset, listPresets } from '../../../llm/registry';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelsUseOptions = {
  /** Override config path */
  configPath?: string;
};

export type ModelsUseResult =
  | { success: true; preset: string; name: string }
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
  // Load existing config or create default
  const configResult = await loadConfig(options.configPath);
  const config = configResult.ok ? configResult.value : createDefaultConfig();

  // Check if preset exists
  const preset = getPreset(config, presetId);
  if (!preset) {
    const available = listPresets(config)
      .map((p) => p.id)
      .join(', ');
    return {
      success: false,
      error: `Unknown preset: ${presetId}. Available: ${available}`,
    };
  }

  // Update config with new active preset (don't persist presets - use code defaults)
  const updatedConfig = {
    ...config,
    models: {
      activePreset: presetId,
      // Don't persist presets - always use DEFAULT_MODEL_PRESETS from code
      // This ensures preset URI updates are picked up without config migration
      loadTimeout: config.models?.loadTimeout ?? 60_000,
      inferenceTimeout: config.models?.inferenceTimeout ?? 30_000,
      warmModelTtl: config.models?.warmModelTtl ?? 300_000,
    },
  };

  // Save updated config
  const saveResult = await saveConfig(updatedConfig, options.configPath);
  if (!saveResult.ok) {
    return {
      success: false,
      error: `Failed to save config: ${saveResult.error.message}`,
    };
  }

  return { success: true, preset: presetId, name: preset.name };
}

/**
 * Format models use result for output.
 */
export function formatModelsUse(result: ModelsUseResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }
  return `Switched to preset: ${result.preset} (${result.name})`;
}
