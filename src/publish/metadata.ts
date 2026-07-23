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

const FORBIDDEN_URI_TOKEN_PATTERN =
  /(?:^|[^a-z0-9+.-])(?:file:(?:\/\/)?|gno:\/\/)/iu;
const LOCAL_PATH_TOKEN_PATTERN =
  /(?:^|[\s([{"'=,:;])(?:~[/\\]|[a-z]:[/\\]|\\\\[^\\/\s]+[/\\]|\/(?:Applications|bin|dev|etc|home|Library|mnt|opt|private|proc|root|srv|sys|System|tmp|Users|usr|var|Volumes)(?:[/\\]|$))/iu;
const LOCAL_HOSTNAME_SUFFIX_PATTERN =
  /(?:^|\.)(?:home|internal|lan|local|localhost)$/iu;

const containsLocalReference = (value: string): boolean =>
  FORBIDDEN_URI_TOKEN_PATTERN.test(value) ||
  LOCAL_PATH_TOKEN_PATTERN.test(value);

const isNonPublicIpv4 = (hostname: string): boolean => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [first = 0, second = 0, third = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
};

const isNonPublicIpv6 = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  return (
    normalized === "::" ||
    normalized.startsWith("::") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
};

const isPublicHttpUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return false;
  }

  const hostname = url.hostname.replace(/\.$/u, "").toLowerCase();
  if (
    hostname.length === 0 ||
    LOCAL_HOSTNAME_SUFFIX_PATTERN.test(hostname) ||
    isNonPublicIpv4(hostname) ||
    isNonPublicIpv6(hostname)
  ) {
    return false;
  }

  const isIpLiteral =
    hostname.includes(":") || /^\d+(?:\.\d+){3}$/u.test(hostname);
  return isIpLiteral || hostname.includes(".");
};

const isSafeMetadataValue = (key: string, value: string): boolean => {
  if (containsLocalReference(value)) {
    return false;
  }
  if (
    PUBLIC_URL_METADATA_KEYS.has(key) ||
    (key === "icon" && /^https?:\/\//iu.test(value))
  ) {
    return isPublicHttpUrl(value);
  }
  return true;
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
