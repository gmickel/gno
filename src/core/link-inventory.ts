/**
 * Parser-backed link inventory for reference-safe file refactors.
 *
 * Produces exact UTF-16 destination token spans plus conservative opaque /
 * malformed detections. Does not mutate disk or change parseLinks behavior.
 *
 * @module src/core/link-inventory
 */

import type { ExcludedRange } from "../ingestion/strip";
import type {
  LinkInventoryResult,
  LinkInventoryToken,
} from "./link-inventory-types";

import { getExcludedRanges } from "../ingestion/strip";
import {
  inventoryInlineMarkdown,
  inventoryReferenceDefinitions,
  inventoryWikiLinks,
} from "./link-inventory-markdown";
import {
  buildLineOffsets,
  inventoryEmbeds,
  inventoryHtmlHrefs,
  inventoryMalformedWiki,
} from "./link-inventory-opaque";
import { LINK_INVENTORY_CAPS } from "./link-inventory-types";

export {
  LINK_INVENTORY_CAPS,
  type LinkInventoryResult,
  type LinkInventoryToken,
} from "./link-inventory-types";
export {
  buildContentPrefilterNeedles,
  buildSourceRelevanceKeys,
  isRelevantDestination,
} from "./link-relevance";

/**
 * Destination identity for inventory dedupe.
 * Kind is intentionally omitted so identical spans from overlapping scanners
 * collapse to the first (scanner-precedence) token.
 */
export function inventoryDestinationKey(token: {
  destinationStart: number;
  destinationEnd: number;
  originalDestination: string;
}): string {
  return `${token.destinationStart}:${token.destinationEnd}:${token.originalDestination}`;
}

/**
 * Dedupe identical destination spans (regardless of scanner kind) and detect
 * true partial overlaps. First token wins — callers should push in scanner order.
 */
export function dedupeInventoryDestinationTokens(
  tokens: LinkInventoryToken[]
): {
  tokens: LinkInventoryToken[];
  overlapping: boolean;
} {
  const seen = new Set<string>();
  const unique: LinkInventoryToken[] = [];
  for (const token of tokens) {
    const key = inventoryDestinationKey(token);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
  }
  unique.sort((a, b) => {
    if (a.destinationStart !== b.destinationStart) {
      return a.destinationStart - b.destinationStart;
    }
    return a.destinationEnd - b.destinationEnd;
  });
  let overlapping = false;
  for (let i = 1; i < unique.length; i += 1) {
    const prev = unique[i - 1]!;
    const cur = unique[i]!;
    if (cur.destinationStart < prev.destinationEnd) {
      overlapping = true;
      break;
    }
  }
  unique.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    return a.destinationStart - b.destinationStart;
  });
  return { tokens: unique, overlapping };
}

/**
 * Inventory all relevant rewrite / opaque reference tokens in one document.
 */
export function inventoryDocumentLinks(
  markdown: string,
  options: {
    sourceKeys: ReadonlySet<string>;
    excludedRanges?: ExcludedRange[];
  }
): LinkInventoryResult {
  const truncated = { value: false };
  if (markdown.length > LINK_INVENTORY_CAPS.maxContentChars) {
    return { tokens: [], truncated: true, overlapping: false };
  }

  const excluded = options.excludedRanges ?? getExcludedRanges(markdown);
  const lineOffsets = buildLineOffsets(markdown);
  const tokens: LinkInventoryToken[] = [];
  const consumed = new Set<number>();
  const sourceKeys = options.sourceKeys;

  const ok =
    inventoryEmbeds(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    ) &&
    inventoryHtmlHrefs(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    ) &&
    inventoryMalformedWiki(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    ) &&
    inventoryWikiLinks(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    ) &&
    inventoryReferenceDefinitions(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    ) &&
    inventoryInlineMarkdown(
      markdown,
      lineOffsets,
      sourceKeys,
      excluded,
      tokens,
      truncated,
      consumed
    );

  if (!ok) {
    return { tokens, truncated: true, overlapping: false };
  }

  const finalized = dedupeInventoryDestinationTokens(tokens);
  return {
    tokens: finalized.tokens,
    truncated: truncated.value,
    overlapping: finalized.overlapping,
  };
}
