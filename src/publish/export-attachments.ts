/**
 * Shared note sanitize + v1/v2 asset finalize helpers for publish export.
 *
 * @module src/publish/export-attachments
 */

import type { EgressLineage } from "../core/egress-provenance";
import type {
  PublishArtifactNote,
  PublishArtifactV1,
  PublishArtifactV2,
} from "./artifact";
import type { AttachmentDiagnostic } from "./attachment-types";

import { stripFrontmatter } from "../ingestion/frontmatter";
import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  buildEncryptedPublishArtifact,
} from "./artifact";
import { measureArtifactUploadBytes } from "./artifact-asset-codec";
import { validatePublishAssetContract } from "./artifact-asset-validate";
import {
  attachAssetsToV1Artifact,
  buildDeterministicAssets,
  summarizeAssetEgress,
  type PendingAssetPayload,
  type PublishAssetEgressSummary,
} from "./attachment-resolver";
import { buildEncryptedArtifactPayload } from "./encrypted-export";
import {
  sanitizeObsidianMarkdown,
  sanitizePublishMarkdown,
  type SanitizeWarning,
} from "./obsidian-sanitize";

export interface NoteBuildAccumulator {
  diagnostics: AttachmentDiagnostic[];
  encodedAssetBytes: number;
  externalCount: number;
  payloads: Map<string, PendingAssetPayload>;
  preDedupRawBytes: number;
}

export async function sanitizeNoteMarkdown(input: {
  basenameIndex: Map<string, string[]> | null;
  collectionExcludes?: readonly string[];
  collectionRoot: string | null;
  existingAssetIds?: ReadonlySet<string>;
  existingEncodedAssetBytes?: number;
  noteSlug: string;
  rawMarkdown: string;
  sourceRelPath: string;
  warnings: SanitizeWarning[];
}): Promise<{
  diagnostics: AttachmentDiagnostic[];
  externalCount: number;
  markdown: string;
  payloads: Map<string, PendingAssetPayload>;
  preDedupRawBytes: number;
}> {
  if (input.basenameIndex && input.collectionRoot) {
    const sanitized = await sanitizePublishMarkdown(input.rawMarkdown, {
      basenameIndex: input.basenameIndex,
      collectionExcludes: input.collectionExcludes,
      collectionRoot: input.collectionRoot,
      existingAssetIds: input.existingAssetIds,
      existingEncodedAssetBytes: input.existingEncodedAssetBytes,
      noteSlug: input.noteSlug,
      sourceRelPath: input.sourceRelPath,
    });
    input.warnings.push(...sanitized.warnings);
    return {
      diagnostics: sanitized.diagnostics,
      externalCount: sanitized.externalCount,
      markdown: stripFrontmatter(sanitized.markdown),
      payloads: sanitized.payloads,
      preDedupRawBytes: sanitized.preDedupRawBytes,
    };
  }

  const sanitized = sanitizeObsidianMarkdown(input.rawMarkdown);
  input.warnings.push(...sanitized.warnings);
  return {
    diagnostics: [],
    externalCount: 0,
    markdown: stripFrontmatter(sanitized.markdown),
    payloads: new Map(),
    preDedupRawBytes: 0,
  };
}

export function mergePayloads(
  target: Map<string, PendingAssetPayload>,
  source: Map<string, PendingAssetPayload>
): number {
  let addedEncodedBytes = 0;
  for (const [id, payload] of source) {
    const existing = target.get(id);
    if (!existing) {
      target.set(id, {
        ...payload,
        references: [...payload.references],
      });
      addedEncodedBytes += payload.data.length;
      continue;
    }
    existing.references.push(...payload.references);
  }
  return addedEncodedBytes;
}

export function finalizeV1Artifact(
  artifact: PublishArtifactV1,
  acc: NoteBuildAccumulator
): { artifact: PublishArtifactV1; assetSummary: PublishAssetEgressSummary } {
  const assets = buildDeterministicAssets(acc.payloads);
  const withAssets = attachAssetsToV1Artifact(artifact, assets);
  const contract = validatePublishAssetContract(withAssets, {
    serializedUploadBytes: measureArtifactUploadBytes(withAssets),
  });
  if (!contract.ok) {
    throw new Error(
      `${contract.diagnostic.code}: ${contract.diagnostic.message}`
    );
  }
  const assetSummary = summarizeAssetEgress({
    artifact: withAssets,
    diagnostics: acc.diagnostics,
    externalCount: acc.externalCount,
    preDedupRawBytes: acc.preDedupRawBytes,
  });
  return { artifact: withAssets, assetSummary };
}

/** Validate assets, encrypt inside ReaderSpaceData, enforce outer upload size. */
export async function finalizeEncryptedArtifact(input: {
  acc: NoteBuildAccumulator;
  egressLineage: EgressLineage;
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  passphrase: string;
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}): Promise<{
  artifact: PublishArtifactV2;
  assetSummary: PublishAssetEgressSummary;
}> {
  const assets = buildDeterministicAssets(input.acc.payloads);
  // Probe uses a non-encrypted visibility so asset contract validation runs
  // without requiring a public manifest; ciphertext wraps the real payload.
  const space: PublishArtifactV1["spaces"][number] = {
    notes: input.notes,
    routeSlug: input.routeSlug,
    sourceType: input.sourceType,
    summary: input.summary,
    title: input.title,
    visibility: "secret-link",
  };
  if (input.homeNoteSlug !== undefined) {
    space.homeNoteSlug = input.homeNoteSlug;
  }
  const probe: PublishArtifactV1 = {
    egressLineage: input.egressLineage,
    exportedAt: input.exportedAt,
    source: input.routeSlug,
    spaces: [space],
    version: 1,
    ...(assets.length > 0
      ? {
          assets,
          requiredCapabilities: [BUNDLED_RASTER_ASSETS_CAPABILITY],
        }
      : {}),
  };
  const contract = validatePublishAssetContract(probe);
  if (!contract.ok) {
    throw new Error(
      `${contract.diagnostic.code}: ${contract.diagnostic.message}`
    );
  }

  const encrypted = await buildEncryptedArtifactPayload({
    assets,
    exportedAt: input.exportedAt,
    homeNoteSlug: input.homeNoteSlug,
    notes: input.notes,
    passphrase: input.passphrase,
    routeSlug: input.routeSlug,
    sourceType: input.sourceType,
    summary: input.summary,
    title: input.title,
  });

  const artifact = buildEncryptedPublishArtifact({
    egressLineage: input.egressLineage,
    encryptedPayload: encrypted.encryptedPayload,
    requiredCapabilities:
      assets.length > 0 ? [BUNDLED_RASTER_ASSETS_CAPABILITY] : undefined,
    routeSlug: input.routeSlug,
    secretToken: encrypted.secretToken,
    sourceType: input.sourceType,
  });

  const outerContract = validatePublishAssetContract(artifact, {
    serializedUploadBytes: measureArtifactUploadBytes(artifact),
  });
  if (!outerContract.ok) {
    throw new Error(
      `${outerContract.diagnostic.code}: ${outerContract.diagnostic.message}`
    );
  }

  const assetSummary = summarizeAssetEgress({
    assets,
    artifact,
    diagnostics: input.acc.diagnostics,
    externalCount: input.acc.externalCount,
    preDedupRawBytes: input.acc.preDedupRawBytes,
  });
  return { artifact, assetSummary };
}
