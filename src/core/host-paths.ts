/**
 * Host path redaction for callers that are not on the owner's machine.
 *
 * Result payloads name a source file's host location in `absPath`
 * (`source.absPath` on search/get results, top-level on capture, memory and
 * peek receipts). A remote caller identifies documents by `uri` and
 * collection-relative `relPath` instead, so every `absPath` key is removed
 * before a payload leaves a remote-reachable surface.
 *
 * Status, collection, and connector payloads also name owner configuration
 * locations: `configPath`, `dbPath`, and `path` (collection roots, suggested
 * folders, model cache and model files, connector targets). A remote caller
 * identifies a collection by `name`, so those keys are removed from those
 * payloads too.
 */

/** Document host path key of result payloads. */
export const HOST_PATH_FIELDS: ReadonlySet<string> = new Set(["absPath"]);

/** Owner configuration path keys of status, collection, and connector payloads. */
export const OWNER_CONFIG_PATH_FIELDS: ReadonlySet<string> = new Set([
  "configPath",
  "dbPath",
  "path",
]);

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

/** Deep copy of a JSON-shaped value with every key in `fields` removed. */
export function withoutFields<T>(value: T, fields: ReadonlySet<string>): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutFields(item, fields)) as T;
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!fields.has(key)) copy[key] = withoutFields(entry, fields);
  }
  return copy as T;
}

/** Deep copy of a JSON-shaped value with every `absPath` key removed. */
export const withoutHostPaths = <T>(value: T): T =>
  withoutFields(value, HOST_PATH_FIELDS);
