/**
 * Opaque / unsupported inventory scanners for embeds, HTML, and malformed wiki.
 *
 * @module src/core/link-inventory-opaque
 */

import type { ExcludedRange } from "../ingestion/strip";
import type {
  FileRefactorReasonCode,
  FileRefactorReferenceClassification,
  FileRefactorReferenceKind,
} from "./file-refactor-contract";
import type { LinkInventoryToken } from "./link-inventory-types";

import { buildLineOffsets, offsetToPosition } from "../ingestion/position";
import { detectEncodingStyle } from "./link-destination-parse";
import { LINK_INVENTORY_CAPS } from "./link-inventory-types";
import { isRelevantDestination } from "./link-relevance";

const HTML_HREF_REGEX = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1[^>]*>/gi;

export function pushInventoryToken(
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  token: LinkInventoryToken
): boolean {
  if (tokens.length >= LINK_INVENTORY_CAPS.maxTokensPerDocument) {
    truncated.value = true;
    return false;
  }
  tokens.push(token);
  return true;
}

export function makeOpaqueToken(
  markdown: string,
  lineOffsets: number[],
  kind: FileRefactorReferenceKind,
  classification: FileRefactorReferenceClassification,
  reasonCode: FileRefactorReasonCode,
  startOffset: number,
  endOffset: number,
  destinationStart: number,
  destinationEnd: number
): LinkInventoryToken {
  const startPos = offsetToPosition(startOffset, lineOffsets);
  const endPos = offsetToPosition(endOffset, lineOffsets);
  const originalDestination = markdown.slice(destinationStart, destinationEnd);
  return {
    kind,
    classification,
    reasonCode,
    raw: markdown.slice(startOffset, endOffset),
    originalDestination,
    destinationStart,
    destinationEnd,
    startOffset,
    endOffset,
    startLine: startPos.line,
    startCol: startPos.col,
    endLine: endPos.line,
    endCol: endPos.col,
    targetRef: originalDestination,
    hadLeadingDotSlash: originalDestination.startsWith("./"),
    encodingStyle: detectEncodingStyle(originalDestination),
  };
}

export function findExcludedKind(
  start: number,
  end: number,
  excluded: ExcludedRange[]
): ExcludedRange["kind"] | null {
  for (const range of excluded) {
    if (start < range.end && end > range.start) return range.kind;
  }
  return null;
}

/** Map strip exclusion kind → refactor reason for code-context opaque tokens. */
export function codeContextReason(
  kind: ExcludedRange["kind"] | null
): "code_fence_context" | "inline_code_context" | null {
  if (kind === "fenced_code") return "code_fence_context";
  if (kind === "inline_code") return "inline_code_context";
  return null;
}

export function inventoryEmbeds(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  const embedRegex = /!\[\[([^\]]*)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = embedRegex.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    const inner = match[1] ?? "";
    const pipe = inner.indexOf("|");
    const hash = inner.indexOf("#");
    let destEndInInner = inner.length;
    if (pipe >= 0) destEndInInner = Math.min(destEndInInner, pipe);
    if (hash >= 0) destEndInInner = Math.min(destEndInInner, hash);
    const destStart = startOffset + 3;
    const destEnd = destStart + destEndInInner;
    if (
      !isRelevantDestination(markdown.slice(destStart, destEnd), sourceKeys)
    ) {
      continue;
    }
    for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
    const codeReason = codeContextReason(
      findExcludedKind(startOffset, endOffset, excluded)
    );
    if (
      !pushInventoryToken(
        tokens,
        truncated,
        makeOpaqueToken(
          markdown,
          lineOffsets,
          "opaque",
          codeReason ? "unchanged" : "unsupported",
          codeReason ?? "unsupported_syntax",
          startOffset,
          endOffset,
          destStart,
          destEnd
        )
      )
    ) {
      return false;
    }
  }
  return true;
}

export function inventoryHtmlHrefs(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  HTML_HREF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_HREF_REGEX.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    const href = match[2] ?? "";
    const hrefStartInMatch = match[0].indexOf(href);
    if (hrefStartInMatch < 0) continue;
    if (!isRelevantDestination(href, sourceKeys)) continue;
    const destStart = startOffset + hrefStartInMatch;
    const destEnd = destStart + href.length;
    for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
    const codeReason = codeContextReason(
      findExcludedKind(startOffset, endOffset, excluded)
    );
    if (
      !pushInventoryToken(
        tokens,
        truncated,
        makeOpaqueToken(
          markdown,
          lineOffsets,
          "opaque",
          codeReason ? "unchanged" : "unsupported",
          codeReason ?? "html_context",
          startOffset,
          endOffset,
          destStart,
          destEnd
        )
      )
    ) {
      return false;
    }
  }
  return true;
}

export function inventoryMalformedWiki(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  const openWikiRegex = /\[\[/g;
  let match: RegExpExecArray | null;
  while ((match = openWikiRegex.exec(markdown)) !== null) {
    const startOffset = match.index;
    if (consumed.has(startOffset)) continue;
    if (startOffset > 0 && markdown[startOffset - 1] === "!") continue;
    const close = markdown.indexOf("]]", startOffset + 2);
    const nextOpen = markdown.indexOf("[[", startOffset + 2);
    if (findExcludedKind(startOffset, startOffset + 2, excluded)) continue;
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      const lineEnd = markdown.indexOf("\n", startOffset);
      const endOffset = lineEnd >= 0 ? lineEnd : markdown.length;
      const slice = markdown.slice(startOffset, endOffset);
      const pipe = slice.indexOf("|");
      const destEnd =
        startOffset + (pipe >= 0 ? pipe : Math.min(slice.length, 64));
      const destStart = startOffset + 2;
      const dest = markdown.slice(destStart, destEnd);
      if (!dest || !isRelevantDestination(dest, sourceKeys)) continue;
      for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
      if (
        !pushInventoryToken(
          tokens,
          truncated,
          makeOpaqueToken(
            markdown,
            lineOffsets,
            "opaque",
            "malformed",
            "malformed_syntax",
            startOffset,
            endOffset,
            destStart,
            Math.max(destStart, destEnd)
          )
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Re-export for callers that need line offsets without importing position. */
export { buildLineOffsets };
