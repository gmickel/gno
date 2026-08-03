/**
 * Shared note sanitize + v1 asset finalize helpers for publish export.
 *
 * @module src/publish/export-attachments
 */

import type { PublishArtifactV1 } from "./artifact";
import type { AttachmentDiagnostic } from "./attachment-types";

import { stripFrontmatter } from "../ingestion/frontmatter";
import { measureArtifactUploadBytes } from "./artifact-asset-codec";
import { validatePublishAssetContract } from "./artifact-asset-validate";
import {
  attachAssetsToV1Artifact,
  buildDeterministicAssets,
  summarizeAssetEgress,
  type PendingAssetPayload,
  type PublishAssetEgressSummary,
} from "./attachment-resolver";
import {
  sanitizeObsidianMarkdown,
  sanitizePublishMarkdown,
  type SanitizeWarning,
} from "./obsidian-sanitize";

export interface NoteBuildAccumulator {
  diagnostics: AttachmentDiagnostic[];
  externalCount: number;
  payloads: Map<string, PendingAssetPayload>;
  preDedupRawBytes: number;
}

export async function sanitizeNoteMarkdown(input: {
  basenameIndex: Map<string, string[]> | null;
  collectionRoot: string | null;
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
      collectionRoot: input.collectionRoot,
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
): void {
  for (const [id, payload] of source) {
    const existing = target.get(id);
    if (!existing) {
      target.set(id, {
        ...payload,
        references: [...payload.references],
      });
      continue;
    }
    existing.references.push(...payload.references);
  }
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
