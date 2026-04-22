import type { StorePort, StoreResult } from "./types";

import { err, ok } from "./types";

/**
 * Load content in batch when the store supports it.
 * Falls back to sequential reads for lightweight test doubles.
 */
export async function getContentBatch(
  store: StorePort,
  mirrorHashes: string[]
): Promise<StoreResult<Map<string, string>>> {
  const uniqueHashes = [...new Set(mirrorHashes)];
  if (uniqueHashes.length === 0) {
    return ok(new Map());
  }

  if (store.getContentBatch) {
    return store.getContentBatch(uniqueHashes);
  }

  const contentByHash = new Map<string, string>();
  for (const mirrorHash of uniqueHashes) {
    const contentResult = await store.getContent(mirrorHash);
    if (!contentResult.ok) {
      return err(
        "QUERY_FAILED",
        contentResult.error.message,
        contentResult.error.cause
      );
    }
    if (contentResult.value !== null) {
      contentByHash.set(mirrorHash, contentResult.value);
    }
  }

  return ok(contentByHash);
}
