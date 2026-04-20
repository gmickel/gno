/**
 * Core publish export service used by CLI and local web UI.
 *
 * @module src/publish/export-service
 */

import type { Collection } from "../config/types";
import type { DocumentRow, StorePort, TagRow } from "../store/types";

import { parseRef } from "../cli/commands/ref-parser";
import { parseFrontmatter } from "../ingestion/frontmatter";
import {
  buildEncryptedPublishArtifact,
  buildPublishArtifact,
  buildExportedMetadata,
  derivePublishSlug,
  deriveExportedSlug,
  deriveExportedSummary,
  deriveExportedTitle,
  isPublishVisibility,
  type PublishArtifact,
  type PublishArtifactNote,
  type PublishVisibility,
} from "./artifact";
import { buildEncryptedArtifactPayload } from "./encrypted-export";
import {
  isPublishDisabledByFrontmatter,
  sanitizeObsidianMarkdown,
  type SanitizeWarning,
} from "./obsidian-sanitize";

export interface PublishExportCoreOptions {
  encryptionPassphrase?: string;
  routeSlug?: string;
  summary?: string;
  title?: string;
  visibility?: PublishVisibility;
}

function resolveVisibility(visibility?: string): PublishVisibility {
  if (visibility === undefined) {
    return "public";
  }
  if (!isPublishVisibility(visibility)) {
    throw new Error(
      `Invalid visibility: ${visibility}. Must be public, secret-link, invite-only, or encrypted.`
    );
  }
  return visibility;
}

async function lookupDocument(
  store: StorePort,
  ref: string
): Promise<DocumentRow | null> {
  const parsed = parseRef(ref);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  switch (parsed.type) {
    case "docid": {
      const result = await store.getDocumentByDocid(parsed.value);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    }
    case "uri": {
      const result = await store.getDocumentByUri(parsed.value);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    }
    case "collPath": {
      if (!(parsed.collection && parsed.relPath)) {
        return null;
      }
      const result = await store.getDocument(parsed.collection, parsed.relPath);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    }
  }
}

async function loadDocumentMarkdown(
  store: StorePort,
  doc: DocumentRow
): Promise<string> {
  if (!doc.mirrorHash) {
    throw new Error(`Document has no converted content: ${doc.uri}`);
  }

  const result = await store.getContent(doc.mirrorHash);
  if (!result.ok || !result.value) {
    throw new Error(`Unable to load content for ${doc.uri}`);
  }

  return result.value;
}

async function loadDocumentTags(
  store: StorePort,
  doc: DocumentRow
): Promise<TagRow[]> {
  const result = await store.getTagsForDoc(doc.id);
  if (!result.ok) {
    throw new Error(
      `Unable to load tags for ${doc.uri}: ${result.error.message}`
    );
  }

  return result.value;
}

function chooseHomeNoteSlug(notes: PublishArtifactNote[]) {
  const preferred = notes.find((note) =>
    ["home", "index", "readme"].includes(note.slug)
  );
  return preferred?.slug ?? notes[0]?.slug;
}

function resolveCollection(
  collections: Collection[],
  target: string
): Collection | null {
  return collections.find((collection) => collection.name === target) ?? null;
}

