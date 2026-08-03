/**
 * Wiki / markdown / reference-definition inventory scanners.
 *
 * @module src/core/link-inventory-markdown
 */

import type { ExcludedRange } from "../ingestion/strip";
import type { LinkInventoryToken } from "./link-inventory-types";

import { offsetToPosition } from "../ingestion/position";
import { rangeIntersectsExcluded } from "../ingestion/strip";
import {
  detectEncodingStyle,
  parseParenthesizedDestination,
  splitDestinationPath,
  stripAngleBracketDestination,
  unescapeCommonMarkDestination,
} from "./link-destination-parse";
import {
  codeContextReason,
  findExcludedKind,
  makeOpaqueToken,
  pushInventoryToken,
} from "./link-inventory-opaque";
import { isRelevantDestination } from "./link-relevance";
import { parseTargetParts } from "./links";

const EXTERNAL_URL_REGEX = /^[a-z][a-z0-9+.-]*:/i;

export function inventoryWikiLinks(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  const wikiRegex = /\[\[([^\]\n]*?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiRegex.exec(markdown)) !== null) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    if (consumed.has(startOffset)) continue;
    if (startOffset > 0 && markdown[startOffset - 1] === "!") continue;
    if (
      markdown.slice(Math.max(0, startOffset - 2), startOffset) === "](" &&
      markdown.slice(endOffset, endOffset + 1) === ")"
    ) {
      continue;
    }

    const content = match[1] ?? "";
    const pipeIndex = content.indexOf("|");
    const targetPart = pipeIndex >= 0 ? content.slice(0, pipeIndex) : content;
    const trimmedTarget = targetPart.trim();
    if (!trimmedTarget) continue;
    const leadingWs = targetPart.length - targetPart.trimStart().length;
    const parts = parseTargetParts(trimmedTarget);
    if (!parts.ref || !isRelevantDestination(parts.ref, sourceKeys)) continue;

    const destStart = startOffset + 2 + leadingWs;
    const destEnd = destStart + parts.ref.length;
    const codeReason = codeContextReason(
      findExcludedKind(startOffset, endOffset, excluded)
    );

    if (codeReason) {
      if (
        !pushInventoryToken(
          tokens,
          truncated,
          makeOpaqueToken(
            markdown,
            lineOffsets,
            "opaque",
            "unchanged",
            codeReason,
            startOffset,
            endOffset,
            destStart,
            destEnd
          )
        )
      ) {
        return false;
      }
      for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
      continue;
    }
    if (findExcludedKind(startOffset, endOffset, excluded)) continue;
    if (
      EXTERNAL_URL_REGEX.test(trimmedTarget) ||
      trimmedTarget.startsWith("//")
    ) {
      continue;
    }

    const startPos = offsetToPosition(startOffset, lineOffsets);
    const endPos = offsetToPosition(endOffset, lineOffsets);
    if (
      !pushInventoryToken(tokens, truncated, {
        kind: "wiki",
        raw: match[0],
        originalDestination: parts.ref,
        destinationStart: destStart,
        destinationEnd: destEnd,
        startOffset,
        endOffset,
        startLine: startPos.line,
        startCol: startPos.col,
        endLine: endPos.line,
        endCol: endPos.col,
        targetRef: parts.ref,
        targetAnchor: parts.anchor,
        targetCollection: parts.collection,
        hadLeadingDotSlash: parts.ref.startsWith("./"),
        encodingStyle: detectEncodingStyle(parts.ref),
      })
    ) {
      return false;
    }
    for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
  }
  return true;
}

