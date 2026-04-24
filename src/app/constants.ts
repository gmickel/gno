/**
 * Central constants for GNO - all user-visible identifiers.
 * Renaming GNO is a single-module change by modifying values here.
 *
 * @module src/app/constants
 */

import { homedir, platform } from "node:os";
import { basename, join } from "node:path";

// Bun supports JSON imports natively - version single source of truth
import pkg from "../../package.json";

// ─────────────────────────────────────────────────────────────────────────────
// Brand / Product Identity
// ─────────────────────────────────────────────────────────────────────────────

/** Product name (display) */
export const PRODUCT_NAME = "GNO";

/** CLI binary name */
export const CLI_NAME = "gno";

/** Version from package.json (single source of truth) */
export const VERSION = pkg.version;

/** Virtual URI scheme for document references */
export const URI_SCHEME = "gno";

/** Full URI prefix including :// */
export const URI_PREFIX = `${URI_SCHEME}://`;

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server Identity
// ─────────────────────────────────────────────────────────────────────────────

/** MCP server name */
export const MCP_SERVER_NAME = "gno";

/** MCP tool namespace prefix (tools are gno.search, gno.query, etc.) */
export const MCP_TOOL_PREFIX = "gno";

// ─────────────────────────────────────────────────────────────────────────────
// Documentation & Support
// ─────────────────────────────────────────────────────────────────────────────

/** Documentation URL */
export const DOCS_URL = "https://github.com/gmickel/gno#readme";

/** Issue tracker URL */
export const ISSUES_URL = "https://github.com/gmickel/gno/issues";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variable Names (for directory overrides)
// ─────────────────────────────────────────────────────────────────────────────

/** Env var to override config directory */
export const ENV_CONFIG_DIR = "GNO_CONFIG_DIR";

/** Env var to override data directory */
export const ENV_DATA_DIR = "GNO_DATA_DIR";

/** Env var to override cache directory */
export const ENV_CACHE_DIR = "GNO_CACHE_DIR";

// ─────────────────────────────────────────────────────────────────────────────
// Directory Names
// ─────────────────────────────────────────────────────────────────────────────

/** Directory name used within platform-specific locations */
export const DIR_NAME = "gno";

// ─────────────────────────────────────────────────────────────────────────────
// Index Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default index name when not specified via --index */
export const DEFAULT_INDEX_NAME = "default";

/** Config filename */
export const CONFIG_FILENAME = "index.yml";

// ─────────────────────────────────────────────────────────────────────────────
// Platform Detection
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = "darwin" | "win32" | "linux";

/**
 * Get current platform, normalized to supported types.
 * Treats all non-darwin/win32 as linux (XDG).
 */
