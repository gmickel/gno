/**
 * Sync option helpers.
 *
 * @module src/ingestion/sync-options
 */

import type { Config, NormalizedContentTypeRule } from "../config";
import type { SyncOptions } from "./types";

import {
  fingerprintContentTypeMetadataRules,
  normalizeContentTypes,
} from "../config";

export function resolveContentTypeRules(
  config?: Pick<Config, "contentTypes">
): NormalizedContentTypeRule[] {
  return normalizeContentTypes(config?.contentTypes ?? []).rules;
}

export function withContentTypeRules(
  options: SyncOptions = {},
  config?: Pick<Config, "contentTypes" | "chunking" | "conversion">
): SyncOptions {
  const rules = options.contentTypeRules ?? resolveContentTypeRules(config);
  const chunking = options.chunking ?? config?.chunking;
  const conversion = config?.conversion;
  // Explicit per-call limits win over the configured conversion budget.
  const limits = conversion
    ? { ...conversion, ...options.limits }
    : options.limits;
  return {
    ...options,
    ...(chunking ? { chunking } : {}),
    ...(limits ? { limits } : {}),
    contentTypeRules: rules,
    contentTypeRulesFingerprint:
      options.contentTypeRulesFingerprint ??
      fingerprintContentTypeMetadataRules(rules),
  };
}
