/**
 * Cross-repo publish artifact raster-asset contract (producer side).
 *
 * Freezes capability negotiation, sentinel grammar, byte accounting,
 * signature sniffing, visibility/lifecycle vocabulary, and fail-closed
 * diagnostics. Does not resolve filesystem attachments or deliver objects.
 *
 * Public import path remains `./artifact-assets` / `src/publish/artifact-assets`.
 *
 * @module src/publish/artifact-assets
 */

export type {
  KnownPublishRequiredCapability,
  PublishArtifactAsset,
  PublishArtifactAssetReference,
  PublishAssetClassification,
  PublishAssetContractResult,
  PublishAssetDiagnostic,
  PublishAssetDiagnosticCode,
  PublishAssetLifecycleTerminal,
  SupportedRasterMediaType,
  ValidatePublishAssetContractOptions,
} from "./artifact-asset-contract";
export {
  ASSET_DESCRIPTOR_KEYS,
  ASSET_REFERENCE_KEYS,
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  GNO_ASSET_SENTINEL_PATTERN,
  GNO_ASSET_SENTINEL_PREFIX,
  KNOWN_PUBLISH_REQUIRED_CAPABILITIES,
  MAX_PUBLISH_UPLOAD_BYTES,
  MAX_RASTER_DIMENSION_PX,
  MAX_REQUIRED_CAPABILITY_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MIN_RASTER_DIMENSION_PX,
  MIN_REQUIRED_CAPABILITY_LENGTH,
  MIN_SOURCE_REF_LENGTH,
  PUBLISH_ASSET_DIAGNOSTIC_CODES,
  PUBLISH_ASSET_LIFECYCLE_TERMINALS,
  PUBLISH_ASSET_NOTE_SLUG_PATTERN,
  PUBLISH_ASSET_VISIBILITY,
  SUPPORTED_RASTER_MEDIA_TYPES,
} from "./artifact-asset-contract";
export {
  decodeBase64ToBytes,
  measureArtifactUploadBytes,
  measureSerializedUploadBytes,
  serializePublishArtifact,
  sha256BytesHex,
} from "./artifact-asset-codec";
export {
  formatGnoAssetSentinel,
  matchGnoAssetTokens,
  parseGnoAssetSentinel,
  sniffRasterMediaType,
} from "./artifact-asset-sniff";
export { validatePublishAssetContract } from "./artifact-asset-validate";
