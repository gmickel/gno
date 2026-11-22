/**
 * Zero-dependency pure wiki-link string helpers.
 * Extracted from src/core/links so browser bundles (MarkdownPreview) and
 * lightweight callers do not pull in node:path or markdown parsing modules.
 *
 * @module src/core/wiki-link-syntax
 */

export interface TargetParts {
  /** Reference (name or path) without anchor */
  ref: string;
  /** Anchor/fragment without # */
  anchor?: string;
  /** Collection prefix */
  collection?: string;
}

/** Collection prefix pattern: collection:rest */
const COLLECTION_PREFIX_REGEX = /^([a-z0-9_-]+):(.+)$/i;

/**
 * Normalize wiki name: NFC + lowercase + trim.
 * Used for matching wiki links to document titles.
 */
export function normalizeWikiName(name: string): string {
  return name.normalize("NFC").toLowerCase().trim();
}

/**
 * Strip a trailing .md extension (case-insensitive) without lowercasing.
 */
export function stripWikiMdExt(ref: string): string {
  const lower = ref.toLowerCase();
  return lower.endsWith(".md") ? ref.slice(0, -3) : ref;
}

/**
 * Split the content of a wiki link into target and alias. Obsidian also reads
 * `\|` (the pipe escaped inside a Markdown table) as the alias separator,
 * so `[[Note\|Alias]]` targets `Note`, not `Note\`.
 */
export function splitWikiLinkContent(content: string): {
  target: string;
  alias?: string;
} {
  const pipeIndex = content.indexOf("|");
  if (pipeIndex < 0) {
    return { target: content };
  }
  const escaped = pipeIndex > 0 && content[pipeIndex - 1] === "\\";
  return {
    target: content.slice(0, escaped ? pipeIndex - 1 : pipeIndex),
    alias: content.slice(pipeIndex + 1),
  };
}

/**
 * Parse target into ref, anchor, and optional collection prefix.
 * Handles: "Note", "Note#Section", "collection:Note#Section"
 */
export function parseTargetParts(target: string): TargetParts {
  let remaining = target.trim();
  let collection: string | undefined;

  // Check for collection prefix (before any #)
  const hashIndex = remaining.indexOf("#");
  const textBeforeHash =
    hashIndex >= 0 ? remaining.slice(0, hashIndex) : remaining;

  const prefixMatch = COLLECTION_PREFIX_REGEX.exec(textBeforeHash);
  if (prefixMatch?.[1] && prefixMatch[2]) {
    collection = prefixMatch[1].toLowerCase(); // Normalize to lowercase for consistency
    // Reconstruct remaining without the collection prefix
    remaining =
      prefixMatch[2] + (hashIndex >= 0 ? remaining.slice(hashIndex) : "");
  }

  // Split on # for anchor
  const parts = remaining.split("#");
  const ref = (parts[0] ?? "").trim();
  const anchor = parts[1]?.trim();

  return {
    ref,
    anchor: anchor && anchor.length > 0 ? anchor : undefined,
    collection,
  };
}
