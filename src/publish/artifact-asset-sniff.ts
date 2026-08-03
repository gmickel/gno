/**
 * Sentinel grammar and raster byte sniffing for publish assets.
 *
 * @module src/publish/artifact-asset-sniff
 */

import {
  GNO_ASSET_SENTINEL_PATTERN,
  GNO_ASSET_SENTINEL_PREFIX,
  type SupportedRasterMediaType,
} from "./artifact-asset-contract";

/**
 * Capture the complete Markdown destination candidate, not merely a valid-looking
 * prefix. Delimiters are excluded; every other suffix (percent escapes,
 * fragments, query strings, Unicode, etc.) is deliberately retained so the
 * strict sentinel parser can reject it rather than silently accepting a prefix.
 * Bare `gno-asset:` (empty destination) is also captured so anchored parsing
 * can fail closed with ASSET_SENTINEL_INVALID.
 */
const GNO_ASSET_TOKEN_PATTERN = /gno-asset:[^\s<>"'()[\]{}]*/giu;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

const asciiSlice = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

const readU32BE = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

export const formatGnoAssetSentinel = (assetId: string): string => {
  if (!SHA256_HEX_PATTERN.test(assetId)) {
    throw new Error("Asset id must be lowercase SHA-256 hex");
  }
  return `${GNO_ASSET_SENTINEL_PREFIX}${assetId}`;
};

export const parseGnoAssetSentinel = (
  value: string
): { ok: true; assetId: string } | { ok: false; reason: "invalid" } => {
  const match = GNO_ASSET_SENTINEL_PATTERN.exec(value.trim());
  if (!match?.[1]) return { ok: false, reason: "invalid" };
  return { ok: true, assetId: match[1] };
};

export const matchGnoAssetTokens = (markdown: string): Array<string> =>
  markdown.match(GNO_ASSET_TOKEN_PATTERN) ?? [];

export const sniffRasterMediaType = (
  bytes: Uint8Array
): SupportedRasterMediaType | null => {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = asciiSlice(bytes, 0, 6);
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    if (
      asciiSlice(bytes, 0, 4) === "RIFF" &&
      asciiSlice(bytes, 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }
  }
  if (bytes.length >= 12 && asciiSlice(bytes, 4, 8) === "ftyp") {
    let boxSize = readU32BE(bytes, 0);
    let headerSize = 8;
    if (boxSize === 1) {
      if (bytes.length < 24 || readU32BE(bytes, 8) !== 0) return null;
      boxSize = readU32BE(bytes, 12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = bytes.length;
    }
    if (boxSize < headerSize + 8 || boxSize > bytes.length) return null;
    const brand = asciiSlice(bytes, headerSize, headerSize + 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    for (let offset = headerSize + 8; offset + 4 <= boxSize; offset += 4) {
      const compat = asciiSlice(bytes, offset, offset + 4);
      if (compat === "avif" || compat === "avis") return "image/avif";
    }
  }
  return null;
};
