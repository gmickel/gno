/**
 * Sync option helpers.
 *
 * @module src/ingestion/sync-options
 */

import type { Config, NormalizedContentTypeRule } from "../config";
import type { SyncOptions } from "./types";

import { fingerprintContentTypeRules, normalizeContentTypes } from "../config";

export function resolveContentTypeRules(
  config?: Pick<Config, "contentTypes">
): NormalizedContentTypeRule[] {
  return normalizeContentTypes(config?.contentTypes ?? []).rules;
}

export function withContentTypeRules(
  options: SyncOptions = {},
  config?: Pick<Config, "contentTypes">
): SyncOptions {
  const rules = options.contentTypeRules ?? resolveContentTypeRules(config);
  return {
    ...options,
    contentTypeRules: rules,
    contentTypeRulesFingerprint:
      options.contentTypeRulesFingerprint ?? fingerprintContentTypeRules(rules),
  };
}
