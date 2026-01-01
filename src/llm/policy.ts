/**
 * Download policy resolution.
 * Determines whether model downloads are allowed based on env/flags.
 *
 * @module src/llm/policy
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DownloadPolicy {
  /** True if network is disabled (no HF API calls at all) */
  offline: boolean;
  /** True if auto-download is allowed (may still be blocked by offline) */
  allowDownload: boolean;
}

export interface PolicyFlags {
  /** --offline CLI flag */
  offline?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if env var is set (non-empty and truthy).
 * Treats "1", "true", "yes" as truthy. Empty string or "0" as falsy.
 */
export function envIsSet(
  env: Record<string, string | undefined>,
  key: string
): boolean {
  const val = env[key];
  if (val === undefined || val === '') {
    return false;
  }
  const lower = val.toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve download policy from environment and CLI flags.
 *
 * Precedence (first wins):
 * 1. --offline flag → offline=true, allowDownload=false
 * 2. HF_HUB_OFFLINE=1 → offline=true, allowDownload=false
 * 3. GNO_OFFLINE=1 → offline=true, allowDownload=false
 * 4. GNO_NO_AUTO_DOWNLOAD=1 → offline=false, allowDownload=false
 * 5. Default → offline=false, allowDownload=true
 */
export function resolveDownloadPolicy(
  env: Record<string, string | undefined>,
  flags: PolicyFlags
): DownloadPolicy {
  // 1. --offline flag takes highest precedence
  if (flags.offline) {
    return { offline: true, allowDownload: false };
  }

  // 2. HF_HUB_OFFLINE env var (standard HuggingFace offline mode)
  if (envIsSet(env, 'HF_HUB_OFFLINE')) {
    return { offline: true, allowDownload: false };
  }

  // 3. GNO_OFFLINE env var (GNO-specific offline mode)
  if (envIsSet(env, 'GNO_OFFLINE')) {
    return { offline: true, allowDownload: false };
  }

  // 4. GNO_NO_AUTO_DOWNLOAD env var (allow resolve but no download)
  if (envIsSet(env, 'GNO_NO_AUTO_DOWNLOAD')) {
    return { offline: false, allowDownload: false };
  }

  // 5. Default: allow downloads
  return { offline: false, allowDownload: true };
}
