/**
 * Directory-boundary availability classification for local-mode traversal.
 * Amortized per directory (never a naive per-file availability syscall).
 *
 * @module src/ingestion/source-availability/directory
 */

// node:path — Bun has no path join/dirname helpers
import { dirname, join, relative, sep } from "node:path";

import {
  type DarwinIoPolicyPort,
  type DarwinStatPort,
  loadDarwinIo,
  SF_DATALESS,
  withNoMaterializePolicy,
} from "./darwin-io";
import {
  classifyDarwinFileProviderPath,
  type DarwinFileProviderPathSupport,
} from "./darwin-path";
import {
  type DirectoryAvailabilityPort,
  type DirectoryAvailabilityResult,
  type DirectoryReadResult,
  type SourceAvailabilityCode,
  type SourceAvailabilityMode,
  type SynchronousDirectoryRead,
  isUnprovenAbsenceCode,
  sourceAvailabilityMessage,
} from "./types";

/** Injectable deps for unit tests; production uses loadDarwinIo(). */
export type LocalDirectoryDeps = {
  platform?: string;
  policy?: DarwinIoPolicyPort | null;
  stat?: DarwinStatPort | null;
  pathSupport?: (absPath: string) => DarwinFileProviderPathSupport;
};

/** `any` mode: directories are always considered available for descent. */
export class AnyDirectoryAvailability implements DirectoryAvailabilityPort {
  readonly mode: SourceAvailabilityMode = "any";

  async classify(_absPath: string): Promise<DirectoryAvailabilityResult> {
    return { kind: "available" };
  }

  readDirectory<T>(
    _absPath: string,
    read: SynchronousDirectoryRead<T>
  ): DirectoryReadResult<T> {
    return { kind: "available", value: read() };
  }
}

/**
 * Local mode: classify directories via SF_DATALESS under no-materialization
 * policy before descent. Fail closed when support/policy cannot be proven.
 */
export class LocalDirectoryAvailability implements DirectoryAvailabilityPort {
  readonly mode: SourceAvailabilityMode = "local";
  private readonly platform: string;
  private readonly policy: DarwinIoPolicyPort | null;
  private readonly stat: DarwinStatPort | null;
  private readonly pathSupport: (
    absPath: string
  ) => DarwinFileProviderPathSupport;

  constructor(deps: LocalDirectoryDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    if (deps.policy !== undefined || deps.stat !== undefined) {
      this.policy = deps.policy ?? null;
      this.stat = deps.stat ?? null;
    } else if (this.platform === "darwin") {
      const loaded = loadDarwinIo();
      this.policy = loaded?.policy ?? null;
      this.stat = loaded?.stat ?? null;
    } else {
      this.policy = null;
      this.stat = null;
    }
    this.pathSupport = deps.pathSupport ?? classifyDarwinFileProviderPath;
  }

  async classify(absPath: string): Promise<DirectoryAvailabilityResult> {
    const supportError = this.validateSupport(absPath);
    if (supportError) {
      return supportError;
    }

    const policy = this.policy as DarwinIoPolicyPort;
    const stat = this.stat as DarwinStatPort;
    let wrapped: ReturnType<
      typeof withNoMaterializePolicy<DirectoryAvailabilityResult>
    >;
    try {
      wrapped = withNoMaterializePolicy(
        () => classifyFlags(absPath, stat),
        policy
      );
    } catch (error) {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNKNOWN",
          error instanceof Error ? error.message : "directory_classify_failed"
        ),
      };
    }
    if (!wrapped.ok) {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_POLICY_FAILED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_POLICY_FAILED",
          wrapped.error
        ),
      };
    }
    return wrapped.value;
  }

  readDirectory<T>(
    absPath: string,
    read: SynchronousDirectoryRead<T>
  ): DirectoryReadResult<T> {
    const supportError = this.validateSupport(absPath);
    if (supportError) {
      return supportError;
    }

    const policy = this.policy as DarwinIoPolicyPort;
    const stat = this.stat as DarwinStatPort;
    try {
      const wrapped = withNoMaterializePolicy(() => {
        const classified = classifyFlags(absPath, stat);
        if (classified.kind !== "available") {
          return classified;
        }
        return { kind: "available" as const, value: read() };
      }, policy);
      if (wrapped.ok) {
        return wrapped.value;
      }
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_POLICY_FAILED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_POLICY_FAILED",
          wrapped.error
        ),
      };
    } catch (error) {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNKNOWN",
          error instanceof Error ? error.message : "directory_read_failed"
        ),
      };
    }
  }

  private validateSupport(
    absPath: string
  ): Exclude<DirectoryAvailabilityResult, { kind: "available" }> | null {
    if (this.platform !== "darwin") {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_UNSUPPORTED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNSUPPORTED",
          `platform=${this.platform}`
        ),
      };
    }
    if (!this.policy || !this.stat) {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_POLICY_FAILED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_POLICY_FAILED",
          "darwin_io_unavailable"
        ),
      };
    }
    const pathSupport = this.pathSupport(absPath);
    if (pathSupport === "unsupported") {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_UNSUPPORTED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNSUPPORTED",
          "path is outside the physically evidenced macOS File Provider layouts"
        ),
      };
    }
    if (pathSupport === "unknown") {
      return {
        kind: "error",
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNKNOWN",
          "path support could not be established"
        ),
      };
    }
    return null;
  }
}

