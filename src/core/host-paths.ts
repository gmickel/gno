/**
 * Host path redaction for callers that are not on the owner's machine.
 *
 * Result payloads name a source file's host location in `absPath`
 * (`source.absPath` on search/get results, top-level on capture, memory and
 * peek receipts). A remote caller identifies documents by `uri` and
 * collection-relative `relPath` instead, so every `absPath` key is removed
 * before a payload leaves a remote-reachable surface.
 */

const HOST_PATH_FIELD = "absPath";

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

/** Deep copy of a JSON-shaped value with every `absPath` key removed. */
export function withoutHostPaths<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutHostPaths(item)) as T;
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== HOST_PATH_FIELD) copy[key] = withoutHostPaths(entry);
  }
  return copy as T;
}
