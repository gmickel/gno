/**
 * Document metadata and tag extraction from canonical Markdown.
 *
 * Pure functions shared by sync and the per-file worker (fn-198), kept out
 * of sync.ts so the worker does not load the store.
 *
 * @module src/ingestion/document-metadata
 */

import type { NormalizedContentTypeRule } from "../config";
import type { TypedMetadata } from "../core/typed-metadata";
import type { ContentTypeSource } from "./types";

import { resolveContentTypeRule } from "../config";
import { normalizeTag, validateTag } from "../core/tags";
import {
  extractHashtags,
  parseFrontmatter,
  stripFrontmatter,
} from "./frontmatter";
import { extractTypedMetadata } from "./typed-metadata";

/**
 * Extract tags from markdown content.
 * Combines frontmatter tags and inline hashtags, normalized and validated.
 */
export function extractTags(markdown: string): string[] {
  const tags = new Set<string>();

  // 1. Extract from frontmatter
  const frontmatter = parseFrontmatter(markdown);
  for (const tag of frontmatter.tags) {
    const normalized = normalizeTag(tag);
    if (validateTag(normalized)) {
      tags.add(normalized);
    }
  }

  // 2. Extract hashtags from body (after stripping frontmatter)
  const body = stripFrontmatter(markdown);
  const hashtags = extractHashtags(body);
  for (const tag of hashtags) {
    const normalized = normalizeTag(tag);
    if (validateTag(normalized)) {
      tags.add(normalized);
    }
  }

  return [...tags];
}

export interface DocumentMetadata {
  typedMetadata?: TypedMetadata;
  metadataError?: string;
  contentType?: string;
  contentTypeSource: ContentTypeSource;
  categories?: string[];
  author?: string;
  frontmatterDate?: string;
  dateFields?: Record<string, string>;
}

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".m",
  ".mm",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const AUTHOR_KEYS = ["author", "by", "owner", "creator"] as const;
const DATE_KEYS = [
  "date",
  "published",
  "published_at",
  "created",
  "created_at",
  "updated",
  "updated_at",
] as const;
const DATE_FIELD_KEY_REGEX =
  /(^|_)(date|time|created|updated|published|modified|deadline|expires|expiry|start|end)(_|$)/;

function normalizeMetadataKey(rawKey: string): string {
  return rawKey
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalizedValue =
    typeof value === "string"
      ? value.trim().replace(/^["'](.*)["']$/, "$1")
      : value;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function inferPathContentType(
  relPath: string,
  ext: string
): {
  contentType: string;
  source: ContentTypeSource;
} {
  const lowerPath = relPath.toLowerCase();
  if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
    return { contentType: "code", source: "path-ext" };
  }
  if (/(meeting|standup|retro|minutes)/.test(lowerPath)) {
    return { contentType: "meeting", source: "path-ext" };
  }
  if (/(spec|rfc|adr|design)/.test(lowerPath)) {
    return { contentType: "spec", source: "path-ext" };
  }
  if (/(notes|journal|log)/.test(lowerPath)) {
    return { contentType: "notes", source: "path-ext" };
  }
  return { contentType: "prose", source: "fallback" };
}

function normalizeFrontmatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseCategories(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((v): v is string => typeof v === "string")
      .map((v) => normalizeFrontmatterScalar(v).toLowerCase())
      .filter((v) => v.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((v) => normalizeFrontmatterScalar(v).toLowerCase())
      .filter((v) => v.length > 0);
  }
  return [];
}

export function extractDocumentMetadata(
  markdown: string,
  relPath: string,
  ext: string,
  contentTypeRules: NormalizedContentTypeRule[] = []
): DocumentMetadata {
  const parsed = parseFrontmatter(markdown);
  const metadata = parsed.metadata;
  const rawFrontmatterType =
    typeof metadata.type === "string"
      ? normalizeFrontmatterScalar(metadata.type)
      : "";
  const configuredRule = resolveContentTypeRule(
    rawFrontmatterType,
    relPath,
    contentTypeRules
  );
  const inferred = inferPathContentType(relPath, ext);
  const contentType = configuredRule?.rule.id ?? inferred.contentType;
  const contentTypeSource: ContentTypeSource =
    configuredRule?.source === "configured-id"
      ? "frontmatter-type"
      : configuredRule?.source === "prefix"
        ? "prefix"
        : inferred.source;
  const categories = new Set<string>([contentType]);

  const fmCategories = parseCategories(
    metadata.category ?? metadata.categories ?? metadata.type
  );
  for (const category of fmCategories) {
    categories.add(category);
  }

  let author: string | undefined;
  for (const key of AUTHOR_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      author = value.trim();
      break;
    }
  }

  const normalizedMetadata = new Map<string, unknown>();
  for (const [rawKey, value] of Object.entries(metadata)) {
    const key = normalizeMetadataKey(rawKey);
    if (key.length > 0 && !normalizedMetadata.has(key)) {
      normalizedMetadata.set(key, value);
    }
  }

  let frontmatterDate: string | undefined;
  for (const key of DATE_KEYS) {
    const normalized = normalizeDate(normalizedMetadata.get(key));
    if (normalized) {
      frontmatterDate = normalized;
      break;
    }
  }

  const dateFields: Record<string, string> = {};
  for (const [key, value] of normalizedMetadata.entries()) {
    if (!DATE_FIELD_KEY_REGEX.test(key)) {
      continue;
    }
    const normalized = normalizeDate(value);
    if (normalized) {
      dateFields[key] = normalized;
    }
  }

  return {
    ...extractTypedMetadata(markdown),
    contentType,
    contentTypeSource,
    categories: [...categories],
    author,
    frontmatterDate,
    dateFields: Object.keys(dateFields).length > 0 ? dateFields : undefined,
  };
}
