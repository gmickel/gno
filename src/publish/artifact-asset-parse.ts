/**
 * Closed-object parsing and sourceRef threat checks for publish assets.
 *
 * @module src/publish/artifact-asset-parse
 */

import { decodeBase64ToBytes, sha256BytesHex } from "./artifact-asset-codec";
import {
  ASSET_DESCRIPTOR_KEYS,
  ASSET_REFERENCE_KEYS,
  KNOWN_PUBLISH_REQUIRED_CAPABILITIES,
  MAX_PUBLISH_UPLOAD_BYTES,
  MAX_RASTER_DIMENSION_PX,
  MAX_REQUIRED_CAPABILITY_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MIN_RASTER_DIMENSION_PX,
  MIN_REQUIRED_CAPABILITY_LENGTH,
  MIN_SOURCE_REF_LENGTH,
  PUBLISH_ASSET_NOTE_SLUG_PATTERN,
  SUPPORTED_RASTER_MEDIA_TYPES,
  type PublishArtifactAsset,
  type PublishArtifactAssetReference,
  type PublishAssetDiagnostic,
  type PublishAssetDiagnosticCode,
  type SupportedRasterMediaType,
} from "./artifact-asset-contract";
import { parseGnoAssetSentinel } from "./artifact-asset-sniff";
import { discoverImageOccurrences } from "./attachment-discover";
import { validateRasterBytesStructural } from "./attachment-raster";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)|^\/|^[a-zA-Z]:[\\/]/u;
const ABSOLUTE_PATTERN = /^(?:\/|\\|[a-zA-Z]:[\\/])/u;

export type ContractFailure = {
  ok: false;
  diagnostic: PublishAssetDiagnostic;
};

export const fail = (
  code: PublishAssetDiagnosticCode,
  message: string
): ContractFailure => ({
  ok: false,
  diagnostic: { code, message },
});

const isSupportedMediaType = (
  value: string
): value is SupportedRasterMediaType =>
  (SUPPORTED_RASTER_MEDIA_TYPES as ReadonlyArray<string>).includes(value);

const sortedKeysEqual = (
  keys: Array<string>,
  expected: ReadonlyArray<string>
): boolean =>
  JSON.stringify([...keys].sort()) === JSON.stringify([...expected].sort());

export const collectMarkdownSentinels = (
  markdown: string
): ContractFailure | { ok: true; ids: Set<string> } => {
  const ids = new Set<string>();
  for (const occurrence of discoverImageOccurrences(markdown, {
    excludeFrontmatter: false,
  })) {
    const sourceRef = occurrence.sourceRef;
    if (!sourceRef.startsWith("gno-asset:")) continue;
    const parsed = parseGnoAssetSentinel(sourceRef);
    if (!parsed.ok) {
      return fail(
        "ASSET_SENTINEL_INVALID",
        `Invalid gno-asset sentinel grammar: "${sourceRef}"`
      );
    }
    ids.add(parsed.assetId);
  }
  return { ok: true, ids };
};

const expandSourceRefForms = (sourceRef: string): Array<string> => {
  const forms = [sourceRef];
  let current = sourceRef;
  for (let round = 0; round < 4; round += 1) {
    if (!/%[0-9a-fA-F]{2}/u.test(current)) break;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      forms.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return forms;
};

const validateSourceRef = (
  sourceRef: string,
  field: string
): ContractFailure | null => {
  if (typeof sourceRef !== "string") {
    return fail("ASSET_CORRUPT", `${field} must be a string`);
  }
  // Enforce schema 1..1024 bound before percent-decode / traversal normalization.
  // JSON Schema maxLength counts Unicode code points, not UTF-16 code units.
  const sourceRefLength = Array.from(sourceRef).length;
  if (
    sourceRefLength < MIN_SOURCE_REF_LENGTH ||
    sourceRefLength > MAX_SOURCE_REF_LENGTH
  ) {
    return fail(
      "ASSET_CORRUPT",
      `${field} must be ${MIN_SOURCE_REF_LENGTH}..${MAX_SOURCE_REF_LENGTH} characters`
    );
  }
  if (sourceRef.trim().length === 0) {
    return fail("ASSET_TRAVERSAL", `${field} must not be blank`);
  }
  for (const form of expandSourceRefForms(sourceRef)) {
    if (
      form.includes("\0") ||
      TRAVERSAL_PATTERN.test(form) ||
      ABSOLUTE_PATTERN.test(form)
    ) {
      return fail(
        "ASSET_TRAVERSAL",
        `${field} escapes the approved collection root`
      );
    }
  }
  return null;
};

const readClosedReference = (
  value: unknown,
  field: string
): ContractFailure | { ok: true; reference: PublishArtifactAssetReference } => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return fail("ASSET_CORRUPT", `${field} must be a closed object`);
  }
  const record = value as Record<string, unknown>;
  if (!sortedKeysEqual(Object.keys(record), ASSET_REFERENCE_KEYS)) {
    return fail("ASSET_CORRUPT", `${field} contains unknown or missing fields`);
  }
  if (typeof record.noteSlug !== "string" || record.noteSlug.trim() === "") {
    return fail(
      "ASSET_CORRUPT",
      `${field}.noteSlug must be a non-empty string`
    );
  }
  if (!PUBLISH_ASSET_NOTE_SLUG_PATTERN.test(record.noteSlug)) {
    return fail(
      "ASSET_CORRUPT",
      `${field}.noteSlug must match publish note slug syntax`
    );
  }
  if (typeof record.sourceRef !== "string") {
    return fail("ASSET_CORRUPT", `${field}.sourceRef must be a string`);
  }
  const traversal = validateSourceRef(record.sourceRef, `${field}.sourceRef`);
  if (traversal) return traversal;
  return {
    ok: true,
    reference: {
      noteSlug: record.noteSlug,
      sourceRef: record.sourceRef,
    },
  };
};

