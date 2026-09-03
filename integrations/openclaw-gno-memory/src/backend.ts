/**
 * GNO-backed memory backend: collection provisioning, sync-before-search,
 * search, and exact reads. Holds the stale-index state the tools and CLI
 * surface. Never writes a memory file.
 */

import {
  type GnoMemoryConfig,
  normalizeRoot,
  toCollectionPattern,
} from "./config";
import { GnoCli, GnoCliError, type GnoRunner } from "./gno-cli";

export interface BackendLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface MemoryHit {
  uri: string;
  path: string;
  title?: string;
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  hash?: string;
  citation: string;
}

export interface StaleState {
  reason: string;
  kind: string;
  at: string;
}

export interface SearchOutcome {
  results: MemoryHit[];
  mode: string;
  stale: StaleState | null;
  warning?: string;
  synced: boolean;
}

export interface GetOutcome {
  uri: string;
  path: string;
  content: string;
  totalLines?: number;
  hash?: string;
}

export interface BackendStatus {
  gnoVersion: string;
  collection: string;
  root: string;
  pattern: string;
  registered: boolean;
  stale: StaleState | null;
  lastSyncAt: string | null;
}

export interface SearchOptions {
  workspaceDir?: string;
  maxResults?: number;
  minScore?: number;
}

export interface GetOptions {
  workspaceDir?: string;
  from?: number;
  lines?: number;
}

interface CollectionRecord {
  name: string;
  path: string;
}

const HASH_PREFIX_LENGTH = 12;
/**
 * With `syncBeforeSearch: false` nothing clears a stale flag on its own, so a
 * search re-probes the index (one `gno index` run) once the flag is this old.
 * A success clears it; a failure refreshes the reason and restarts the clock.
 */
export const STALE_RETRY_MS = 5 * 60_000;
const URI_COLLECTION_PREFIX = /^gno:\/\/[^/]+\//;
const LEADING_DOT_SLASH = /^\.?\//;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function lineRef(startLine?: number, endLine?: number): string {
  if (!startLine) return "";
  return endLine && endLine !== startLine
    ? `#L${startLine}-L${endLine}`
    : `#L${startLine}`;
}

export function toHit(raw: unknown): MemoryHit | null {
  const item = asRecord(raw);
  const uri = stringOr(item?.uri);
  if (!item || !uri) return null;
  const source = asRecord(item.source);
  const conversion = asRecord(item.conversion);
  const range = asRecord(item.snippetRange);
  const startLine = range
    ? numberOr(range.startLine, 0) || undefined
    : undefined;
  const endLine = range ? numberOr(range.endLine, 0) || undefined : undefined;
  const hash = stringOr(conversion?.mirrorHash) ?? stringOr(source?.sourceHash);
  const hashRef = hash ? ` (hash ${hash.slice(0, HASH_PREFIX_LENGTH)})` : "";
  return {
    uri,
    path:
      stringOr(source?.relPath) ??
      decodeURIComponent(uri.replace(URI_COLLECTION_PREFIX, "")),
    title: stringOr(item.title),
    score: numberOr(item.score, 0),
    snippet: stringOr(item.snippet) ?? "",
    startLine,
    endLine,
    hash,
    citation: `${uri}${lineRef(startLine, endLine)}${hashRef}`,
  };
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text.trim() || "null"));
  } catch {
    return null;
  }
}

function parseCollectionList(stdout: string): CollectionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "[]");
  } catch {
    throw new GnoCliError(
      "gno_malformed_json",
      "gno collection list returned malformed JSON"
    );
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(asRecord)
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => ({
      name: stringOr(c.name) ?? "",
      path: stringOr(c.path) ?? "",
    }));
}

function toGnoError(error: unknown): GnoCliError {
  return error instanceof GnoCliError
    ? error
    : new GnoCliError(
        "gno_command_failed",
        error instanceof Error ? error.message : String(error)
      );
}

