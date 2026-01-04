/**
 * Frontmatter parsing and tag extraction.
 *
 * Extracts tags from:
 * - YAML frontmatter (tags: [...] or tags: a, b)
 * - Logseq properties (tags:: value)
 * - Inline hashtags in body text
 *
 * @module src/ingestion/frontmatter
 */

import { normalizeTag } from "../core/tags";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of frontmatter parsing */
export interface FrontmatterResult {
  /** Extracted tags (normalized) */
  tags: string[];
  /** Other frontmatter fields (title, etc.) */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Frontmatter delimiter regex (must be at start of file) */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;

/** Logseq property format: tags:: value */
const LOGSEQ_TAGS_REGEX = /^tags::\s*(.*)$/im;

/** YAML tags field (array or string) */
const YAML_TAGS_REGEX = /^tags:\s*(.*)$/im;

/** YAML array item */
const YAML_ARRAY_ITEM_REGEX = /^\s*-\s*(.+)$/;

/** Inline array [a, b, c] */
const INLINE_ARRAY_REGEX = /^\[([^\]]*)\]$/;

/**
 * Hashtag regex for body extraction.
 * Matches #tag where tag follows our grammar (letters, digits, hyphens, slashes).
 * Uses negative lookbehind to avoid matching URL anchors.
 * Note: Excludes dots to avoid capturing sentence-ending periods.
 */
const HASHTAG_REGEX = /(?<![/\w])#([\p{L}\p{N}][\p{L}\p{N}\-/]*)/gu;