const readClosedAsset = (
  value: unknown,
  index: number
): ContractFailure | { ok: true; asset: PublishArtifactAsset } => {
  const field = `assets[${index}]`;
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return fail("ASSET_CORRUPT", `${field} must be a closed object`);
  }
  const record = value as Record<string, unknown>;
  if (!sortedKeysEqual(Object.keys(record), ASSET_DESCRIPTOR_KEYS)) {
    return fail("ASSET_CORRUPT", `${field} contains unknown or missing fields`);
  }

  if (typeof record.id !== "string" || typeof record.sha256 !== "string") {
    return fail(
      "ASSET_CORRUPT",
      `${field} id/sha256 must be lowercase SHA-256 hex`
    );
  }
  if (
    !SHA256_HEX_PATTERN.test(record.id) ||
    !SHA256_HEX_PATTERN.test(record.sha256)
  ) {
    return fail(
      "ASSET_CORRUPT",
      `${field} id/sha256 must be lowercase SHA-256 hex`
    );
  }
  if (record.id !== record.sha256) {
    return fail(
      "ASSET_CONFLICT",
      `${field} id must equal sha256 of payload bytes`
    );
  }
  if (record.encoding !== "base64") {
    return fail("ASSET_CORRUPT", `${field}.encoding must be "base64"`);
  }
  if (
    typeof record.byteLength !== "number" ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1
  ) {
    return fail(
      "ASSET_CORRUPT",
      `${field}.byteLength must be a positive integer`
    );
  }
  if (record.byteLength > MAX_PUBLISH_UPLOAD_BYTES) {
    return fail(
      "ASSET_OVERSIZE",
      `${field}.byteLength exceeds the ${MAX_PUBLISH_UPLOAD_BYTES} byte upload ceiling`
    );
  }
  if (
    typeof record.width !== "number" ||
    typeof record.height !== "number" ||
    !Number.isSafeInteger(record.width) ||
    !Number.isSafeInteger(record.height) ||
    record.width < MIN_RASTER_DIMENSION_PX ||
    record.height < MIN_RASTER_DIMENSION_PX ||
    record.width > MAX_RASTER_DIMENSION_PX ||
    record.height > MAX_RASTER_DIMENSION_PX
  ) {
    return fail(
      "ASSET_DIMENSION_INVALID",
      `${field} dimensions must be integers in ${MIN_RASTER_DIMENSION_PX}..${MAX_RASTER_DIMENSION_PX}`
    );
  }
  if (!Array.isArray(record.references) || record.references.length === 0) {
    return fail(
      "ASSET_CORRUPT",
      `${field}.references must be a non-empty array`
    );
  }

  const references: Array<PublishArtifactAssetReference> = [];
  for (const [refIndex, entry] of record.references.entries()) {
    const parsed = readClosedReference(
      entry,
      `${field}.references[${refIndex}]`
    );
    if (!parsed.ok) return parsed;
    references.push(parsed.reference);
  }

  if (typeof record.mediaType !== "string") {
    return fail(
      "ASSET_UNSUPPORTED_FORMAT",
      `${field}.mediaType "${String(record.mediaType)}" is unsupported (SVG excluded)`
    );
  }
  if (record.mediaType === "image/svg+xml") {
    return fail(
      "ASSET_UNSUPPORTED_FORMAT",
      `${field}.mediaType "image/svg+xml" is unsupported (SVG excluded)`
    );
  }
  if (!isSupportedMediaType(record.mediaType)) {
    return fail(
      "ASSET_UNSUPPORTED_FORMAT",
      `${field}.mediaType "${record.mediaType}" is not a supported raster type`
    );
  }
  if (typeof record.data !== "string") {
    return fail("ASSET_CORRUPT", `${field}.data must be valid base64`);
  }

  const decoded = decodeBase64ToBytes(record.data);
  if (!decoded.ok) {
    return fail("ASSET_CORRUPT", `${field}.data must be valid base64`);
  }
  if (decoded.bytes.byteLength !== record.byteLength) {
    return fail(
      "ASSET_CORRUPT",
      `${field}.byteLength does not match decoded payload length`
    );
  }
  const digest = sha256BytesHex(decoded.bytes);
  if (digest !== record.sha256) {
    return fail(
      "ASSET_CORRUPT",
      `${field}.sha256 does not match payload bytes`
    );
  }
  // Closed-object parse stays synchronous: structural validation only.
  // Producer/file-ingress paths must await validateRasterDecodable separately.
  const validatedRaster = validateRasterBytesStructural(decoded.bytes);
  if (!validatedRaster.ok) {
    return fail(validatedRaster.code, `${field} ${validatedRaster.message}`);
  }
  if (validatedRaster.mediaType !== record.mediaType) {
    return fail(
      "ASSET_MIME_SPOOF",
      `${field} declared ${record.mediaType} but bytes sniff as ${validatedRaster.mediaType}`
    );
  }
  if (
    validatedRaster.width !== record.width ||
    validatedRaster.height !== record.height
  ) {
    return fail(
      "ASSET_DIMENSION_INVALID",
      `${field} declared ${record.width}x${record.height} but bytes are ${validatedRaster.width}x${validatedRaster.height}`
    );
  }

  return {
    ok: true,
    asset: {
      byteLength: record.byteLength,
      data: record.data,
      encoding: "base64",
      height: record.height,
      id: record.id,
      mediaType: record.mediaType,
      references,
      sha256: record.sha256,
      width: record.width,
    },
  };
};