export class GnoMemoryBackend {
  readonly config: GnoMemoryConfig;
  readonly cli: GnoCli;
  private readonly logger: BackendLogger;
  private readonly now: () => number;
  private stale: StaleState | null = null;
  private lastSyncAt: string | null = null;
  private registeredRoot: string | null = null;

  constructor(
    config: GnoMemoryConfig,
    logger: BackendLogger,
    runner?: GnoRunner,
    now: () => number = Date.now
  ) {
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.cli = new GnoCli({
      binary: config.gnoPath,
      timeoutMs: config.timeoutMs,
      globalArgs: config.gnoArgs,
      runner,
    });
  }

  get staleState(): StaleState | null {
    return this.stale;
  }

  /** The normalized root: config `root` (already canonical) or OpenClaw's workspaceDir. */
  resolveRoot(workspaceDir?: string): string {
    if (this.config.root) return this.config.root;
    const trimmed = workspaceDir?.trim();
    if (!trimmed) {
      throw new GnoCliError(
        "gno_command_failed",
        "no workspace root: set plugins.entries.gno-memory.config.root or run inside an OpenClaw workspace"
      );
    }
    return normalizeRoot(trimmed);
  }

  /** The registered collection, with its path in the same canonical form as `resolveRoot`. */
  private async findCollection(): Promise<CollectionRecord | undefined> {
    const existing = (await this.listCollections()).find(
      (c) => c.name === this.config.collection
    );
    return existing && existing.path !== ""
      ? { ...existing, path: normalizeRoot(existing.path) }
      : existing;
  }