export function getPlatform(): Platform {
  const p = platform();
  if (p === "darwin") {
    return "darwin";
  }
  if (p === "win32") {
    return "win32";
  }
  return "linux";
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Platform-specific default directories.
 * These are the fallback locations when env vars are not set.
 *
 * Linux (XDG):
 *   Config: ${XDG_CONFIG_HOME:-~/.config}/gno/
 *   Data:   ${XDG_DATA_HOME:-~/.local/share}/gno/
 *   Cache:  ${XDG_CACHE_HOME:-~/.cache}/gno/
 *
 * macOS:
 *   Config: ~/Library/Application Support/gno/config/
 *   Data:   ~/Library/Application Support/gno/data/
 *   Cache:  ~/Library/Caches/gno/
 *
 * Windows:
 *   Config: %APPDATA%\gno\config\
 *   Data:   %LOCALAPPDATA%\gno\data\
 *   Cache:  %LOCALAPPDATA%\gno\cache\
 */

interface PlatformPaths {
  config: string;
  data: string;
  cache: string;
}

function getLinuxPaths(): PlatformPaths {
  const home = homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const xdgCache = process.env.XDG_CACHE_HOME ?? join(home, ".cache");

  return {
    config: join(xdgConfig, DIR_NAME),
    data: join(xdgData, DIR_NAME),
    cache: join(xdgCache, DIR_NAME),
  };
}

function getDarwinPaths(): PlatformPaths {
  const home = homedir();
  const appSupport = join(home, "Library", "Application Support", DIR_NAME);

  return {
    config: join(appSupport, "config"),
    data: join(appSupport, "data"),
    cache: join(home, "Library", "Caches", DIR_NAME),
  };
}

function getWin32Paths(): PlatformPaths {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const localAppData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return {
    config: join(appData, DIR_NAME, "config"),
    data: join(localAppData, DIR_NAME, "data"),
    cache: join(localAppData, DIR_NAME, "cache"),
  };
}

/**
 * Get platform-specific default paths (before env overrides).
 */
export function getPlatformPaths(p: Platform = getPlatform()): PlatformPaths {
  switch (p) {
    case "darwin":
      return getDarwinPaths();
    case "win32":
      return getWin32Paths();
    default:
      return getLinuxPaths();
  }
}

/**
 * Resolved directories with env var overrides applied.
 * Resolution precedence (per PRD §2.3):
 * 1. Environment overrides (GNO_CONFIG_DIR, GNO_DATA_DIR, GNO_CACHE_DIR)
 * 2. Platform defaults
 */
export interface ResolvedDirs {
  config: string;
  data: string;
  cache: string;
}

/**
 * Resolve directories applying env overrides.
 */
export function resolveDirs(p: Platform = getPlatform()): ResolvedDirs {
  const defaults = getPlatformPaths(p);

  return {
    config: process.env[ENV_CONFIG_DIR] ?? defaults.config,
    data: process.env[ENV_DATA_DIR] ?? defaults.data,
    cache: process.env[ENV_CACHE_DIR] ?? defaults.cache,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get path to index database file.
 * Format: <dataDir>/index-<indexName>.sqlite
 */
export function getIndexDbPath(
  indexName: string = DEFAULT_INDEX_NAME,
  dirs: ResolvedDirs = resolveDirs()
): string {
  return join(dirs.data, `index-${indexName}.sqlite`);
}

/**
 * Get path to config file.
 */
export function getConfigPath(dirs: ResolvedDirs = resolveDirs()): string {
  return join(dirs.config, CONFIG_FILENAME);
}

/**
 * Get path to models cache directory.
 */
export function getModelsCachePath(dirs: ResolvedDirs = resolveDirs()): string {
  return basename(dirs.cache) === "models"
    ? dirs.cache
    : join(dirs.cache, "models");
}

// ─────────────────────────────────────────────────────────────────────────────
// URI Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a gno:// URI from collection and relative path.
 */
export interface BuildUriOptions {
  indexName?: string;
}

export interface ParsedGnoUri {
  collection: string;
  path: string;
  indexName?: string;
}

export function buildUri(
  collection: string,
  relativePath: string,
  options: BuildUriOptions = {}
): string {
  // URL-encode special chars in path segments but preserve slashes
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const uri = `${URI_PREFIX}${collection}/${encodedPath}`;
  const indexName = options.indexName?.trim();
  if (!indexName || indexName === DEFAULT_INDEX_NAME) {
    return uri;
  }
  return `${uri}?index=${encodeURIComponent(indexName)}`;
}

/**
 * Parse a gno:// URI into collection and path components.
 * Returns null if not a valid gno:// URI or if decoding fails.
 */
export function parseUri(uri: string): ParsedGnoUri | null {
  if (!uri.startsWith(URI_PREFIX)) {
    return null;
  }

  const rest = uri.slice(URI_PREFIX.length);
  const slashIndex = rest.indexOf("/");

  if (slashIndex === -1) {
    // gno://collection (no path)
    const [collectionWithQuery, query = ""] = rest.split("?", 2);
    const indexName = new URLSearchParams(query).get("index")?.trim();
    return indexName
      ? {
          collection: collectionWithQuery ?? rest,
          path: "",
          indexName,
        }
      : { collection: collectionWithQuery ?? rest, path: "" };
  }

  const collection = rest.slice(0, slashIndex);
  const pathAndQuery = rest.slice(slashIndex + 1);
  const queryIndex = pathAndQuery.indexOf("?");
  const encodedPath =
    queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : pathAndQuery.slice(queryIndex + 1);

  // decodeURIComponent throws on malformed percent-encoding
  try {
    const path = decodeURIComponent(encodedPath);
    const indexName = new URLSearchParams(query).get("index")?.trim();
    return indexName ? { collection, path, indexName } : { collection, path };
  } catch {
    return null;
  }
}

/**
 * Add output-only index metadata to a canonical gno:// URI.
 */
export function decorateUriForIndex(uri: string, indexName?: string): string {
  const parsed = parseUri(uri);
  const normalizedIndex = indexName?.trim();
  if (!parsed || !normalizedIndex || normalizedIndex === DEFAULT_INDEX_NAME) {
    return stripUriIndex(uri);
  }
  return buildUri(parsed.collection, parsed.path, {
    indexName: normalizedIndex,
  });
}

/**
 * Remove output-only index metadata from a gno:// URI.
 */
export function stripUriIndex(uri: string): string {
  const parsed = parseUri(uri);
  if (!parsed) {
    return uri;
  }
  return buildUri(parsed.collection, parsed.path);
}

// ─────────────────────────────────────────────────────────────────────────────
// docid Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** docid prefix */
export const DOCID_PREFIX = "#";

/** docid hex length (8 chars = 32 bits, ~4B unique values) */
export const DOCID_LENGTH = 8;

/** Regex for validating hex characters in docid */
const DOCID_HEX_REGEX = /^[0-9a-f]+$/i;

/**
 * Derive a docid from a source hash.
 * Format: #<8 hex chars>
 */
export function deriveDocid(sourceHash: string): string {
  return `${DOCID_PREFIX}${sourceHash.slice(0, DOCID_LENGTH)}`;
}

/**
 * Check if a string is a valid docid format.
 */
export function isDocid(s: string): boolean {
  if (!s.startsWith(DOCID_PREFIX)) {
    return false;
  }
  const hex = s.slice(1);
  return hex.length >= 6 && hex.length <= 8 && DOCID_HEX_REGEX.test(hex);
}
