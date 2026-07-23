/**
 * Publish artifact types and builders for gno.sh export.
 *
 * @module src/publish/artifact
 */

import type { DocumentRow } from "../store/types";

import { deriveDocid } from "../app/constants";
import {
  contextCapsuleEvidenceIdentity,
  sha256Text,
} from "../core/context-capsule-validation";
import { stripFrontmatter } from "../ingestion/frontmatter";

export { buildExportedMetadata } from "./metadata";

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

export const PUBLIC_PUBLISH_MANIFEST_SCHEMA_VERSION = "1.0" as const;

export const PUBLIC_PUBLISH_CAPABILITIES = {
  capsuleEvidence: true,
  exactLineCitations: true,
  llmsTxt: true,
  markdownDocuments: true,
} as const;

export interface PublicPublishEvidence {
  docid: string;
  endLine: number;
  evidenceId: string;
  locator: string;
  mirrorHash: string;
  passageHash: string;
  sourceHash: string;
  startLine: number;
  uri: string;
}

export interface PublicPublishDocument {
  byteLength: number;
  contentHash: string;
  evidence: PublicPublishEvidence;
  lineCount: number;
  markdownPath: string;
  slug: string;
  summary: string;
  title: string;
}

export interface PublicPublishManifest {
  capabilities: typeof PUBLIC_PUBLISH_CAPABILITIES;
  documents: PublicPublishDocument[];
  generatedAt: string;
  projectionRevision: string;
  schemaVersion: typeof PUBLIC_PUBLISH_MANIFEST_SCHEMA_VERSION;
  visibility: "public";
}

interface PublishArtifactSpaceBase {
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}

export interface PublicPublishArtifactSpace extends PublishArtifactSpaceBase {
  manifest: PublicPublishManifest;
  visibility: "public";
}

export interface RestrictedPublishArtifactSpace extends PublishArtifactSpaceBase {
  manifest?: never;
  visibility: "invite-only" | "secret-link";
}

export type PublishArtifactSpace =
  | PublicPublishArtifactSpace
  | RestrictedPublishArtifactSpace;

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

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalizeJsonValue(entry)])
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));

const buildPublicPublishDocument = (
  routeSlug: string,
  note: PublishArtifactNote
): PublicPublishDocument => {
  const contentHash = sha256Text(note.markdown);
  const docid = deriveDocid(contentHash);
  const lineCount = note.markdown.split("\n").length;
  const markdownPath = `./${note.slug}.md`;
  const uri = `gno://public/${routeSlug}/${note.slug}.md`;
  const evidenceBase = {
    uri,
    docid,
    startLine: 1,
    endLine: lineCount,
    sourceHash: contentHash,
    mirrorHash: contentHash,
    passageHash: contentHash,
  };

  return {
    byteLength: new TextEncoder().encode(note.markdown).byteLength,
    contentHash,
    evidence: {
      ...evidenceBase,
      evidenceId: contextCapsuleEvidenceIdentity(evidenceBase),
      locator: `${markdownPath}#L1-L${lineCount}`,
    },
    lineCount,
    markdownPath,
    slug: note.slug,
    summary: note.summary,
    title: note.title,
  };
};

export const buildPublicPublishManifest = (input: {
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: "public";
}): PublicPublishManifest => {
  const documents = input.notes
    .map((note) => buildPublicPublishDocument(input.routeSlug, note))
    .sort(
      (left, right) =>
        compareCodeUnits(left.slug, right.slug) ||
        compareCodeUnits(left.title, right.title) ||
        compareCodeUnits(left.contentHash, right.contentHash)
    );
  const markdownPaths = documents.map((document) => document.markdownPath);
  if (new Set(markdownPaths).size !== markdownPaths.length) {
    throw new Error(
      `Public publish "${input.routeSlug}" contains duplicate Markdown paths`
    );
  }

  const revisionProjection = {
    capabilities: PUBLIC_PUBLISH_CAPABILITIES,
    documents,
    homeNoteSlug: input.homeNoteSlug ?? null,
    notes: input.notes
      .map((note) => ({
        markdown: note.markdown,
        metadata: note.metadata ?? {},
        slug: note.slug,
        summary: note.summary,
        title: note.title,
      }))
      .sort((left, right) => compareCodeUnits(left.slug, right.slug)),
    routeSlug: input.routeSlug,
    sourceType: input.sourceType,
    summary: input.summary,
    title: input.title,
    visibility: input.visibility,
  };

  return {
    capabilities: { ...PUBLIC_PUBLISH_CAPABILITIES },
    documents,
    generatedAt: input.exportedAt,
    projectionRevision: sha256Text(canonicalJson(revisionProjection)),
    schemaVersion: PUBLIC_PUBLISH_MANIFEST_SCHEMA_VERSION,
    visibility: input.visibility,
  };
};

export const buildPublishArtifact = (input: {
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: Exclude<PublishVisibility, "encrypted">;
}): PublishArtifactV1 => {
  const exportedAt = new Date().toISOString();
  const base = {
    homeNoteSlug: input.homeNoteSlug,
    notes: input.notes,
    routeSlug: input.routeSlug,
    sourceType: input.sourceType,
    summary: input.summary,
    title: input.title,
  };
  const space: PublishArtifactSpace =
    input.visibility === "public"
      ? {
          ...base,
          manifest: buildPublicPublishManifest({
            exportedAt,
            homeNoteSlug: input.homeNoteSlug,
            notes: input.notes,
            routeSlug: input.routeSlug,
            sourceType: input.sourceType,
            summary: input.summary,
            title: input.title,
            visibility: input.visibility,
          }),
          visibility: input.visibility,
        }
      : {
          ...base,
          visibility: input.visibility,
        };

  return {
    exportedAt,
    source: input.routeSlug,
    spaces: [space],
    version: 1,
  };
};

export const buildEncryptedPublishArtifact = (input: {
  encryptedPayload: EncryptedArtifactPayload;
  routeSlug: string;
  secretToken: string;
  sourceType: "note" | "collection";
}): PublishArtifactV2 => ({
  exportedAt: new Date().toISOString(),
  source: input.routeSlug,
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