export const readRequiredCapabilities = (
  value: unknown
): ContractFailure | { ok: true; capabilities: Array<string> } => {
  if (value === undefined) return { ok: true, capabilities: [] };
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return fail(
      "CAPABILITY_UNSUPPORTED",
      "requiredCapabilities must be an array of strings when present"
    );
  }
  const capabilities = value as Array<string>;
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (
      capability.length < MIN_REQUIRED_CAPABILITY_LENGTH ||
      capability.length > MAX_REQUIRED_CAPABILITY_LENGTH
    ) {
      return fail(
        "CAPABILITY_UNSUPPORTED",
        `requiredCapabilities entries must be non-empty strings of at most ${MAX_REQUIRED_CAPABILITY_LENGTH} characters`
      );
    }
    if (seen.has(capability)) {
      return fail(
        "CAPABILITY_UNSUPPORTED",
        `requiredCapabilities duplicates capability "${capability}"`
      );
    }
    seen.add(capability);
    if (
      !(KNOWN_PUBLISH_REQUIRED_CAPABILITIES as ReadonlyArray<string>).includes(
        capability
      )
    ) {
      return fail(
        "CAPABILITY_UNSUPPORTED",
        `Unsupported required capability "${capability}"`
      );
    }
  }
  return { ok: true, capabilities };
};

export const readAssets = (
  value: unknown
): ContractFailure | { ok: true; assets: Array<PublishArtifactAsset> } => {
  if (value === undefined) return { ok: true, assets: [] };
  if (!Array.isArray(value)) {
    return fail("ASSET_CORRUPT", "assets must be an array when present");
  }
  const assets: Array<PublishArtifactAsset> = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const parsed = readClosedAsset(entry, index);
    if (!parsed.ok) return parsed;
    if (seenIds.has(parsed.asset.id)) {
      return fail(
        "ASSET_CONFLICT",
        `assets[${index}] duplicates asset id ${parsed.asset.id}; dedup requires one descriptor per content id`
      );
    }
    seenIds.add(parsed.asset.id);
    assets.push(parsed.asset);
  }
  return { ok: true, assets };
};
