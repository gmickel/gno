import { DEFAULT_INDEX_NAME, parseUri } from "../app/constants";
import { parseRef } from "./ref-parser";

export interface EffectiveIndexResolution {
  indexName?: string;
}

function normalizeIndexName(indexName?: string): string {
  const normalized = indexName?.trim();
  return normalized || DEFAULT_INDEX_NAME;
}

export function indexesMatch(left?: string, right?: string): boolean {
  return normalizeIndexName(left) === normalizeIndexName(right);
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
  const explicitIndexes = new Set<string>();
  let hasUnindexedRef = false;

  for (const ref of refs) {
    const explicitIndex = getExplicitRefIndex(ref);
    if (explicitIndex) {
      explicitIndexes.add(explicitIndex);
    } else {
      hasUnindexedRef = true;
    }
  }

  if (explicitIndexes.size > 1) {
    return {
      ok: false,
      error: `References cannot mix explicit indexes: ${[...explicitIndexes]
        .sort()
        .join(", ")}`,
    };
  }

  const explicitIndex = [...explicitIndexes][0];
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