/** Code block markers for skipping */
const FENCED_CODE_REGEX = /^```[\s\S]*?^```/gm;
const INLINE_CODE_REGEX = /`[^`]+`/g;

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse YAML-style tags value into array of strings.
 * Handles formats:
 * - tags: [a, b, c]
 * - tags: a, b, c
 * - tags:\n  - a\n  - b
 */
function parseTagsValue(
  value: string,
  lines: string[],
  startIdx: number
): string[] {
  const trimmed = value.trim();

  // Inline array format: [a, b, c]
  const inlineMatch = INLINE_ARRAY_REGEX.exec(trimmed);
  if (inlineMatch?.[1]) {
    return inlineMatch[1]
      .split(",")
      .map((t) => normalizeTag(t.trim()))
      .filter((t) => t.length > 0);
  }

  // Check if next lines are array items (YAML block array)
  const tags: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    const itemMatch = YAML_ARRAY_ITEM_REGEX.exec(line);
    if (itemMatch?.[1]) {
      const tag = normalizeTag(itemMatch[1].trim());
      if (tag.length > 0) {
        tags.push(tag);
      }
    } else if (
      line.trim().length > 0 &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      // Non-indented non-empty line means end of array
      break;
    }
  }

  if (tags.length > 0) {
    return tags;
  }

  // Comma-separated on same line
  if (trimmed.length > 0) {
    return trimmed
      .split(",")
      .map((t) => normalizeTag(t.trim()))
      .filter((t) => t.length > 0);
  }

  return [];
}

/**
 * Parse frontmatter from markdown source.
 * Returns extracted tags and metadata.
 * Never throws - returns empty result on parse errors.
 */
export function parseFrontmatter(source: string): FrontmatterResult {
  const result: FrontmatterResult = {
    tags: [],
    metadata: {},
  };

  const match = FRONTMATTER_REGEX.exec(source);
  if (!match) {
    // Check for Logseq-style properties at start of file (no --- delimiters)
    const logseqMatch = LOGSEQ_TAGS_REGEX.exec(
      source.split("\n").slice(0, 10).join("\n")
    );
    if (logseqMatch?.[1]) {
      result.tags = parseLogseqTags(logseqMatch[1]);
    }
    return result;
  }

  const frontmatter = match[1];
  if (frontmatter === undefined) return result;

  const lines = frontmatter.split("\n");

  try {
    // Find tags field
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;

      // Logseq format: tags:: value
      const logseqMatch = LOGSEQ_TAGS_REGEX.exec(line);
      if (logseqMatch?.[1]) {
        result.tags = parseLogseqTags(logseqMatch[1]);
        continue;
      }

      // YAML format: tags: value
      const yamlMatch = YAML_TAGS_REGEX.exec(line);
      if (yamlMatch?.[1] !== undefined) {
        result.tags = parseTagsValue(yamlMatch[1], lines, i);
        continue;
      }

      // Parse other simple key: value fields for metadata
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key !== "tags" && value.length > 0) {
          result.metadata[key] = value;
        }
      }
    }
  } catch {
    // Malformed YAML - return empty tags but don't throw
  }

  return result;
}

/**
 * Parse Logseq-style tags (space or comma separated).
 */
function parseLogseqTags(value: string): string[] {
  // Handle both comma-separated and space-separated
  return value
    .split(/[,\s]+/)
    .map((t) => {
      // Remove leading # if present
      const clean = t.startsWith("#") ? t.slice(1) : t;
      return normalizeTag(clean);
    })
    .filter((t) => t.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter Stripping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip frontmatter from markdown source.
 * Returns content after the closing --- delimiter.
 */
export function stripFrontmatter(source: string): string {
  const match = FRONTMATTER_REGEX.exec(source);
  if (!match) {
    return source;
  }
  return source.slice(match[0].length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashtag Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update frontmatter tags in markdown source.
 * If no frontmatter exists, adds one with tags.
 * Replaces existing tags field if present.
 */
export function updateFrontmatterTags(source: string, tags: string[]): string {
  const tagsLine = tags.length > 0 ? `tags: [${tags.join(", ")}]` : "tags: []";

  const match = FRONTMATTER_REGEX.exec(source);

  if (!match) {
    // No frontmatter - add one
    return `---\n${tagsLine}\n---\n\n${source}`;
  }

  const frontmatter = match[1];
  if (frontmatter === undefined) {
    return `---\n${tagsLine}\n---\n\n${source.slice(match[0].length)}`;
  }

  const lines = frontmatter.split("\n");
  const newLines: string[] = [];
  let foundTags = false;
  let skipArrayItems = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Check if this is a tags line (YAML or Logseq format)
    const yamlMatch = YAML_TAGS_REGEX.exec(line);
    const logseqMatch = LOGSEQ_TAGS_REGEX.exec(line);

    if (yamlMatch || logseqMatch) {
      // Replace with new tags
      newLines.push(tagsLine);
      foundTags = true;

      // Skip array items on following lines if YAML block array
      const value = (yamlMatch?.[1] ?? "").trim();
      if (value === "" || value.startsWith("-")) {
        skipArrayItems = true;
      }
      continue;
    }

    // Skip array items if we just replaced a YAML block array
    if (skipArrayItems) {
      const itemMatch = YAML_ARRAY_ITEM_REGEX.exec(line);
      if (itemMatch) {
        continue;
      }
      // Non-array-item line, stop skipping
      skipArrayItems = false;
    }

    newLines.push(line);
  }

  // Add tags if not found
  if (!foundTags) {
    newLines.push(tagsLine);
  }

  const newFrontmatter = newLines.join("\n");
  const rest = source.slice(match[0].length);
  return `---\n${newFrontmatter}\n---\n${rest}`;
}

/**
 * Extract hashtags from markdown body.
 * Skips:
 * - Fenced code blocks (```)
 * - Inline code (`code`)
 * - URL anchors (https://example.com#anchor)
 */
export function extractHashtags(content: string): string[] {
  // Remove fenced code blocks
  let cleaned = content.replace(FENCED_CODE_REGEX, "");

  // Remove inline code
  cleaned = cleaned.replace(INLINE_CODE_REGEX, "");

  // Extract hashtags
  const tags = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex state
  HASHTAG_REGEX.lastIndex = 0;

  while ((match = HASHTAG_REGEX.exec(cleaned)) !== null) {
    const captured = match[1];
    if (!captured) continue;
    const tag = normalizeTag(captured);
    // Skip URL-like matches and empty tags
    if (tag.length > 0 && !tag.includes("://")) {
      // Remove trailing slashes from hierarchical tags
      const cleanTag = tag.replace(/\/+$/, "");
      if (cleanTag.length > 0) {
        tags.add(cleanTag);
      }
    }
  }

  return [...tags];
}
