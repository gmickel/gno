/**
 * Publish artifact types and builders for gno.sh export.
 *
 * @module src/publish/artifact
 */

import type { DocumentRow, TagRow } from "../store/types";

import { stripFrontmatter } from "../ingestion/frontmatter";

export type PublishVisibility =
  | "encrypted"
  | "invite-only"
  | "public"
  | "secret-link";

export interface PublishArtifactNote {
  markdown: string;
  metadata?: Record<string, string | string[]>;
  slug: string;
  summary: string;
  title: string;
}

export interface PublishArtifactSpace {
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: PublishVisibility;
}

export interface EncryptedArtifactPayload {
  ciphertext: string;
  iterations: number;
  iv: string;
  salt: string;
}

export interface EncryptedPublishArtifactSpace {
  encryptedPayload: EncryptedArtifactPayload;
  routeSlug: string;
  secretToken: string;
  sourceType: "note" | "collection";
  visibility: "encrypted";
}

export interface PublishArtifactV1 {
  exportedAt: string;
  source: string;
  spaces: PublishArtifactSpace[];
  version: 1;
}

export interface PublishArtifactV2 {
  exportedAt: string;
  source: string;
  spaces: EncryptedPublishArtifactSpace[];
  version: 2;
}

export type PublishArtifact = PublishArtifactV1 | PublishArtifactV2;

export const PUBLISH_VISIBILITY_VALUES = [
  "public",
  "secret-link",
  "invite-only",
  "encrypted",
] as const;

export const MAX_PUBLISH_SLUG_LENGTH = 80;

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

export const isPublishVisibility = (
  value: unknown
): value is PublishVisibility =>
  typeof value === "string" &&
  PUBLISH_VISIBILITY_VALUES.includes(value as PublishVisibility);

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

function toPublishSlugCandidate(value: string): string {
  return slugify(value).slice(0, MAX_PUBLISH_SLUG_LENGTH).replace(/-+$/g, "");
}

export function derivePublishSlug(
  candidates: Array<string>,
  fallback = "untitled"
): string {
  for (const candidate of candidates) {
    const slug = toPublishSlugCandidate(candidate);
    if (slug.length > 0) {
      return slug;
    }
  }

  return fallback;
}

export const normalizePublishSlug = (value: string, fallback?: string) =>
  derivePublishSlug([value], fallback);

const basenameWithoutExt = (value: string) =>
  value
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "") ?? value;

export const deriveExportedTitle = (
  doc: Pick<DocumentRow, "relPath" | "title">
) => doc.title?.trim() || basenameWithoutExt(doc.relPath);

export const deriveExportedSlug = (
  doc: Pick<DocumentRow, "relPath" | "title">
) =>
  derivePublishSlug([
    deriveExportedTitle(doc),
    doc.relPath.replace(/\.[^.]+$/, "").replaceAll("/", "-"),
  ]);

export const deriveExportedSummary = (
  markdown: string,
  metadata: Record<string, unknown>
) => {
  const metadataSummary =
    typeof metadata.description === "string"
      ? metadata.description
      : typeof metadata.summary === "string"
        ? metadata.summary
        : null;
  if (metadataSummary?.trim()) {
    return metadataSummary.trim();
  }

  const plain = stripFrontmatter(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !line.startsWith("!") &&
        !line.startsWith("```")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return plain.slice(0, 200).trim();
};

export const buildExportedMetadata = (
  doc: Pick<
    DocumentRow,
    | "author"
    | "categories"
    | "collection"
    | "contentType"
    | "frontmatterDate"
    | "languageHint"
    | "relPath"
  >,
  parsedFrontmatter: Record<string, unknown>,
  tags: TagRow[]
) => {
  const metadata: Record<string, string | string[]> = {};

  if (doc.author) {
    metadata.author = doc.author;
  }
  if (doc.contentType) {
    metadata.contentType = doc.contentType;
  }
  if (doc.languageHint) {
    metadata.language = doc.languageHint;
  }
  if (doc.frontmatterDate) {
    metadata.date = doc.frontmatterDate;
  }
  if (doc.categories?.length) {
    metadata.categories = doc.categories;
  }

  const tagValues = tags.map((tag) => tag.tag);
  if (tagValues.length) {
    metadata.tags = tagValues;
  }

  metadata.collection = doc.collection;
  metadata.sourceRelPath = doc.relPath;

  for (const [key, value] of Object.entries(parsedFrontmatter)) {
    if (
      key === "tags" ||
      key === "title" ||
      key === "summary" ||
      !ALLOWED_FRONTMATTER_METADATA_KEYS.has(key)
    ) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      metadata[key] = value.trim();
      continue;
    }
    if (Array.isArray(value)) {
      const cleaned = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (cleaned.length > 0) {
        metadata[key] = cleaned;
      }
    }
  }

  return metadata;
};

export const buildPublishArtifact = (input: {
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  source: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: PublishVisibility;
}) => ({
  exportedAt: new Date().toISOString(),
  source: input.source,
  spaces: [
    {
      homeNoteSlug: input.homeNoteSlug,
      notes: input.notes,
      routeSlug: input.routeSlug,
      sourceType: input.sourceType,
      summary: input.summary,
      title: input.title,
      visibility: input.visibility,
    },
  ],
  version: 1 as const,
});

export const buildEncryptedPublishArtifact = (input: {
  encryptedPayload: EncryptedArtifactPayload;
  routeSlug: string;
  secretToken: string;
  source: string;
  sourceType: "note" | "collection";
}) => ({
  exportedAt: new Date().toISOString(),
  source: input.source,
  spaces: [
    {
      encryptedPayload: input.encryptedPayload,
      routeSlug: input.routeSlug,
      secretToken: input.secretToken,
      sourceType: input.sourceType,
      visibility: "encrypted" as const,
    },
  ],
  version: 2 as const,
});

export const derivePublishArtifactFilename = (artifact: PublishArtifact) => {
  const routeSlug =
    artifact.spaces[0]?.routeSlug.trim() ||
    normalizePublishSlug(artifact.source, "publish-artifact");
  return `${routeSlug || "publish-artifact"}.json`;
};
