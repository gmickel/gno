/**
 * Shared path-rule semantics for profile validation, setup preflight, and
 * ingestion. Paths use repository-relative POSIX form at this boundary.
 *
 * @module src/core/path-rules
 */

const GLOB_META_PATTERN = /[*?[\]{}]/;
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^credentials?(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
  /\.(?:key|pem|p12|pfx)$/i,
];

export function hasLikelySecretPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function hasGlobMeta(pattern: string): boolean {
  return GLOB_META_PATTERN.test(pattern);
}

export interface CompiledCollectionExclusions {
  /** Single-component literal exclusions (no `/` and no glob metacharacters). */
  bareComponents: ReadonlySet<string>;
  /** Multi-component literal path/prefix exclusions (contain `/`, no glob metacharacters). */
  literalPrefixes: readonly string[];
  /** Glob exclusions compiled once. */
  globs: readonly Bun.Glob[];
  /** True when `"**"` excludes every subtree. */
  excludesAllSubtrees: boolean;
  /** Compiled root patterns from trailing `/**` exclusions. */
  subtreeGlobs: readonly Bun.Glob[];
}

/** Pre-compile collection exclusion patterns once per walk. */
export function compileCollectionExclusions(
  excludes: readonly string[]
): CompiledCollectionExclusions {
  const bareComponents = new Set<string>();
  const literalPrefixes: string[] = [];
  const globs: Bun.Glob[] = [];
  const subtreeGlobs: Bun.Glob[] = [];
  let excludesAllSubtrees = false;

  for (const rawPattern of excludes) {
    const pattern = rawPattern.replaceAll("\\", "/");
    if (pattern === "**") {
      excludesAllSubtrees = true;
    }
    if (pattern.endsWith("/**")) {
      const subtreeRootPattern = pattern.slice(0, -3);
      if (subtreeRootPattern.length > 0) {
        subtreeGlobs.push(new Bun.Glob(subtreeRootPattern));
      }
    }
    if (hasGlobMeta(pattern)) {
      globs.push(new Bun.Glob(pattern));
    } else if (pattern.includes("/")) {
      literalPrefixes.push(pattern);
    } else {
      bareComponents.add(pattern);
    }
  }

  return {
    bareComponents,
    literalPrefixes,
    globs,
    excludesAllSubtrees,
    subtreeGlobs,
  };
}

/** Check a POSIX-normalized relative path against pre-compiled exclusions. */
export function matchesCompiledExclusion(
  normalizedPath: string,
  compiled: CompiledCollectionExclusions
): boolean {
  if (compiled.bareComponents.size > 0) {
    let start = 0;
    while (start <= normalizedPath.length) {
      const slash = normalizedPath.indexOf("/", start);
      const part =
        slash === -1
          ? normalizedPath.slice(start)
          : normalizedPath.slice(start, slash);
      if (compiled.bareComponents.has(part)) return true;
      if (slash === -1) break;
      start = slash + 1;
    }
  }
  for (const prefix of compiled.literalPrefixes) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  for (const glob of compiled.globs) {
    if (glob.match(normalizedPath)) return true;
  }
  return false;
}

/** Check whether a POSIX-normalized directory path is a fully excluded subtree. */
export function matchesCompiledSubtreeExclusion(
  normalizedPath: string,
  compiled: CompiledCollectionExclusions
): boolean {
  if (compiled.excludesAllSubtrees) return true;
  if (matchesCompiledExclusion(normalizedPath, compiled)) return true;
  for (const glob of compiled.subtreeGlobs) {
    if (glob.match(normalizedPath)) return true;
  }
  return false;
}

/**
 * Bare values preserve historical component/prefix semantics. Values with
 * glob metacharacters match the complete normalized relative path.
 */
export function matchesCollectionExclusion(
  relPath: string,
  excludes: readonly string[]
): boolean {
  const normalizedPath = relPath.replaceAll("\\", "/");
  const parts = normalizedPath.split("/");

  for (const rawPattern of excludes) {
    const pattern = rawPattern.replaceAll("\\", "/");
    if (hasGlobMeta(pattern)) {
      if (new Bun.Glob(pattern).match(normalizedPath)) return true;
      continue;
    }
    if (
      parts.includes(pattern) ||
      normalizedPath === pattern ||
      normalizedPath.startsWith(`${pattern}/`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a known directory is the root of a fully excluded subtree.
 * A trailing `/**` excludes every descendant even though Bun.Glob does not
 * match the directory root itself. Other partial glob shapes must still be
 * traversed because they may leave eligible descendants.
 */
export function matchesCollectionSubtreeExclusion(
  relPath: string,
  excludes: readonly string[]
): boolean {
  const normalizedPath = relPath.replaceAll("\\", "/");
  if (matchesCollectionExclusion(normalizedPath, excludes)) {
    return true;
  }

  for (const rawPattern of excludes) {
    const pattern = rawPattern.replaceAll("\\", "/");
    if (pattern === "**") {
      return true;
    }
    if (!pattern.endsWith("/**")) {
      continue;
    }
    const subtreeRootPattern = pattern.slice(0, -3);
    if (
      subtreeRootPattern.length > 0 &&
      new Bun.Glob(subtreeRootPattern).match(normalizedPath)
    ) {
      return true;
    }
  }
  return false;
}
