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

export interface PublishArtifact {
  exportedAt: string;
  source: string;
  spaces: PublishArtifactSpace[];
  version: 1;
}

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

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
) => {
  const titleSlug = slugify(deriveExportedTitle(doc));
  if (titleSlug.length > 0) {
    return titleSlug;
  }

  return slugify(doc.relPath.replace(/\.[^.]+$/, "").replaceAll("/", "-"));
};

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
    if (key === "tags" || key === "title" || key === "summary") {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      metadata[key] = value.trim();
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

export const derivePublishArtifactFilename = (artifact: PublishArtifact) => {
  const routeSlug =
    artifact.spaces[0]?.routeSlug.trim() || slugify(artifact.source);
  return `${routeSlug || "publish-artifact"}.json`;
};
