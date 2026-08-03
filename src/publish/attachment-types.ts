/**
 * Shared attachment diagnostic and payload types for publish export.
 *
 * @module src/publish/attachment-types
 */

import type {
  PublishArtifactAsset,
  PublishArtifactAssetReference,
  PublishAssetDiagnosticCode,
} from "./artifact-asset-contract";

export type AttachmentDiagnosticCode =
  | PublishAssetDiagnosticCode
  | "ASSET_AMBIGUOUS"
  | "ASSET_EXTERNAL";

export interface AttachmentDiagnostic {
  code: AttachmentDiagnosticCode;
  message: string;
  noteSlug: string;
  sourceRef: string;
}

export interface PublishAssetEgressSummary {
  assetCount: number;
  dedupSavedBytes: number;
  diagnostics: AttachmentDiagnostic[];
  encodedBytes: number;
  externalCount: number;
  finalUploadBytes: number;
  rawBytes: number;
  referenceCount: number;
}

export interface PendingAssetPayload {
  byteLength: number;
  data: string;
  height: number;
  mediaType: PublishArtifactAsset["mediaType"];
  references: PublishArtifactAssetReference[];
  sha256: string;
  width: number;
}

export interface AttachmentResolveContext {
  basenameIndex: Map<string, string[]>;
  collectionExcludes?: readonly string[];
  collectionRoot: string;
  existingAssetIds?: ReadonlySet<string>;
  existingEncodedAssetBytes?: number;
  noteSlug: string;
  sourceRelPath: string;
}