  /**
   * Register the workspace memory paths as a GNO collection (idempotent).
   * A collection of the same name rooted elsewhere is an error, never a
   * silent re-point: the operator owns that config.
   */
  async ensureCollection(
    workspaceDir?: string
  ): Promise<{ root: string; created: boolean }> {
    const root = this.resolveRoot(workspaceDir);
    if (this.registeredRoot === root) return { root, created: false };
    await this.cli.ensureVersion();
    const existing = await this.findCollection();
    if (existing) {
      if (existing.path !== root) {
        throw new GnoCliError(
          "gno_command_failed",
          `collection "${this.config.collection}" is rooted at ${existing.path}, not the OpenClaw workspace ${root}; rename it or set a different collection name`
        );
      }
      this.registeredRoot = root;
      return { root, created: false };
    }
    const pattern = toCollectionPattern(this.config.paths);
    const result = await this.cli.run([
      "collection",
      "add",
      root,
      "--name",
      this.config.collection,
      "--pattern",
      pattern,
      "--exclude",
      this.config.exclude.join(","),
    ]);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new GnoCliError(
        "gno_command_failed",
        `gno collection add failed: ${detail}`
      );
    }
    this.logger.info(
      `gno-memory: registered collection "${this.config.collection}" at ${root} (${pattern})`
    );
    this.registeredRoot = root;
    return { root, created: true };
  }

  /**
   * `gno index <collection> --no-embed`: files written, renamed, or deleted
   * since the last sync reconcile here. Failure marks the index stale and is
   * logged; it never throws so a search can still serve the last good index.
   */
  async sync(workspaceDir?: string): Promise<boolean> {
    try {
      await this.ensureCollection(workspaceDir);
      const payload = await this.cli.runJson([
        "index",
        this.config.collection,
        "--no-embed",
        "--json",
        "--lock-wait",
        "10s",
      ]);
      const summary = asRecord(payload.syncResult);
      this.lastSyncAt = new Date(this.now()).toISOString();
      this.stale = null;
      this.logger.info(
        `gno-memory: index sync ok for "${this.config.collection}" (added ${numberOr(summary?.totalFilesAdded, 0)}, updated ${numberOr(summary?.totalFilesUpdated, 0)}, removed ${numberOr(summary?.totalFilesRemoved, 0)})`
      );
      return true;
    } catch (error) {
      const err = toGnoError(error);
      this.stale = {
        reason: err.message,
        kind: err.kind,
        at: new Date(this.now()).toISOString(),
      };
      this.logger.warn(
        `gno-memory: index sync failed (${err.kind}): ${err.message}; serving possibly stale results`
      );
      return false;
    }
  }

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchOutcome> {
    await this.ensureCollection(options.workspaceDir);
    const synced =
      this.config.syncBeforeSearch || this.staleDueForRetry()
        ? await this.sync(options.workspaceDir)
        : false;
    const limit = String(options.maxResults ?? this.config.maxResults);
    const args =
      this.config.mode === "hybrid"
        ? [
            "query",
            query,
            "--fast",
            "-n",
            limit,
            "-c",
            this.config.collection,
            "--json",
          ]
        : [
            "search",
            query,
            "-n",
            limit,
            "-c",
            this.config.collection,
            "--json",
          ];
    if (options.minScore !== undefined)
      args.push("--min-score", String(options.minScore));
    const payload = await this.cli.runJson(args);
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const meta = asRecord(payload.meta);
    const outcome: SearchOutcome = {
      results: rawResults
        .map(toHit)
        .filter((hit): hit is MemoryHit => hit !== null),
      mode: stringOr(meta?.mode) ?? this.config.mode,
      stale: this.stale,
      synced,
    };
    if (this.stale) {
      outcome.warning = `memory index may be stale: ${this.stale.reason}`;
    }
    return outcome;
  }

  /** In watch mode, a stale flag older than STALE_RETRY_MS is re-probed on the next search. */
  private staleDueForRetry(): boolean {
    if (!this.stale) return false;
    const flaggedAt = Date.parse(this.stale.at);
    return (
      !Number.isFinite(flaggedAt) || this.now() - flaggedAt >= STALE_RETRY_MS
    );
  }

  /** Exact excerpt via `gno get`; `ref` is a gno:// URI or a workspace-relative path. */
  async get(ref: string, options: GetOptions = {}): Promise<GetOutcome> {
    await this.ensureCollection(options.workspaceDir);
    const uri = ref.startsWith("gno://") ? ref : this.toUri(ref);
    const args = ["get", uri, "--json"];
    if (options.from !== undefined) args.push("--from", String(options.from));
    if (options.lines !== undefined)
      args.push("--limit", String(options.lines));
    const payload = await this.cli.runJson(args);
    const source = asRecord(payload.source);
    return {
      uri: stringOr(payload.uri) ?? uri,
      path: stringOr(source?.relPath) ?? ref,
      content: stringOr(payload.content) ?? "",
      totalLines:
        typeof payload.totalLines === "number" ? payload.totalLines : undefined,
      hash: stringOr(source?.sourceHash),
    };
  }

  async status(workspaceDir?: string): Promise<BackendStatus> {
    const gnoVersion = await this.cli.ensureVersion();
    const root = this.resolveRoot(workspaceDir);
    const existing = await this.findCollection();
    return {
      gnoVersion,
      collection: this.config.collection,
      root,
      pattern: toCollectionPattern(this.config.paths),
      registered: existing?.path === root,
      stale: this.stale,
      lastSyncAt: this.lastSyncAt,
    };
  }

  /** `gno collection list --json`; a non-zero exit (typically "run gno init") is a clear error. */
  private async listCollections(): Promise<CollectionRecord[]> {
    const listed = await this.cli.run(["collection", "list", "--json"]);
    if (listed.code !== 0) {
      const envelope = asRecord(parseJsonLoose(listed.stdout)?.error);
      const detail =
        stringOr(envelope?.message) ??
        stringOr(listed.stderr.trim()) ??
        `exit ${listed.code}`;
      throw new GnoCliError(
        "gno_command_failed",
        `gno collection list failed: ${detail} (is GNO initialized? run gno init)`
      );
    }
    return parseCollectionList(listed.stdout);
  }

  private toUri(relPath: string): string {
    const segments = relPath
      .replace(LEADING_DOT_SLASH, "")
      .split("/")
      .map(encodeURIComponent);
    return `gno://${this.config.collection}/${segments.join("/")}`;
  }
}
