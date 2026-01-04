/**
 * Tag utilities for normalization, validation, and parsing.
 *
 * Tag Grammar:
 * - Tags are hierarchical, separated by /
 * - Each segment: lowercase letters, digits, hyphens, dots
 * - Unicode letters allowed (normalized to NFC lowercase)
 * - No leading/trailing slashes, no empty segments
 *
 * @module src/core/tags
 */

/**
 * Normalize a tag string.
 * - Trim whitespace
 * - NFC unicode normalization
 * - Lowercase
 */
export function normalizeTag(tag: string): string {
  return tag.trim().normalize("NFC").toLowerCase();
}

/**
 * Valid tag segment: lowercase letters (including unicode), digits, hyphens, dots.
 * Must start with a letter or digit.
 * \p{Ll} = lowercase letters, \p{Lo} = letters without case (CJK, etc.)
 */
const SEGMENT_REGEX = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}\-.]*$/u;

/**
 * Validate a normalized tag.
 * Returns true if tag follows the grammar:
 * - Non-empty
 * - Hierarchical segments separated by /
 * - Each segment: starts with letter/digit, followed by letters/digits/hyphens/dots
 * - No leading/trailing slashes
 * - No empty segments (double slashes)
 *
 * Note: Tag should be normalized before validation.
 */
export function validateTag(tag: string): boolean {
  // Empty check
  if (tag.length === 0) {
    return false;
  }

  // No leading/trailing slashes
  if (tag.startsWith("/") || tag.endsWith("/")) {
    return false;
  }

  // Split and validate each segment
  const segments = tag.split("/");

  for (const segment of segments) {
    // Empty segment (from double slash or leading/trailing)
    if (segment.length === 0) {
      return false;
    }

    // Validate segment format
    if (!SEGMENT_REGEX.test(segment)) {
      return false;
    }
  }

  return true;
}

/**
 * Parse a comma-separated tag filter string into an array of normalized tags.
 * Empty strings are filtered out. Does NOT validate - use parseAndValidateTagFilter for strict parsing.
 */
export function parseTagFilter(filter: string): string[] {
  if (filter.trim().length === 0) {
    return [];
  }

  return filter
    .split(",")
    .map((t) => normalizeTag(t))
    .filter((t) => t.length > 0);
}

/**
 * Parse and validate a comma-separated tag filter string.
 * Returns array of normalized, validated tags.
 * Throws Error if any tag is invalid.
 */
export function parseAndValidateTagFilter(filter: string): string[] {
  const tags = parseTagFilter(filter);

  for (const tag of tags) {
    if (!validateTag(tag)) {
      throw new Error(
        `Invalid tag: "${tag}". Tags must be lowercase, alphanumeric with hyphens/dots/slashes.`
      );
    }
  }

  return tags;
}
