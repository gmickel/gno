/** Shared index-name contract for filesystem paths and connector trust checks. */

export const MAX_INDEX_NAME_LENGTH = 64;

const SAFE_INDEX_NAME_REGEX = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]*$/u;
const INDEX_DB_PREFIX = "index-";
const INDEX_DB_SUFFIX = ".sqlite";
const MAX_PORTABLE_FILENAME_COMPONENT_LENGTH = 255;
const MAX_INDEX_IDENTITY_STORAGE_LENGTH =
  MAX_PORTABLE_FILENAME_COMPONENT_LENGTH -
  INDEX_DB_PREFIX.length -
  INDEX_DB_SUFFIX.length;
const UTF8_ENCODER = new TextEncoder();

export const INDEX_NAME_REQUIREMENTS =
  "use 1-64 letters, marks, numbers, internal spaces, '.', '_' or '-', start with a letter or number, do not end with a space or '.', do not include '..', and fit the portable database filename limit";

function hasSafeIndexNameSyntax(value: string): boolean {
  return (
    SAFE_INDEX_NAME_REGEX.test(value) &&
    !/[ .]$/.test(value) &&
    !value.includes("..")
  );
}

function canonicalizeIndexNameUnchecked(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFC");
}

function fitsIndexIdentityStorage(value: string): boolean {
  return (
    value.length <= MAX_INDEX_IDENTITY_STORAGE_LENGTH &&
    UTF8_ENCODER.encode(value).byteLength <= MAX_INDEX_IDENTITY_STORAGE_LENGTH
  );
}

/** Return whether a value is a canonical, filesystem-safe GNO index name. */
export function isValidIndexName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_INDEX_NAME_LENGTH ||
    !hasSafeIndexNameSyntax(value)
  ) {
    return false;
  }
  return fitsIndexIdentityStorage(canonicalizeIndexNameUnchecked(value));
}

/** Fail closed before an index name can influence a database path. */
export function assertValidIndexName(value: unknown): asserts value is string {
  if (!isValidIndexName(value)) {
    throw new TypeError(`Invalid index name: ${INDEX_NAME_REQUIREMENTS}.`);
  }
}

/**
 * Return the cross-platform logical identity for an index name.
 *
 * APFS and Windows filesystems collapse canonical Unicode and case variants,
 * while common Linux filesystems do not. GNO applies one identity everywhere
 * so URI routing and database selection cannot disagree by platform.
 */
export function canonicalizeIndexName(value: string): string {
  assertValidIndexName(value);
  // The lower/upper/lower closure covers multi-character folds (ß/SS),
  // compatibility case pairs (ſ/S), and positional forms (ς/Σ) that a plain
  // lowercase pass misses but case-insensitive APFS aliases on disk.
  return canonicalizeIndexNameUnchecked(value);
}

/** Compare two validated names using GNO's cross-platform identity rules. */
export function indexNamesMatch(left: string, right: string): boolean {
  return canonicalizeIndexName(left) === canonicalizeIndexName(right);
}

function indexNameFromDbFilename(filename: string): string | null {
  if (
    !filename.startsWith(INDEX_DB_PREFIX) ||
    !filename.endsWith(INDEX_DB_SUFFIX)
  ) {
    return null;
  }
  const name = filename.slice(INDEX_DB_PREFIX.length, -INDEX_DB_SUFFIX.length);
  const isCanonicalStoredIdentity =
    hasSafeIndexNameSyntax(name) &&
    fitsIndexIdentityStorage(name) &&
    canonicalizeIndexNameUnchecked(name) === name;
  return isValidIndexName(name) || isCanonicalStoredIdentity ? name : null;
}

/**
 * Select one database filename for a logical index identity.
 *
 * New indexes use the canonical filename. A single existing mixed-case or
 * pre-normalized filename remains addressable for backward compatibility.
 * Multiple legacy files with the same identity are unsafe on case-sensitive
 * filesystems and fail closed instead of selecting one by directory order.
 */
export function resolveIndexDbFilename(
  indexName: string,
  existingFilenames: Iterable<string> = []
): string {
  const identity = canonicalizeIndexName(indexName);
  const matches: string[] = [];
  for (const filename of existingFilenames) {
    const existingName = indexNameFromDbFilename(filename);
    if (
      existingName !== null &&
      canonicalizeIndexNameUnchecked(existingName) === identity
    ) {
      matches.push(filename);
    }
  }

  const uniqueMatches = [...new Set(matches)].sort();
  if (uniqueMatches.length > 1) {
    throw new TypeError(
      `Ambiguous index name "${indexName}": multiple database files share its canonical identity (${uniqueMatches.join(", ")}).`
    );
  }
  return uniqueMatches[0] ?? `${INDEX_DB_PREFIX}${identity}${INDEX_DB_SUFFIX}`;
}
