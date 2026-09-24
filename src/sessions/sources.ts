/**
 * Session source roots: discovery candidates, unit enumeration, structural
 * format detection and path safety.
 *
 * A source root is walked without following symlinks that leave it; the
 * archive root and GNO's own config/data/cache directories are never read
 * (no recursive ingestion). Units are exposed with a safe locator (a
 * basename-level path inside the root) so receipts never carry host paths.
 *
 * @module src/sessions/sources
 */

import { Database } from "bun:sqlite";
// node:fs/promises: readdir/lstat/realpath/stat have no Bun equivalents.
import { lstat, readdir, realpath, stat } from "node:fs/promises";
// node:os homedir: no Bun equivalent.
import { homedir } from "node:os";
// node:path: no Bun path utilities.
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { ParseUnitResult, SessionHarness } from "./types";

import {
  CLAUDE_CODE_PARSER,
  parseClaudeCodeSession,
} from "./parsers/claude-code";
import { CODEX_PARSER, parseCodexRollout } from "./parsers/codex";
import { HERMES_PARSER, parseHermesDatabase } from "./parsers/hermes";
import {
  isOpenClawDatabase,
  OPENCLAW_PARSER,
  parseOpenClawDatabase,
  parseOpenClawJsonl,
} from "./parsers/openclaw";
import { isRecord, readJsonlRecords } from "./parsers/shared";
import { emptyDiagnostics, SESSION_LIMITS, SessionsError } from "./types";

export interface SessionUnit {
  harness: SessionHarness;
  /** Canonical absolute path of the file or database. */
  path: string;
  /** Safe locator relative to the source root. */
  locator: string;
  storage: "jsonl" | "sqlite";
  size: number;
  mtimeMs: number;
}

/** True when `child` equals `parent` or lies inside it (canonical paths). */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Canonicalize an existing path; returns null when it cannot be resolved. */
export async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Default host roots checked by discovery, per harness. */
export function defaultDiscoveryRoots(
  env: NodeJS.ProcessEnv = process.env
): Array<{ harness: SessionHarness; path: string }> {
  const home = env.HOME || homedir();
  const roots: Array<{ harness: SessionHarness; path: string }> = [];
  roots.push({
    harness: "codex",
    path: join(env.CODEX_HOME || join(home, ".codex"), "sessions"),
  });
  const claudeRoots = new Set([join(home, ".claude")]);
  if (env.CLAUDE_CONFIG_DIR) claudeRoots.add(env.CLAUDE_CONFIG_DIR);
  for (const root of claudeRoots) {
    roots.push({ harness: "claude-code", path: join(root, "projects") });
  }
  roots.push({
    harness: "openclaw",
    path:
      env.OPENCLAW_STATE_DIR || join(env.OPENCLAW_HOME || home, ".openclaw"),
  });
  roots.push({
    harness: "hermes",
    path: env.HERMES_HOME || join(home, ".hermes"),
  });
  return roots;
}

interface WalkOptions {
  root: string;
  excluded: readonly string[];
  maxDepth: number;
  accept: (relPath: string, name: string) => boolean;
  limit: number;
}

async function walk(options: WalkOptions): Promise<{
  files: Array<{ path: string; relPath: string }>;
  truncated: boolean;
}> {
  const files: Array<{ path: string; relPath: string }> = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: options.root, depth: 0 },
  ];
  let truncated = false;
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(next.dir, entry.name);
      if (options.excluded.some((excluded) => isWithin(excluded, full))) {
        continue;
      }
      // Symlinks are never followed: a link could leave the root.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (next.depth < options.maxDepth) {
          queue.push({ dir: full, depth: next.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = relative(options.root, full).split(sep).join("/");
      if (!options.accept(relPath, entry.name)) continue;
      if (files.length >= options.limit) {
        truncated = true;
        return { files, truncated };
      }
      files.push({ path: full, relPath });
    }
  }
  return { files, truncated };
}

const CLAUDE_MAIN = /^[^/]+\/[^/]+\.jsonl$/;
const CLAUDE_SUBAGENT = /^[^/]+\/[^/]+\/subagents\/agent-[^/]+\.jsonl$/;
const OPENCLAW_DB = /^agents\/[^/]+\/agent\/openclaw-agent\.sqlite$/;
const OPENCLAW_JSONL = /^agents\/[^/]+\/sessions\/[^/]+\.jsonl$/;
const HERMES_DB = /^(?:state\.db|profiles\/[^/]+\/state\.db)$/;