async function exportCollectionArtifact(
  store: StorePort,
  collections: Collection[],
  target: string,
  options: PublishExportCoreOptions,
  warnings: SanitizeWarning[]
) {
  const collection = resolveCollection(collections, target);
  if (!collection) {
    return null;
  }

  const docsResult = await store.listDocuments(collection.name);
  if (!docsResult.ok) {
    throw new Error(docsResult.error.message);
  }

  const activeDocs = docsResult.value
    .filter((doc) => doc.active)
    .sort((left, right) => left.uri.localeCompare(right.uri));

  if (activeDocs.length === 0) {
    throw new Error(`Collection "${collection.name}" has no active documents`);
  }

  const notes: PublishArtifactNote[] = [];
  for (const doc of activeDocs) {
    const rawMarkdown = await loadDocumentMarkdown(store, doc);
    if (isPublishDisabledByFrontmatter(rawMarkdown)) {
      continue;
    }
    const sanitized = sanitizeObsidianMarkdown(rawMarkdown);
    warnings.push(...sanitized.warnings);
    const markdown = sanitized.markdown;
    const tags = await loadDocumentTags(store, doc);
    const frontmatter = parseFrontmatter(markdown).metadata;
    const title = deriveExportedTitle(doc);
    notes.push({
      markdown,
      metadata: buildExportedMetadata(doc, frontmatter, tags),
      slug: deriveExportedSlug(doc),
      summary: deriveExportedSummary(markdown, frontmatter),
      title,
    });
  }

  if (notes.length === 0) {
    throw new Error(
      `Collection "${collection.name}" has no publishable documents (all notes carry publish: false frontmatter)`
    );
  }

  const title = options.title ?? collection.name;
  const summary =
    options.summary ??
    `Published snapshot of the ${collection.name} collection from local GNO.`;
  const routeSlug = derivePublishSlug([
    options.routeSlug ?? "",
    collection.name,
    target,
  ]);
  const visibility = resolveVisibility(options.visibility);

  if (visibility === "encrypted") {
    if (!options.encryptionPassphrase) {
      throw new Error(
        "Encrypted publish export requires --passphrase or encryptionPassphrase."
      );
    }

    const encrypted = await buildEncryptedArtifactPayload({
      exportedAt: new Date().toISOString(),
      homeNoteSlug: chooseHomeNoteSlug(notes),
      notes,
      passphrase: options.encryptionPassphrase,
      routeSlug,
      sourceType: "collection",
      summary,
      title,
    });

    return buildEncryptedPublishArtifact({
      encryptedPayload: encrypted.encryptedPayload,
      routeSlug,
      secretToken: encrypted.secretToken,
      source: collection.name,
      sourceType: "collection",
    });
  }

  return buildPublishArtifact({
    homeNoteSlug: chooseHomeNoteSlug(notes),
    notes,
    routeSlug,
    source: collection.name,
    sourceType: "collection",
    summary,
    title,
    visibility,
  });
}

async function exportDocumentArtifact(
  store: StorePort,
  target: string,
  options: PublishExportCoreOptions,
  warnings: SanitizeWarning[]
) {
  const doc = await lookupDocument(store, target);
  if (!doc?.active) {
    throw new Error(`Document not found: ${target}`);
  }

  const rawMarkdown = await loadDocumentMarkdown(store, doc);
  if (isPublishDisabledByFrontmatter(rawMarkdown)) {
    throw new Error(
      `Refused to export: ${doc.uri} has publish: false in frontmatter`
    );
  }
  const sanitized = sanitizeObsidianMarkdown(rawMarkdown);
  warnings.push(...sanitized.warnings);
  const markdown = sanitized.markdown;
  const tags = await loadDocumentTags(store, doc);
  const frontmatter = parseFrontmatter(markdown).metadata;
  const title = options.title ?? deriveExportedTitle(doc);
  const summary =
    options.summary ?? deriveExportedSummary(markdown, frontmatter);
  const slug = deriveExportedSlug(doc);
  const visibility = resolveVisibility(options.visibility);
  const routeSlug = derivePublishSlug([options.routeSlug ?? "", slug, target]);

  if (visibility === "encrypted") {
    if (!options.encryptionPassphrase) {
      throw new Error(
        "Encrypted publish export requires --passphrase or encryptionPassphrase."
      );
    }

    const encrypted = await buildEncryptedArtifactPayload({
      exportedAt: new Date().toISOString(),
      notes: [
        {
          markdown,
          metadata: buildExportedMetadata(doc, frontmatter, tags),
          slug,
          summary,
          title,
        },
      ],
      passphrase: options.encryptionPassphrase,
      routeSlug,
      sourceType: "note",
      summary,
      title,
    });

    return buildEncryptedPublishArtifact({
      encryptedPayload: encrypted.encryptedPayload,
      routeSlug,
      secretToken: encrypted.secretToken,
      source: doc.uri,
      sourceType: "note",
    });
  }

  return buildPublishArtifact({
    notes: [
      {
        markdown,
        metadata: buildExportedMetadata(doc, frontmatter, tags),
        slug,
        summary,
        title,
      },
    ],
    routeSlug,
    source: doc.uri,
    sourceType: "note",
    summary,
    title,
    visibility,
  });
}

export interface ExportPublishArtifactResult {
  artifact: PublishArtifact;
  warnings: SanitizeWarning[];
}

export async function exportPublishArtifact(input: {
  collections: Collection[];
  options: PublishExportCoreOptions;
  store: StorePort;
  target: string;
}): Promise<ExportPublishArtifactResult> {
  const warnings: SanitizeWarning[] = [];
  const artifact =
    (await exportCollectionArtifact(
      input.store,
      input.collections,
      input.target,
      input.options,
      warnings
    )) ??
    (await exportDocumentArtifact(
      input.store,
      input.target,
      input.options,
      warnings
    ));
  return { artifact, warnings };
}
