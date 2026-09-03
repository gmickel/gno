/**
 * Subprocess bridge to the `gno` CLI.
 *
 * Every GNO interaction goes through here: version pinning, JSON subcommands,
 * and the failure classification the plugin degrades on (binary missing,
 * timeout, malformed JSON, GNO below the pinned version, non-zero exit).
 * Nothing here writes memory files; the plugin is a read-only retrieval
 * authority and OpenClaw owns its own files.
 */

// node:child_process: this module runs inside OpenClaw's Node runtime, where
// Bun.$ / Bun.spawn do not exist. bun test can still exercise it.
import { execFile } from "node:child_process";

/** fn-130 shipped the memory contracts in GNO 1.41.0. */
export const MIN_GNO_VERSION = "1.41.0";

export type GnoErrorKind =
  | "gno_not_found"
  | "gno_version_unsupported"
  | "gno_timeout"
  | "gno_malformed_json"
  | "gno_command_failed";

export class GnoCliError extends Error {
  readonly kind: GnoErrorKind;
  readonly code: string;

  constructor(kind: GnoErrorKind, message: string, code = "") {
    super(message);
    this.name = "GnoCliError";
    this.kind = kind;
    this.code = code;
  }
}

export interface GnoRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

/** Runs `gno <args>`; tests inject a fake, production uses `execFileRunner`. */
export type GnoRunner = (
  binary: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string }
) => Promise<GnoRunResult>;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export const execFileRunner: GnoRunner = (binary, args, options) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: options.cwd,
        env: process.env,
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (NodeJS.ErrnoException & { killed?: boolean; code?: unknown })
          | null;
        // A spawn failure (EACCES, ENOTDIR, ...) carries no exit code and no
        // stderr; surface its message and a non-zero code so the reported
        // reason is actionable instead of "exit null".
        const spawnFailed =
          failure !== null &&
          typeof failure.code !== "number" &&
          !failure.killed;
        const stderrText = String(stderr ?? "");
        resolve({
          code:
            typeof failure?.code === "number"
              ? failure.code
              : spawnFailed
                ? 1
                : failure
                  ? null
                  : 0,
          stdout: String(stdout ?? ""),
          stderr: stderrText || (spawnFailed ? failure.message : ""),
          timedOut: Boolean(failure?.killed),
          notFound: failure?.code === "ENOENT",
        });
      }
    );
  });

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseVersion(raw: string): [number, number, number] | null {
  const match = VERSION_RE.exec(raw ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(
  found: string,
  minimum = MIN_GNO_VERSION
): boolean {
  const a = parseVersion(found);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface GnoCliOptions {
  binary: string;
  timeoutMs: number;
  runner?: GnoRunner;
  /** Global flags prepended to every call (`--config`, `--index`). */
  globalArgs?: readonly string[];
}

/** Thin, timeout-bounded runner for `gno` subcommands. */
export class GnoCli {
  readonly binary: string;
  readonly timeoutMs: number;
  private readonly runner: GnoRunner;
  private readonly globalArgs: readonly string[];
  private versionChecked: string | null = null;

  constructor(options: GnoCliOptions) {
    this.binary = options.binary;
    this.timeoutMs = options.timeoutMs;
    this.runner = options.runner ?? execFileRunner;
    this.globalArgs = options.globalArgs ?? [];
  }

  async run(args: readonly string[]): Promise<GnoRunResult> {
    const result = await this.runner(
      this.binary,
      [...this.globalArgs, ...args],
      {
        timeoutMs: this.timeoutMs,
      }
    );
    if (result.notFound) {
      throw new GnoCliError(
        "gno_not_found",
        `gno binary not found (${this.binary}); install GNO (npm install -g @gmickel/gno) or set gnoPath in the plugin config`
      );
    }
    if (result.timedOut) {
      throw new GnoCliError(
        "gno_timeout",
        `gno ${args[0] ?? ""} timed out after ${this.timeoutMs}ms`
      );
    }
    return result;
  }

  /**
   * Run a `--json` subcommand and return the parsed object. Non-zero exits
   * carry GNO's `{"error": {code, message}}` envelope on stdout; that becomes
   * `gno_command_failed` with the CLI code attached. Unparseable stdout on
   * either exit status is `gno_malformed_json`.
   */
  async runJson(args: readonly string[]): Promise<Record<string, unknown>> {
    const result = await this.run(args);
    const payload = parseJsonObject(result.stdout);
    if (result.code !== 0) {
      const envelope = payload?.error;
      if (envelope && typeof envelope === "object") {
        const err = envelope as Record<string, unknown>;
        throw new GnoCliError(
          "gno_command_failed",
          `gno ${args[0]} failed: ${text(err.message, "unknown error")}`,
          text(err.code)
        );
      }
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      throw new GnoCliError(
        "gno_command_failed",
        `gno ${args[0]} failed: ${detail}`
      );
    }
    if (!payload) {
      throw new GnoCliError(
        "gno_malformed_json",
        `gno ${args[0]} returned no JSON object on stdout`
      );
    }
    return payload;
  }

  /** `gno --version`, checked once per process against MIN_GNO_VERSION. */
  async ensureVersion(): Promise<string> {
    if (this.versionChecked) return this.versionChecked;
    const result = await this.run(["--version"]);
    const found = result.stdout.trim() || result.stderr.trim();
    if (result.code !== 0 || !parseVersion(found)) {
      throw new GnoCliError(
        "gno_command_failed",
        `gno --version failed: ${found || `exit ${result.code}`}`
      );
    }
    if (!versionAtLeast(found)) {
      throw new GnoCliError(
        "gno_version_unsupported",
        `gno ${found} is below the required ${MIN_GNO_VERSION}; upgrade with npm install -g @gmickel/gno@latest`
      );
    }
    this.versionChecked = found;
    return found;
  }
}