export function inventoryReferenceDefinitions(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  let lineStart = 0;
  while (lineStart <= markdown.length) {
    const lineEndIdx = markdown.indexOf("\n", lineStart);
    const lineEnd = lineEndIdx >= 0 ? lineEndIdx : markdown.length;
    const line = markdown.slice(lineStart, lineEnd);
    const defMatch = /^ {0,3}\[([^\]]+)\]:\s*/.exec(line);
    if (defMatch) {
      const startOffset = lineStart;
      const endOffset = lineEnd;
      if (!consumed.has(startOffset)) {
        let cursor = defMatch[0].length;
        while (cursor < line.length && /[ \t]/.test(line[cursor] ?? "")) {
          cursor += 1;
        }
        let destRaw = "";
        let pathStartInLine = cursor;
        let angleBrackets = false;

        if (line[cursor] === "<") {
          const close = line.indexOf(">", cursor + 1);
          if (close >= 0) {
            angleBrackets = true;
            destRaw = line.slice(cursor, close + 1);
            cursor = close + 1;
          }
        } else {
          let i = cursor;
          while (i < line.length) {
            const ch = line[i];
            if (ch === "\\" && i + 1 < line.length) {
              i += 2;
              continue;
            }
            if (ch === " " || ch === "\t") break;
            i += 1;
          }
          destRaw = line.slice(cursor, i);
          cursor = i;
        }

        if (destRaw) {
          const angled = stripAngleBracketDestination(destRaw);
          const destParts = splitDestinationPath(
            unescapeCommonMarkDestination(angled.path)
          );
          if (destParts.path) {
            let pathStart = startOffset + pathStartInLine;
            let pathEnd = pathStart + destRaw.length;
            if (angleBrackets) {
              pathStart += 1;
              const innerSplit = splitDestinationPath(angled.path);
              pathEnd = pathStart + innerSplit.path.length;
            } else {
              const rawSplit = splitDestinationPath(destRaw);
              pathEnd = pathStart + rawSplit.path.length;
            }

            const pathForRelevance = angleBrackets
              ? destParts.path
              : splitDestinationPath(destRaw).path;
            const originalDestination = markdown.slice(pathStart, pathEnd);
            const codeReason = codeContextReason(
              findExcludedKind(startOffset, endOffset, excluded)
            );

            if (
              codeReason &&
              isRelevantDestination(pathForRelevance, sourceKeys)
            ) {
              if (
                !pushInventoryToken(
                  tokens,
                  truncated,
                  makeOpaqueToken(
                    markdown,
                    lineOffsets,
                    "opaque",
                    "unchanged",
                    codeReason,
                    startOffset,
                    endOffset,
                    pathStart,
                    pathEnd
                  )
                )
              ) {
                return false;
              }
            } else if (
              !rangeIntersectsExcluded(startOffset, endOffset, excluded)
            ) {
              if (EXTERNAL_URL_REGEX.test(destParts.path)) {
                if (isRelevantDestination(pathForRelevance, sourceKeys)) {
                  if (
                    !pushInventoryToken(
                      tokens,
                      truncated,
                      makeOpaqueToken(
                        markdown,
                        lineOffsets,
                        "markdown_definition",
                        "unchanged",
                        "external_destination",
                        startOffset,
                        endOffset,
                        pathStart,
                        pathEnd
                      )
                    )
                  ) {
                    return false;
                  }
                }
              } else if (isRelevantDestination(pathForRelevance, sourceKeys)) {
                const startPos = offsetToPosition(startOffset, lineOffsets);
                const endPos = offsetToPosition(endOffset, lineOffsets);
                if (
                  !pushInventoryToken(tokens, truncated, {
                    kind: "markdown_definition",
                    reasonCode: "reference_definition_site",
                    raw: markdown.slice(startOffset, endOffset),
                    originalDestination,
                    destinationStart: pathStart,
                    destinationEnd: pathEnd,
                    startOffset,
                    endOffset,
                    startLine: startPos.line,
                    startCol: startPos.col,
                    endLine: endPos.line,
                    endCol: endPos.col,
                    targetRef: originalDestination,
                    targetAnchor: destParts.anchor,
                    targetQuery: destParts.query,
                    hadLeadingDotSlash: destParts.path.startsWith("./"),
                    encodingStyle: detectEncodingStyle(originalDestination),
                  })
                ) {
                  return false;
                }
              }
            }
          }
        }
      }
    }

    if (lineEndIdx < 0) break;
    lineStart = lineEndIdx + 1;
  }
  return true;
}

