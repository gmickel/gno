/**
 * Config loading and validation.
 * Loads YAML config and validates against Zod schema.
 *
 * @module src/config/loader
 */

import type { ZodError } from "zod";

import {
  validateWorkspaceRootSetting,
  workspaceRootSettingMessage,
} from "../core/link-workspace";
import {
  normalizeConfigContentTypes,
  type ConfigWarning,
} from "./content-types";
import { configExists, expandPath, getConfigPaths } from "./paths";
import { CONFIG_VERSION, type Config, ConfigSchema } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────────────────

export type LoadResult<T> =
  | { ok: true; value: T; warnings: ConfigWarning[] }
  | { ok: false; error: LoadError };

export type LoadError =
  | { code: "NOT_FOUND"; message: string; path: string }
  | { code: "PARSE_ERROR"; message: string; details: string }
  | { code: "VALIDATION_ERROR"; message: string; issues: ZodError["issues"] }
  | {
      code: "VERSION_MISMATCH";
      message: string;
      found: string;
      expected: string;
    }
  | { code: "IO_ERROR"; message: string; cause: Error };

// ─────────────────────────────────────────────────────────────────────────────
// Loading Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load config from default location or specified path.
 * Priority: configPath arg > GNO_CONFIG_DIR env > platform default
 */
export function loadConfig(configPath?: string): Promise<LoadResult<Config>> {
  const paths = getConfigPaths();
  const targetPath = configPath ? expandPath(configPath) : paths.configFile;

  return loadConfigFromPath(targetPath);
}

/**
 * Load config from a specific file path.
 */
export async function loadConfigFromPath(
  filePath: string
): Promise<LoadResult<Config>> {
  // Check file exists
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Config file not found: ${filePath}`,
        path: filePath,
      },
    };
  }

  // Read file contents
  let content: string;
  try {
    content = await file.text();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "IO_ERROR",
        message: `Failed to read config file: ${filePath}`,
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(content);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "PARSE_ERROR",
        message: "Invalid YAML syntax",
        details: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }

  // Check version before full validation
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version !== CONFIG_VERSION
  ) {
    return {
      ok: false,
      error: {
        code: "VERSION_MISMATCH",
        message: `Config version mismatch. Found "${String(parsed.version)}", expected "${CONFIG_VERSION}"`,
        found: String(parsed.version),
        expected: CONFIG_VERSION,
      },
    };
  }

  // Validate against schema
  const result = ConfigSchema.safeParse(parsed);

  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Config validation failed",
        issues: result.error.issues,
      },
    };
  }

  const workspaceIssues = validateCollectionWorkspaceRoots(result.data);
  if (workspaceIssues.length > 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `Config validation failed: ${workspaceIssues.map((issue) => issue.message).join("; ")}`,
        issues: workspaceIssues,
      },
    };
  }

  const normalized = normalizeConfigContentTypes(result.data);
  return {
    ok: true,
    value: normalized.config,
    warnings: normalized.warnings,
  };
}

/**
 * Validate explicit `workspaceRoot` settings against the filesystem: each must
 * be absolute, exist, and contain its collection root. Messages name the
 * collection so the error is actionable.
 */
export function validateCollectionWorkspaceRoots(
  config: Config
): ZodError["issues"] {
  const issues: ZodError["issues"] = [];
  for (const [index, collection] of config.collections.entries()) {
    if (typeof collection.workspaceRoot !== "string") continue;
    const error = validateWorkspaceRootSetting(
      collection.path,
      collection.workspaceRoot
    );
    if (error) {
      issues.push({
        code: "custom",
        message: workspaceRootSettingMessage(collection.name, error),
        path: ["collections", index, "workspaceRoot"],
        input: collection.workspaceRoot,
      });
    }
  }
  return issues;
}

/**
 * Load config, returning null if not found (convenience wrapper).
 * Throws on parse/validation errors.
 */
export async function loadConfigOrNull(
  configPath?: string
): Promise<Config | null> {
  const result = await loadConfig(configPath);

  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      return null;
    }
    throw new Error(result.error.message);
  }

  return result.value;
}

/**
 * Check if GNO is initialized (config exists).
 */
export function isInitialized(configPath?: string): Promise<boolean> {
  if (configPath) {
    const file = Bun.file(expandPath(configPath));
    return file.exists();
  }
  return configExists();
}
