import { DEFAULT_INDEX_NAME, parseUri } from "../app/constants";
import {
  canonicalizeIndexName,
  INDEX_NAME_REQUIREMENTS,
  indexNamesMatch,
  isValidIndexName,
} from "../app/index-name";
import { parseRef } from "./ref-parser";

export interface EffectiveIndexResolution {
  indexName?: string;
}

function normalizeIndexName(indexName?: string): string {
  return canonicalizeIndexName(indexName ?? DEFAULT_INDEX_NAME);
}

export function indexesMatch(left?: string, right?: string): boolean {
  return indexNamesMatch(
    left ?? DEFAULT_INDEX_NAME,
    right ?? DEFAULT_INDEX_NAME
  );
}

export function getExplicitRefIndex(ref: string): string | undefined {
  const parsed = parseRef(ref);
  if ("error" in parsed || parsed.type !== "uri") {
    return;
  }
  return parseUri(parsed.value)?.indexName;
}

export function resolveEffectiveIndex(
  refs: string[],
  activeIndexName?: string
):
  | { ok: true; value: EffectiveIndexResolution }
  | { ok: false; error: string } {
  if (activeIndexName !== undefined && !isValidIndexName(activeIndexName)) {
    return {
      ok: false,
      error: `Invalid index name: ${INDEX_NAME_REQUIREMENTS}.`,
    };
  }
  const explicitIndexes = new Map<string, string>();
  let hasUnindexedRef = false;

  for (const ref of refs) {
    const explicitIndex = getExplicitRefIndex(ref);
    if (explicitIndex !== undefined) {
      if (!isValidIndexName(explicitIndex)) {
        return {
          ok: false,
          error: `Invalid index name: ${INDEX_NAME_REQUIREMENTS}.`,
        };
      }
      const identity = canonicalizeIndexName(explicitIndex);
      if (!explicitIndexes.has(identity)) {
        explicitIndexes.set(identity, explicitIndex);
      }
    } else {
      hasUnindexedRef = true;
    }
  }

  if (explicitIndexes.size > 1) {
    return {
      ok: false,
      error: `References cannot mix explicit indexes: ${[
        ...explicitIndexes.values(),
      ]
        .sort()
        .join(", ")}`,
    };
  }

  const explicitIndex = [...explicitIndexes.values()][0];
  if (
    explicitIndex &&
    hasUnindexedRef &&
    !indexesMatch(explicitIndex, activeIndexName)
  ) {
    return {
      ok: false,
      error: `References cannot mix indexed refs (${explicitIndex}) with unindexed refs while the active index is ${normalizeIndexName(activeIndexName)}`,
    };
  }

  return {
    ok: true,
    value: { indexName: explicitIndex ?? activeIndexName },
  };
}
