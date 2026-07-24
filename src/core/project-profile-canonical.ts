import type { ProjectProfileDesiredState } from "./project-profile";

import { PROJECT_PROFILE_FINGERPRINT_DOMAIN } from "../config/project-profile";

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const normalizeLogicalPath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
};

export const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodeUnits);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
};

export const canonicalProjectProfileJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const escapeOuterBraceDelimiter = (pattern: string): string => {
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = "";
  for (const character of pattern) {
    if (character === "[" && bracketDepth === 0) bracketDepth = 1;
    else if (character === "]" && bracketDepth > 0) bracketDepth = 0;
    else if (bracketDepth === 0 && character === "{") braceDepth += 1;
    else if (bracketDepth === 0 && character === "}") braceDepth -= 1;

    escaped +=
      character === "," && braceDepth === 0 && bracketDepth === 0
        ? "\\,"
        : character;
  }
  return escaped;
};

/**
 * Encode portable include globs into the config's single pattern. FileWalker
 * splits a whole-pattern union before calling Bun.Glob.scan().
 */
export const projectProfileIncludePattern = (
  include: readonly string[]
): string => {
  if (include.length === 1) return include[0] ?? "**/*";
  return `{${include.map(escapeOuterBraceDelimiter).join(",")}}`;
};

export const sha256 = (value: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const fingerprintProjectProfileState = (
  desiredState: ProjectProfileDesiredState
): string =>
  sha256(
    `${PROJECT_PROFILE_FINGERPRINT_DOMAIN}${canonicalProjectProfileJson(
      desiredState
    )}`
  );