export function inventoryInlineMarkdown(
  markdown: string,
  lineOffsets: number[],
  sourceKeys: ReadonlySet<string>,
  excluded: ExcludedRange[],
  tokens: LinkInventoryToken[],
  truncated: { value: boolean },
  consumed: Set<number>
): boolean {
  let searchFrom = 0;
  while (searchFrom < markdown.length) {
    const labelOpen = markdown.indexOf("[", searchFrom);
    if (labelOpen < 0) break;
    if (labelOpen > 0 && markdown[labelOpen - 1] === "!") {
      searchFrom = labelOpen + 1;
      continue;
    }
    const labelClose = markdown.indexOf("]", labelOpen + 1);
    if (labelClose < 0) break;
    if (markdown[labelClose + 1] !== "(") {
      searchFrom = labelOpen + 1;
      continue;
    }
    const parsed = parseParenthesizedDestination(markdown, labelClose + 1);
    if (!parsed) {
      searchFrom = labelOpen + 1;
      continue;
    }
    const startOffset = labelOpen;
    const endOffset = parsed.closeParenOffset + 1;
    searchFrom = endOffset;
    if (consumed.has(startOffset)) continue;

    const destRaw = parsed.destinationRaw.trim();
    if (destRaw.startsWith("[[") && destRaw.endsWith("]]")) continue;

    const angled = stripAngleBracketDestination(destRaw);
    const unescapedPath = unescapeCommonMarkDestination(angled.path);
    const destParts = splitDestinationPath(unescapedPath);
    const pathToken = destParts.path;
    if (!pathToken) continue;

    const leading =
      parsed.destinationRaw.length - parsed.destinationRaw.trimStart().length;
    let destStart = parsed.destinationStart + leading;
    let destEnd = destStart + destRaw.length;
    if (angled.angleBrackets) {
      destStart += 1;
      const innerSplit = splitDestinationPath(angled.path);
      destEnd = destStart + innerSplit.path.length;
    } else {
      const rawSplit = splitDestinationPath(destRaw);
      destEnd = destStart + rawSplit.path.length;
    }

    const originalDestination = markdown.slice(destStart, destEnd);
    if (
      !isRelevantDestination(originalDestination, sourceKeys) &&
      !isRelevantDestination(pathToken, sourceKeys)
    ) {
      continue;
    }

    const excludedKind = findExcludedKind(startOffset, endOffset, excluded);
    const codeReason = codeContextReason(excludedKind);
    if (codeReason) {
      if (
        !pushInventoryToken(
          tokens,
          truncated,
          makeOpaqueToken(
            markdown,
            lineOffsets,
            "opaque",
            "unchanged",
            codeReason,
            startOffset,
            endOffset,
            destStart,
            destEnd
          )
        )
      ) {
        return false;
      }
      for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
      continue;
    }
    if (excludedKind) continue;

    if (EXTERNAL_URL_REGEX.test(pathToken) || pathToken.startsWith("//")) {
      if (
        !pushInventoryToken(
          tokens,
          truncated,
          makeOpaqueToken(
            markdown,
            lineOffsets,
            "markdown",
            "unchanged",
            "external_destination",
            startOffset,
            endOffset,
            destStart,
            destEnd
          )
        )
      ) {
        return false;
      }
      continue;
    }

    const parts = parseTargetParts(pathToken);
    if (parts.collection) {
      if (
        !pushInventoryToken(
          tokens,
          truncated,
          makeOpaqueToken(
            markdown,
            lineOffsets,
            "markdown",
            "unsupported",
            "cross_collection_unsupported",
            startOffset,
            endOffset,
            destStart,
            destEnd
          )
        )
      ) {
        return false;
      }
      continue;
    }

    const startPos = offsetToPosition(startOffset, lineOffsets);
    const endPos = offsetToPosition(endOffset, lineOffsets);
    if (
      !pushInventoryToken(tokens, truncated, {
        kind: "markdown",
        raw: markdown.slice(startOffset, endOffset),
        originalDestination,
        destinationStart: destStart,
        destinationEnd: destEnd,
        startOffset,
        endOffset,
        startLine: startPos.line,
        startCol: startPos.col,
        endLine: endPos.line,
        endCol: endPos.col,
        targetRef: originalDestination,
        targetAnchor: destParts.anchor ?? parts.anchor,
        targetQuery: destParts.query,
        targetCollection: parts.collection,
        hadLeadingDotSlash: pathToken.startsWith("./"),
        encodingStyle: detectEncodingStyle(originalDestination),
      })
    ) {
      return false;
    }
    for (let i = startOffset; i < endOffset; i += 1) consumed.add(i);
  }
  return true;
}
