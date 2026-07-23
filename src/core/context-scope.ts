/** Canonical URI scope matching shared by Context planning stages. */

import { DEFAULT_INDEX_NAME, parseUri } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";

export const isContextUriInScope = (
  uri: string,
  indexName: string,
  collections: string[],
  prefixValue: string | null
): boolean => {
  const value = parseUri(uri);
  if (
    !value ||
    canonicalizeIndexName(value.indexName ?? DEFAULT_INDEX_NAME) !==
      indexName ||
    (collections.length > 0 && !collections.includes(value.collection))
  ) {
    return false;
  }
  if (prefixValue === null) return true;
  const prefix = parseUri(prefixValue);
  return Boolean(
    prefix &&
    value.collection === prefix.collection &&
    canonicalizeIndexName(prefix.indexName ?? DEFAULT_INDEX_NAME) ===
      indexName &&
    (prefix.path === "" ||
      value.path === prefix.path ||
      value.path.startsWith(`${prefix.path}/`))
  );
};
