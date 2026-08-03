/**
 * Shared publish-asset contract vocabulary (producer/consumer).
 *
 * @module src/publish/artifact-asset-contract
 */

export const MAX_PUBLISH_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Schema bounds for asset reference sourceRef (publish-artifact.schema.json). */
export const MIN_SOURCE_REF_LENGTH = 1;
export const MAX_SOURCE_REF_LENGTH = 1024;

export const BUNDLED_RASTER_ASSETS_CAPABILITY =
  "bundled-raster-assets@1" as const;

export const KNOWN_PUBLISH_REQUIRED_CAPABILITIES = [
  BUNDLED_RASTER_ASSETS_CAPABILITY,
] as const;

/** Schema bounds for requiredCapabilities entries (publish-artifact.schema.json). */
export const MIN_REQUIRED_CAPABILITY_LENGTH = 1;
export const MAX_REQUIRED_CAPABILITY_LENGTH = 128;

export type KnownPublishRequiredCapability =
  (typeof KNOWN_PUBLISH_REQUIRED_CAPABILITIES)[number];

export const SUPPORTED_RASTER_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export type SupportedRasterMediaType =
  (typeof SUPPORTED_RASTER_MEDIA_TYPES)[number];

export const MAX_RASTER_DIMENSION_PX = 16_384;
export const MIN_RASTER_DIMENSION_PX = 1;

/** Strict sentinel: scheme + lowercase SHA-256 hex asset id. */
export const GNO_ASSET_SENTINEL_PATTERN = /^gno-asset:([a-f0-9]{64})$/u;
export const GNO_ASSET_SENTINEL_PREFIX = "gno-asset:";

export const PUBLISH_ASSET_NOTE_SLUG_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;

export const PUBLISH_ASSET_VISIBILITY = {
  public: {
    class: "public",
    delivery: "immutable-public-url",
    storage: "private-until-public-commit",
    notes:
      "Validated assets may use immutable public URLs only after the share is classified public.",
  },
  "secret-link": {
    class: "secret",
    delivery: "capability-authorized",
    storage: "private",
    forbids: ["public-object-url", "presigned-url-as-sole-authorization"],
    notes:
      "Secret is an authorization boundary; private storage delivery requires the secret-share capability.",
  },
  encrypted: {
    class: "encrypted",
    delivery: "client-blob-url",
    storage: "none-plaintext",
    assetPlacement: "encrypted-client-payload",
    notes:
      "Plaintext image bytes remain inside the encrypted client payload; Blob URLs are revoked on replacement/unmount.",
  },
} as const;

export const PUBLISH_ASSET_LIFECYCLE_TERMINALS = [
  "committed",
  "rolled_back",
  "deleted",
  "orphan_cleaned",
  "idempotent_noop",
] as const;

export type PublishAssetLifecycleTerminal =
  (typeof PUBLISH_ASSET_LIFECYCLE_TERMINALS)[number];

export const PUBLISH_ASSET_DIAGNOSTIC_CODES = [
  "ASSET_MISSING",
  "ASSET_CONFLICT",
  "ASSET_SENTINEL_RAW",
  "ASSET_SENTINEL_UNRESOLVED",
  "ASSET_SENTINEL_INVALID",
  "ASSET_TRAVERSAL",
  "ASSET_MIME_SPOOF",
  "ASSET_OVERSIZE",
  "ASSET_CORRUPT",
  "ASSET_UNSUPPORTED_FORMAT",
  "ASSET_DIMENSION_INVALID",
  "CAPABILITY_UNSUPPORTED",
  "ENVELOPE_OVERSIZE",
] as const;

export type PublishAssetDiagnosticCode =
  (typeof PUBLISH_ASSET_DIAGNOSTIC_CODES)[number];

export interface PublishArtifactAssetReference {
  noteSlug: string;
  sourceRef: string;
}

export interface PublishArtifactAsset {
  byteLength: number;
  data: string;
  encoding: "base64";
  height: number;
  id: string;
  mediaType: string;
  references: Array<PublishArtifactAssetReference>;
  sha256: string;
  width: number;
}

export interface PublishAssetDiagnostic {
  code: PublishAssetDiagnosticCode;
  message: string;
}

export type PublishAssetClassification =
  | "asset-free"
  | "bundled-raster-v1"
  | "encrypted-client-payload";

export type PublishAssetContractResult =
  | { ok: true; classification: PublishAssetClassification }
  | { ok: false; diagnostic: PublishAssetDiagnostic };

export interface ValidatePublishAssetContractOptions {
  /** Exact UTF-8 byte length of the final upload body when already serialized. */
  serializedUploadBytes?: number;
}

export const ASSET_DESCRIPTOR_KEYS = [
  "byteLength",
  "data",
  "encoding",
  "height",
  "id",
  "mediaType",
  "references",
  "sha256",
  "width",
] as const;

export const ASSET_REFERENCE_KEYS = ["noteSlug", "sourceRef"] as const;
