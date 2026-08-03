/**
 * Deterministic asset descriptor assembly and egress size accounting.
 *
 * @module src/publish/attachment-bundle
 */

import type { PublishArtifactV1 } from "./artifact";
import type {
  AttachmentDiagnostic,
  PendingAssetPayload,
  PublishAssetEgressSummary,
} from "./attachment-types";

import { measureArtifactUploadBytes } from "./artifact-asset-codec";
import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  MAX_PUBLISH_UPLOAD_BYTES,
  type PublishArtifactAsset,
  type PublishArtifactAssetReference,
} from "./artifact-asset-contract";

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortReferences = (
  references: PublishArtifactAssetReference[]
): PublishArtifactAssetReference[] =>
  [...references].sort(
    (a, b) =>
      compareCodeUnits(a.noteSlug, b.noteSlug) ||
      compareCodeUnits(a.sourceRef, b.sourceRef)
  );

/** Merge pending payloads across notes into deterministic asset descriptors. */
export function buildDeterministicAssets(
  payloads: Map<string, PendingAssetPayload>
): PublishArtifactAsset[] {
  const assets: PublishArtifactAsset[] = [];
  for (const id of [...payloads.keys()].sort(compareCodeUnits)) {
    const payload = payloads.get(id);
    if (!payload) continue;
    const references = sortReferences(payload.references);
    const seen = new Set<string>();
    const uniqueRefs: PublishArtifactAssetReference[] = [];
    for (const reference of references) {
      const key = `${reference.noteSlug}\0${reference.sourceRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueRefs.push(reference);
    }
    assets.push({
      byteLength: payload.byteLength,
      data: payload.data,
      encoding: "base64",
      height: payload.height,
      id: payload.sha256,
      mediaType: payload.mediaType,
      references: uniqueRefs,
      sha256: payload.sha256,
      width: payload.width,
    });
  }
  return assets;
}

export function attachAssetsToV1Artifact(
  artifact: PublishArtifactV1,
  assets: PublishArtifactAsset[]
): PublishArtifactV1 {
  if (assets.length === 0) {
    const { assets: _assets, requiredCapabilities: _caps, ...rest } = artifact;
    return rest;
  }
  return {
    ...artifact,
    assets,
    requiredCapabilities: [BUNDLED_RASTER_ASSETS_CAPABILITY],
  };
}

export function summarizeAssetEgress(input: {
  /** Optional override when assets live only inside encrypted plaintext. */
  assets?: PublishArtifactAsset[];
  artifact: unknown;
  diagnostics: AttachmentDiagnostic[];
  externalCount: number;
  preDedupRawBytes: number;
}): PublishAssetEgressSummary {
  const record =
    input.artifact && typeof input.artifact === "object"
      ? (input.artifact as { assets?: PublishArtifactAsset[] })
      : {};
  const assets =
    input.assets ?? (Array.isArray(record.assets) ? record.assets : []);
  const rawBytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  const encodedBytes = assets.reduce(
    (sum, asset) => sum + asset.data.length,
    0
  );
  const referenceCount = assets.reduce(
    (sum, asset) => sum + asset.references.length,
    0
  );
  const finalUploadBytes = measureArtifactUploadBytes(input.artifact);
  if (finalUploadBytes > MAX_PUBLISH_UPLOAD_BYTES) {
    throw new Error(
      `ENVELOPE_OVERSIZE: final serialized upload is ${finalUploadBytes} bytes; max is ${MAX_PUBLISH_UPLOAD_BYTES}`
    );
  }
  const diagnostics = [...input.diagnostics].sort(
    (a, b) =>
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.noteSlug, b.noteSlug) ||
      compareCodeUnits(a.sourceRef, b.sourceRef) ||
      compareCodeUnits(a.message, b.message)
  );
  return {
    assetCount: assets.length,
    dedupSavedBytes: Math.max(0, input.preDedupRawBytes - rawBytes),
    diagnostics,
    encodedBytes,
    externalCount: input.externalCount,
    finalUploadBytes,
    rawBytes,
    referenceCount,
  };
}

export function emptyAssetEgressSummary(
  finalUploadBytes = 0
): PublishAssetEgressSummary {
  return {
    assetCount: 0,
    dedupSavedBytes: 0,
    diagnostics: [],
    encodedBytes: 0,
    externalCount: 0,
    finalUploadBytes,
    rawBytes: 0,
    referenceCount: 0,
  };
}
