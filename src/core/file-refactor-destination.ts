/**
 * Destination token recomputation for wiki / markdown reference rewrites.
 *
 * @module src/core/file-refactor-destination
 */

// node:path/posix — no Bun path utils
import { posix as pathPosix } from "node:path";

import type { LinkInventoryToken } from "./link-inventory-types";

import {
  applyDestinationEncodingStyle,
  stripAngleBracketDestination,
  unescapeCommonMarkDestination,
} from "./link-destination-parse";
import { stripWikiMdExt } from "./links";

function preserveDotSlash(original: string, nextRelative: string): string {
  if (!original.startsWith("./")) return nextRelative;
  if (nextRelative.startsWith("../") || nextRelative.startsWith("./")) {
    return nextRelative;
  }
  return `./${nextRelative}`;
}

/**
 * Compute a wiki destination token for the new target identity, preserving
 * basename-vs-path and optional `.md` extension style when safely possible.
 */
export function computeWikiReplacementDestination(input: {
  originalDestination: string;
  sourceRelPath: string;
  sourceTitle: string | null | undefined;
  targetRelPath: string;
  targetTitle?: string | null;
}): string {
  const original = input.originalDestination;
  const hadMd = original.toLowerCase().endsWith(".md");
  const originalBase = stripWikiMdExt(pathPosix.basename(original));
  const sourceBase = stripWikiMdExt(pathPosix.basename(input.sourceRelPath));
  const targetBase = stripWikiMdExt(pathPosix.basename(input.targetRelPath));
  const targetTitle =
    input.targetTitle?.trim() ||
    pathPosix.basename(
      input.targetRelPath,
      pathPosix.extname(input.targetRelPath)
    );

  const looksLikePath =
    original.includes("/") ||
    original.toLowerCase() === input.sourceRelPath.toLowerCase() ||
    stripWikiMdExt(original).toLowerCase() ===
      stripWikiMdExt(input.sourceRelPath).toLowerCase();

  if (looksLikePath) {
    let next = input.targetRelPath;
    if (!hadMd) {
      next = stripWikiMdExt(next);
    }
    if (!original.includes("/") && pathPosix.basename(original) === original) {
      next = hadMd ? `${targetBase}.md` : targetBase;
    }
    return next;
  }

  const sourceTitle = input.sourceTitle?.trim() ?? sourceBase;
  if (
    originalBase.toLowerCase() === sourceTitle.toLowerCase() ||
    originalBase.toLowerCase() === sourceBase.toLowerCase()
  ) {
    const next = targetTitle;
    return hadMd ? `${next}.md` : next;
  }

  return hadMd ? `${targetBase}.md` : targetBase;
}

/**
 * Recompute a markdown (or reference-definition) relative destination from the
 * referring document directory to the new target path, preserving escape style.
 */
export function computeMarkdownReplacementDestination(input: {
  token: Pick<
    LinkInventoryToken,
    "originalDestination" | "hadLeadingDotSlash" | "encodingStyle"
  >;
  referringRelPath: string;
  targetRelPath: string;
}): string {
  const referringDir = pathPosix.dirname(input.referringRelPath);
  let relative = pathPosix.relative(referringDir, input.targetRelPath);
  if (!relative || relative === "") {
    relative = pathPosix.basename(input.targetRelPath);
  }
  const originalForDot = stripAngleBracketDestination(
    unescapeCommonMarkDestination(input.token.originalDestination)
  ).path;
  if (
    input.token.hadLeadingDotSlash ||
    originalForDot.startsWith("./") ||
    input.token.originalDestination.startsWith("./")
  ) {
    relative = preserveDotSlash(
      originalForDot.startsWith("./")
        ? originalForDot
        : input.token.originalDestination,
      relative
    );
  }
  return applyDestinationEncodingStyle(relative, input.token.encodingStyle);
}

/**
 * After computing a wiki replacement, decide whether leaving the destination
 * unchanged is acceptable because the original still uniquely names the target.
 */
export function wikiDestinationUnchangedAcceptable(input: {
  originalDestination: string;
  replacementDestination: string;
}): boolean {
  return input.originalDestination === input.replacementDestination;
}
