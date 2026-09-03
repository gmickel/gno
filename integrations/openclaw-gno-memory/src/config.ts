/**
 * Plugin config (`plugins.entries.gno-memory.config`) parsing with defaults.
 * The manifest's `configSchema` rejects unknown keys before this runs; this
 * module only applies defaults and type-narrows.
 */

// node:fs realpathSync / node:os homedir / node:path resolve: this module runs
// inside OpenClaw's Node runtime, where Bun APIs are unavailable.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type SearchMode = "keyword" | "hybrid";

export interface GnoMemoryConfig {
  /** Collection name registered in GNO for the OpenClaw memory files. */
  collection: string;
  /** Normalized workspace root the collection is rooted at; falls back to OpenClaw's workspaceDir. */
  root?: string;
  /** Workspace-relative globs that make up the memory corpus. */
  paths: string[];
  /** Exclude patterns (runtime state, VCS, dependencies). */
  exclude: string[];
  /** `gno` binary (name on PATH or absolute path). */
  gnoPath: string;
  /** Extra global `gno` flags, e.g. ["--config", "/path/index.yml"]. */
  gnoArgs: string[];
  timeoutMs: number;
  /** Run `gno index <collection>` before every search (off when a daemon watches). */
  syncBeforeSearch: boolean;
  mode: SearchMode;
  maxResults: number;
}

export const DEFAULT_PATHS = [
  "MEMORY.md",
  "USER.md",
  "memory/**/*.md",
] as const;
export const DEFAULT_EXCLUDE = [
  ".git",
  "node_modules",
  ".openclaw",
  ".state",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 8;

function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value.filter(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
  return items.length > 0 ? items.map((v) => v.trim()) : [...fallback];
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Canonical form of a collection root, matching what GNO stores for
 * `collection add`: `~` expanded, absolute, no trailing slash, and the real
 * path when the directory exists. Both the configured/workspace root and the
 * path GNO reports go through here, so a `~/ws`, relative, or `ws/` root
 * compares equal to its registered form.
 */
export function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? resolve(homedir(), trimmed.slice(2))
        : resolve(trimmed);
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

function normalizeRootOrUndefined(
  root: string | undefined
): string | undefined {
  return root === undefined ? undefined : normalizeRoot(root);
}

export function resolveConfig(raw: unknown): GnoMemoryConfig {
  const cfg =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    collection:
      nonEmptyString(cfg.collection)?.toLowerCase() ?? "openclaw-memory",
    root: normalizeRootOrUndefined(nonEmptyString(cfg.root)),
    paths: stringList(cfg.paths, DEFAULT_PATHS),
    exclude: stringList(cfg.exclude, DEFAULT_EXCLUDE),
    gnoPath: nonEmptyString(cfg.gnoPath) ?? "gno",
    gnoArgs: stringList(cfg.gnoArgs, []),
    timeoutMs: positiveInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS),
    syncBeforeSearch: cfg.syncBeforeSearch !== false,
    mode: cfg.mode === "hybrid" ? "hybrid" : "keyword",
    maxResults: positiveInt(cfg.maxResults, DEFAULT_MAX_RESULTS),
  };
}

/** One brace-union glob GNO accepts as the collection `pattern`. */
export function toCollectionPattern(paths: readonly string[]): string {
  return paths.length === 1 ? paths[0]! : `{${paths.join(",")}}`;
}
