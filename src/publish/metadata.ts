/**
 * Reader-safe publish metadata projection.
 *
 * @module src/publish/metadata
 */

import type { DocumentRow, TagRow } from "../store/types";

const ALLOWED_FRONTMATTER_METADATA_KEYS = new Set([
  "audience",
  "canonical",
  "canonicalUrl",
  "canonicalURL",
  "coverAlt",
  "coverImage",
  "icon",
  "image",
  "layout",
  "publishedAt",
  "readingTime",
  "series",
  "seriesOrder",
  "status",
  "subtitle",
  "theme",
  "topic",
  "topics",
]);

const PUBLIC_URL_METADATA_KEYS = new Set([
  "canonical",
  "canonicalUrl",
  "canonicalURL",
  "coverImage",
  "image",
]);

const LOCAL_PATH_PATTERN =
  /^(?:file:|gno:\/\/|~[/\\]|[/\\]|[a-z]:[/\\]|\\\\)/iu;

const isSafeMetadataValue = (key: string, value: string): boolean => {
  if (PUBLIC_URL_METADATA_KEYS.has(key)) {
    return /^https?:\/\//iu.test(value);
  }
  return !LOCAL_PATH_PATTERN.test(value);
};

const filterReaderSafeMetadata = (
  metadata: Record<string, string | string[]>
): Record<string, string | string[]> => {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      if (isSafeMetadataValue(key, value)) {
        result[key] = value;
      }
      continue;
    }

    const safeValues = value.filter((entry) => isSafeMetadataValue(key, entry));
    if (safeValues.length > 0) {
      result[key] = safeValues;
    }
  }
  return result;
};

export const buildExportedMetadata = (
  doc: Pick<
    DocumentRow,
    "author" | "categories" | "contentType" | "frontmatterDate" | "languageHint"
  >,
  parsedFrontmatter: Record<string, unknown>,
  tags: TagRow[]
): Record<string, string | string[]> => {
  const metadata: Record<string, string | string[]> = {};

  if (doc.author) metadata.author = doc.author;
  if (doc.contentType) metadata.contentType = doc.contentType;
  if (doc.languageHint) metadata.language = doc.languageHint;
  if (doc.frontmatterDate) metadata.date = doc.frontmatterDate;
  if (doc.categories?.length) metadata.categories = doc.categories;

  const tagValues = tags.map((tag) => tag.tag);
  if (tagValues.length) metadata.tags = tagValues;

  for (const [key, value] of Object.entries(parsedFrontmatter)) {
    if (
      key === "tags" ||
      key === "title" ||
      key === "summary" ||
      !ALLOWED_FRONTMATTER_METADATA_KEYS.has(key)
    ) {
      continue;
    }
    if (
      typeof value === "string" &&
      value.trim() &&
      isSafeMetadataValue(key, value.trim())
    ) {
      metadata[key] = value.trim();
      continue;
    }
    if (Array.isArray(value)) {
      const cleaned = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && isSafeMetadataValue(key, entry));
      if (cleaned.length > 0) metadata[key] = cleaned;
    }
  }

  return filterReaderSafeMetadata(metadata);
};