function classifyFlags(
  absPath: string,
  stat: DarwinStatPort
): DirectoryAvailabilityResult {
  const flags = stat.lstatFlags(absPath);
  if (!flags.ok) {
    const errno = flags.errno;
    if (errno === 13 || errno === 1) {
      return {
        kind: "error",
        code: "PERMISSION",
        message: sourceAvailabilityMessage("PERMISSION", `errno=${errno}`),
        errno,
      };
    }
    if (errno === 2) {
      return {
        kind: "error",
        code: "NOT_FOUND",
        message: sourceAvailabilityMessage("NOT_FOUND", `errno=${errno}`),
        errno,
      };
    }
    return {
      kind: "error",
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      message: sourceAvailabilityMessage(
        "SOURCE_AVAILABILITY_UNKNOWN",
        `lstat_failed errno=${errno}`
      ),
      errno,
    };
  }
  if ((flags.stFlags & SF_DATALESS) !== 0) {
    return {
      kind: "dataless",
      code: "DATALESS_DIRECTORY",
      message: sourceAvailabilityMessage(
        "DATALESS_DIRECTORY",
        `st_flags=${flags.stFlags}`
      ),
    };
  }
  return { kind: "available" };
}

export function createDirectoryAvailability(
  mode: SourceAvailabilityMode,
  deps: LocalDirectoryDeps = {}
): DirectoryAvailabilityPort {
  if (mode === "any") {
    return new AnyDirectoryAvailability();
  }
  return new LocalDirectoryAvailability(deps);
}

/** Cache one operation's directory classifications by absolute path. */
export function memoizeDirectoryAvailability(
  port: DirectoryAvailabilityPort
): DirectoryAvailabilityPort {
  if (port.mode === "any") {
    return port;
  }
  const cache = new Map<string, Promise<DirectoryAvailabilityResult>>();
  return {
    mode: port.mode,
    classify: (absPath: string) => {
      const cached = cache.get(absPath);
      if (cached) {
        return cached;
      }
      const pending = port.classify(absPath);
      cache.set(absPath, pending);
      return pending;
    },
    readDirectory: (absPath, read) => port.readDirectory(absPath, read),
  };
}

/** True when a directory classification must refuse descent and preserve index. */
export function isUnprovenDirectoryResult(
  result: DirectoryAvailabilityResult
): result is Exclude<DirectoryAvailabilityResult, { kind: "available" }> {
  if (result.kind === "dataless") {
    return true;
  }
  if (result.kind === "error") {
    return isUnprovenAbsenceCode(result.code);
  }
  return false;
}

export function directoryResultCode(
  result: Exclude<DirectoryAvailabilityResult, { kind: "available" }>
): SourceAvailabilityCode {
  return result.code;
}

/**
 * Walk ancestors from collection root to the parent of `relPath`, classifying
 * each directory once. Returns the first unproven prefix, if any.
 */
export async function findUnprovenAvailabilityPrefix(
  rootAbs: string,
  relPath: string,
  classifier: DirectoryAvailabilityPort
): Promise<{
  absPath: string;
  relPath: string;
  code: SourceAvailabilityCode;
  message: string;
} | null> {
  if (classifier.mode === "any") {
    return null;
  }

  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments =
    normalized.length === 0
      ? []
      : normalized.split("/").filter((segment) => segment.length > 0);

  // Include root and each intermediate directory; exclude the leaf file name.
  const dirRels: string[] = [""];
  for (let index = 0; index < Math.max(0, segments.length - 1); index += 1) {
    const next = segments.slice(0, index + 1).join("/");
    dirRels.push(next);
  }

  for (const dirRel of dirRels) {
    const absPath = dirRel === "" ? rootAbs : join(rootAbs, dirRel);
    const classified = await classifier.classify(absPath);
    if (classified.kind === "available") {
      continue;
    }
    return {
      absPath,
      relPath: dirRel,
      code: directoryResultCode(classified),
      message: classified.message,
    };
  }
  return null;
}

/** True when `relPath` is exactly `prefix` or a descendant of it. */
export function relPathUnderPrefix(relPath: string, prefix: string): boolean {
  const path = relPath.replaceAll("\\", "/");
  const base = prefix.replaceAll("\\", "/");
  if (base === "") {
    return true;
  }
  return path === base || path.startsWith(`${base}/`);
}

export function relPathUnderAnyPrefix(
  relPath: string,
  prefixes: readonly string[]
): boolean {
  for (const prefix of prefixes) {
    if (relPathUnderPrefix(relPath, prefix)) {
      return true;
    }
  }
  return false;
}

/** Parent collection-relative directory of a file path (`""` for root files). */
export function parentRelDir(relPath: string): string {
  const normalized = relPath.replaceAll("\\", "/");
  const parent = dirname(normalized);
  if (parent === "." || parent === sep) {
    return "";
  }
  return parent === "\\" ? "" : parent.replaceAll("\\", "/");
}

/** Relative path of `absPath` under `rootAbs`, or null when outside. */
export function posixRelUnderRoot(
  rootAbs: string,
  absPath: string
): string | null {
  const rel = relative(rootAbs, absPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/")) {
    return null;
  }
  return rel.split(sep).join("/");
}
