/**
 * Content type config normalization.
 *
 * @module src/config/content-types
 */

import type { NotePresetId } from "../core/note-presets";
import type { Config, ContentTypeConfig } from "./types";

import { NOTE_PRESETS } from "../core/note-presets";

export type ConfigWarningCode =
  | "UNKNOWN_CONTENT_TYPE_PRESET"
  | "DUPLICATE_CONTENT_TYPE_PREFIX";

export interface ConfigWarning {
  code: ConfigWarningCode;
  message: string;
  path: string;
}

export interface NormalizedContentTypeRule extends ContentTypeConfig {
  preset: NotePresetId;
}

export interface ContentTypeNormalizationResult {
  rules: NormalizedContentTypeRule[];
  warnings: ConfigWarning[];
}

export interface ConfigNormalizationResult {
  config: Config;
  warnings: ConfigWarning[];
}

const NOTE_PRESET_IDS = new Set<NotePresetId>(
  NOTE_PRESETS.map((preset) => preset.id)
);

function normalizeGraphHint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function isNotePresetId(value: string): value is NotePresetId {
  return NOTE_PRESET_IDS.has(value as NotePresetId);
}

export function normalizeContentTypes(
  contentTypes: ContentTypeConfig[]
): ContentTypeNormalizationResult {
  const warnings: ConfigWarning[] = [];
  const seenPrefixes = new Set<string>();
  const rules: NormalizedContentTypeRule[] = [];

  for (const [typeIndex, contentType] of contentTypes.entries()) {
    const path = `contentTypes[${typeIndex}]`;
    if (!isNotePresetId(contentType.preset)) {
      warnings.push({
        code: "UNKNOWN_CONTENT_TYPE_PRESET",
        path: `${path}.preset`,
        message: `Dropped content type "${contentType.id}" because preset "${contentType.preset}" is not a known note preset.`,
      });
      continue;
    }

    const prefixes: string[] = [];
    for (const [prefixIndex, prefix] of contentType.prefixes.entries()) {
      if (seenPrefixes.has(prefix)) {
        warnings.push({
          code: "DUPLICATE_CONTENT_TYPE_PREFIX",
          path: `${path}.prefixes[${prefixIndex}]`,
          message: `Dropped duplicate content type prefix "${prefix}" from "${contentType.id}".`,
        });
        continue;
      }

      seenPrefixes.add(prefix);
      prefixes.push(prefix);
    }

    if (prefixes.length === 0) {
      rules.push({
        ...contentType,
        preset: contentType.preset,
        prefixes,
        graphHints: contentType.graphHints
          ? contentType.graphHints.map(normalizeGraphHint).filter(Boolean)
          : undefined,
      });
      continue;
    }

    rules.push({
      ...contentType,
      preset: contentType.preset,
      prefixes: [...prefixes].sort((a, b) => b.length - a.length),
      graphHints: contentType.graphHints
        ? contentType.graphHints.map(normalizeGraphHint).filter(Boolean)
        : undefined,
    });
  }

  rules.sort((a, b) => {
    const aLongest = a.prefixes[0]?.length ?? 0;
    const bLongest = b.prefixes[0]?.length ?? 0;
    return bLongest - aLongest;
  });

  return { rules, warnings };
}

export function normalizeConfigContentTypes(
  config: Config
): ConfigNormalizationResult {
  const normalized = normalizeContentTypes(config.contentTypes ?? []);
  return {
    config: {
      ...config,
      contentTypes: normalized.rules,
    },
    warnings: normalized.warnings,
  };
}

export function fingerprintContentTypeRules(
  rules: NormalizedContentTypeRule[]
): string {
  const canonical = rules.map((rule) => ({
    id: rule.id,
    preset: rule.preset,
    prefixes: rule.prefixes,
    graphHints: rule.graphHints ?? [],
  }));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(canonical));
  return hasher.digest("hex");
}

export function formatConfigWarning(warning: ConfigWarning): string {
  return `[config] ${warning.path}: ${warning.message}`;
}

export function formatConfigWarnings(warnings?: ConfigWarning[]): string[] {
  return (warnings ?? []).map(formatConfigWarning);
}

export function writeConfigWarningsToStderr(warnings?: ConfigWarning[]): void {
  for (const warning of formatConfigWarnings(warnings)) {
    process.stderr.write(`${warning}\n`);
  }
}