function unitLocator(harness: SessionHarness, relPath: string): string {
  switch (harness) {
    case "codex":
      return basename(relPath);
    case "claude-code": {
      const parts = relPath.split("/");
      // Drop the encoded working-directory folder: it is a host path.
      return parts.slice(1).join("/").replace("/subagents/", "/");
    }
    case "openclaw":
      return relPath.replace(/^agents\//, "").replace("/agent/", "/");
    case "hermes":
      return relPath;
  }
}

/**
 * Enumerate the units of one source root. A root that is itself a file is a
 * single unit. Paths outside the root (via symlinks) and excluded
 * directories are skipped.
 */
export async function enumerateUnits(options: {
  harness: SessionHarness;
  root: string;
  excluded: readonly string[];
  limit?: number;
}): Promise<{ units: SessionUnit[]; truncated: boolean }> {
  const limit = options.limit ?? SESSION_LIMITS.maxUnitsPerSource;
  const info = await stat(options.root);
  if (info.isFile()) {
    return {
      units: [
        {
          harness: options.harness,
          path: options.root,
          locator: basename(options.root),
          storage: /\.(?:sqlite|db)$/i.test(options.root) ? "sqlite" : "jsonl",
          size: info.size,
          mtimeMs: info.mtimeMs,
        },
      ],
      truncated: false,
    };
  }
  const accept = (relPath: string, name: string): boolean => {
    switch (options.harness) {
      case "codex":
        return name.startsWith("rollout-") && name.endsWith(".jsonl");
      case "claude-code":
        return CLAUDE_MAIN.test(relPath) || CLAUDE_SUBAGENT.test(relPath);
      case "openclaw":
        return OPENCLAW_DB.test(relPath) || OPENCLAW_JSONL.test(relPath);
      case "hermes":
        return HERMES_DB.test(relPath);
    }
  };
  const { files, truncated } = await walk({
    root: options.root,
    excluded: options.excluded,
    maxDepth: options.harness === "codex" ? 4 : 3,
    accept,
    limit,
  });
  const units: SessionUnit[] = [];
  for (const file of files) {
    let info2;
    try {
      info2 = await lstat(file.path);
    } catch {
      continue;
    }
    units.push({
      harness: options.harness,
      path: file.path,
      locator: unitLocator(options.harness, file.relPath),
      storage: /\.(?:sqlite|db)$/.test(file.relPath) ? "sqlite" : "jsonl",
      size: info2.size,
      mtimeMs: info2.mtimeMs,
    });
  }
  return { units, truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural detection and dispatch
// ─────────────────────────────────────────────────────────────────────────────

const DETECT_RECORDS = 50;

/** Detect a unit's harness from its structure, never from substrings. */
export async function detectHarness(
  path: string
): Promise<SessionHarness | null> {
  if (/\.(?:sqlite|db)$/i.test(path)) {
    try {
      const db = new Database(path, { readonly: true });
      try {
        if (isOpenClawDatabase(db)) return "openclaw";
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
          )
          .all()
          .map((row) => row.name);
        if (tables.includes("sessions") && tables.includes("messages")) {
          return "hermes";
        }
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
    return null;
  }
  let seen = 0;
  for await (const { record } of readJsonlRecords(path, emptyDiagnostics())) {
    seen += 1;
    if (record.type === "session_meta" && isRecord(record.payload)) {
      return "codex";
    }
    if (
      record.type === "session" &&
      typeof record.id === "string" &&
      "version" in record
    ) {
      return "openclaw";
    }
    if (
      typeof record.sessionId === "string" &&
      typeof record.uuid === "string" &&
      (record.type === "user" || record.type === "assistant")
    ) {
      return "claude-code";
    }
    if (seen >= DETECT_RECORDS) break;
  }
  return null;
}

/**
 * Harness of an explicit path: a file is detected by structure; a directory
 * by the first unit each harness layout finds there, confirmed structurally.
 */
export async function detectRootHarness(
  root: string,
  excluded: readonly string[]
): Promise<SessionHarness | null> {
  const info = await stat(root);
  if (info.isFile()) return detectHarness(root);
  for (const harness of SESSION_HARNESS_ORDER) {
    const { units } = await enumerateUnits({
      harness,
      root,
      excluded,
      limit: 1,
    });
    const first = units[0];
    if (first && (await detectHarness(first.path)) === harness) return harness;
  }
  return null;
}

const SESSION_HARNESS_ORDER: readonly SessionHarness[] = [
  "codex",
  "claude-code",
  "openclaw",
  "hermes",
];

/** Current parser identity per harness; a change forces a reparse. */
export const SESSION_PARSERS: Record<SessionHarness, string> = {
  codex: CODEX_PARSER,
  "claude-code": CLAUDE_CODE_PARSER,
  openclaw: OPENCLAW_PARSER,
  hermes: HERMES_PARSER,
};

export async function parseUnit(unit: SessionUnit): Promise<ParseUnitResult> {
  switch (unit.harness) {
    case "codex":
      return parseCodexRollout(unit.path);
    case "claude-code":
      return parseClaudeCodeSession(unit.path);
    case "openclaw":
      return unit.storage === "sqlite"
        ? parseOpenClawDatabase(unit.path)
        : parseOpenClawJsonl(unit.path);
    case "hermes":
      if (unit.storage !== "sqlite") {
        throw new SessionsError(
          "SESSIONS_UNSUPPORTED_FORMAT",
          "Hermes sessions are read from state.db"
        );
      }
      return parseHermesDatabase(unit.path);
  }
}

/** Directories GNO itself owns, which a source may never include. */
export function assertSafeSourceRoot(
  root: string,
  protectedRoots: readonly string[]
): void {
  for (const protectedRoot of protectedRoots) {
    if (isWithin(protectedRoot, root)) {
      throw new SessionsError(
        "SESSIONS_UNSAFE_PATH",
        "Source path lies inside the session archive or a GNO config/data/cache directory; choose a harness session directory instead."
      );
    }
  }
}
