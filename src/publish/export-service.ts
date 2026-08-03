/**
 * Core publish export service used by CLI and local web UI.
 *
 * @module src/publish/export-service
 */

import type { Collection } from "../config/types";
import type { DocumentRow, StorePort, TagRow } from "../store/types";

import { enforceCollectionEgressWithAudit } from "../core/egress-enforcement";
import { parseRef } from "../core/ref-parser";
import { parseFrontmatter } from "../ingestion/frontmatter";
import { getContentBatch } from "../store/content-batch";
import {
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
import {
  buildAttachmentBasenameIndex,
  type PublishAssetEgressSummary,
} from "./attachment-resolver";
import {
  finalizeEncryptedArtifact,
  finalizeV1Artifact,
  mergePayloads,
  sanitizeNoteMarkdown,
  type NoteBuildAccumulator,
} from "./export-attachments";
import {
  isPublishDisabledByFrontmatter,
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
): Promise<{
  artifact: PublishArtifact;
  assetSummary: PublishAssetEgressSummary;
} | null> {
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

  const contentResult = await getContentBatch(
    store,
    activeDocs
      .map((doc) => doc.mirrorHash)
      .filter((mirrorHash): mirrorHash is string => Boolean(mirrorHash))
  );
  if (!contentResult.ok) {
    throw new Error(contentResult.error.message);
  }

  const tagsResult = await store.getTagsBatch(activeDocs.map((doc) => doc.id));
  if (!tagsResult.ok) {
    throw new Error(tagsResult.error.message);
  }

  const contentByHash = contentResult.value;
  const tagsByDocId = tagsResult.value;
  const visibility = resolveVisibility(options.visibility);
  const basenameIndex = await buildAttachmentBasenameIndex(
    collection.path,
    collection.exclude
  );

  const acc: NoteBuildAccumulator = {
    diagnostics: [],
    encodedAssetBytes: 0,
    externalCount: 0,
    payloads: new Map(),
    preDedupRawBytes: 0,
  };
  const notes: PublishArtifactNote[] = [];

  for (const doc of activeDocs) {
    if (!doc.mirrorHash) {
      throw new Error(`Document has no converted content: ${doc.uri}`);
    }
    const rawMarkdown = contentByHash.get(doc.mirrorHash);
    if (rawMarkdown === undefined) {
      throw new Error(`Unable to load content for ${doc.uri}`);
    }
    if (isPublishDisabledByFrontmatter(rawMarkdown)) {
      continue;
    }

    const frontmatter = parseFrontmatter(rawMarkdown).metadata;
    const title = deriveExportedTitle(doc);
    const slug = deriveExportedSlug(doc);
    const sanitized = await sanitizeNoteMarkdown({
      basenameIndex,
      collectionExcludes: collection.exclude,
      collectionRoot: collection.path,
      existingAssetIds: new Set(acc.payloads.keys()),
      existingEncodedAssetBytes: acc.encodedAssetBytes,
      noteSlug: slug,
      rawMarkdown,
      sourceRelPath: doc.relPath,
      warnings,
    });
    acc.diagnostics.push(...sanitized.diagnostics);
    acc.externalCount += sanitized.externalCount;
    acc.preDedupRawBytes += sanitized.preDedupRawBytes;
    acc.encodedAssetBytes += mergePayloads(acc.payloads, sanitized.payloads);
    notes.push({
      markdown: sanitized.markdown,
      metadata: buildExportedMetadata(
        doc,
        frontmatter,
        tagsByDocId.get(doc.id) ?? []
      ),
      slug,
      summary: deriveExportedSummary(sanitized.markdown, frontmatter),
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
  const { lineage } = await enforceCollectionEgressWithAudit({
    collections,
    collectionNames: [collection.name],
    action: "export",
    destinationZone: "local_process",
    caller: { authenticated: true, operationAuthorized: true },
    contentClass: "source",
    store,
  });

  if (visibility === "encrypted") {
    if (!options.encryptionPassphrase) {
      throw new Error(
        "Encrypted publish export requires --passphrase or encryptionPassphrase."
      );
    }

    return finalizeEncryptedArtifact({
      acc,
      egressLineage: lineage,
      exportedAt: new Date().toISOString(),
      homeNoteSlug: chooseHomeNoteSlug(notes),
      notes,
      passphrase: options.encryptionPassphrase,
      routeSlug,
      sourceType: "collection",
      summary,
      title,
    });
  }

  return finalizeV1Artifact(
    buildPublishArtifact({
      egressLineage: lineage,
      homeNoteSlug: chooseHomeNoteSlug(notes),
      notes,
      routeSlug,
      sourceType: "collection",
      summary,
      title,
      visibility,
    }),
    acc
  );
}

async function exportDocumentArtifact(
  store: StorePort,
  collections: Collection[],
  target: string,
  options: PublishExportCoreOptions,
  warnings: SanitizeWarning[]
): Promise<{
  artifact: PublishArtifact;
  assetSummary: PublishAssetEgressSummary;
}> {
  const doc = await lookupDocument(store, target);
  if (!doc?.active) {
    throw new Error(`Document not found: ${target}`);
  }

  const collection =
    collections.find((entry) => entry.name === doc.collection) ?? null;
  const rawMarkdown = await loadDocumentMarkdown(store, doc);
  if (isPublishDisabledByFrontmatter(rawMarkdown)) {
    throw new Error(
      `Refused to export: ${doc.uri} has publish: false in frontmatter`
    );
  }

  const frontmatter = parseFrontmatter(rawMarkdown).metadata;
  const title = options.title ?? deriveExportedTitle(doc);
  const slug = deriveExportedSlug(doc);
  const visibility = resolveVisibility(options.visibility);
  const bundleAttachments = collection !== null;
  const basenameIndex =
    bundleAttachments && collection
      ? await buildAttachmentBasenameIndex(collection.path, collection.exclude)
      : null;

  const sanitized = await sanitizeNoteMarkdown({
    basenameIndex,
    collectionExcludes: collection?.exclude,
    collectionRoot: bundleAttachments && collection ? collection.path : null,
    noteSlug: slug,
    rawMarkdown,
    sourceRelPath: doc.relPath,
    warnings,
  });
  const markdown = sanitized.markdown;
  const summary =
    options.summary ?? deriveExportedSummary(markdown, frontmatter);
  const tags = await loadDocumentTags(store, doc);
  const routeSlug = derivePublishSlug([options.routeSlug ?? "", slug, target]);
  const { lineage } = await enforceCollectionEgressWithAudit({
    collections,
    collectionNames: [doc.collection],
    action: "export",
    destinationZone: "local_process",
    caller: { authenticated: true, operationAuthorized: true },
    contentClass: "source",
    store,
  });

  const note: PublishArtifactNote = {
    markdown,
    metadata: buildExportedMetadata(doc, frontmatter, tags),
    slug,
    summary,
    title,
  };

  const acc: NoteBuildAccumulator = {
    diagnostics: sanitized.diagnostics,
    encodedAssetBytes: [...sanitized.payloads.values()].reduce(
      (total, payload) => total + payload.data.length,
      0
    ),
    externalCount: sanitized.externalCount,
    payloads: sanitized.payloads,
    preDedupRawBytes: sanitized.preDedupRawBytes,
  };

  if (visibility === "encrypted") {
    if (!options.encryptionPassphrase) {
      throw new Error(
        "Encrypted publish export requires --passphrase or encryptionPassphrase."
      );
    }

    return finalizeEncryptedArtifact({
      acc,
      egressLineage: lineage,
      exportedAt: new Date().toISOString(),
      notes: [note],
      passphrase: options.encryptionPassphrase,
      routeSlug,
      sourceType: "note",
      summary,
      title,
    });
  }

  return finalizeV1Artifact(
    buildPublishArtifact({
      egressLineage: lineage,
      notes: [note],
      routeSlug,
      sourceType: "note",
      summary,
      title,
      visibility,
    }),
    acc
  );
}

export interface ExportPublishArtifactResult {
  artifact: PublishArtifact;
  assetSummary: PublishAssetEgressSummary;
  warnings: SanitizeWarning[];
}

export async function exportPublishArtifact(input: {
  collections: Collection[];
  options: PublishExportCoreOptions;
  store: StorePort;
  target: string;
}): Promise<ExportPublishArtifactResult> {
  const warnings: SanitizeWarning[] = [];
  const collectionExport = await exportCollectionArtifact(
    input.store,
    input.collections,
    input.target,
    input.options,
    warnings
  );
  const result =
    collectionExport ??
    (await exportDocumentArtifact(
      input.store,
      input.collections,
      input.target,
      input.options,
      warnings
    ));
  return {
    artifact: result.artifact,
    assetSummary: result.assetSummary,
    warnings,
  };
}
