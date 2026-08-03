/**
 * Bounded raster signature + dimension validation for publish attachments.
 * Extension/MIME are untrusted; only sniffed bytes decide media type.
 *
 * @module src/publish/attachment-raster
 */

import {
  MAX_PUBLISH_UPLOAD_BYTES,
  MAX_RASTER_DIMENSION_PX,
  MIN_RASTER_DIMENSION_PX,
  type PublishAssetDiagnosticCode,
  type SupportedRasterMediaType,
} from "./artifact-asset-contract";
import { sniffRasterMediaType } from "./artifact-asset-sniff";

/** Header probe size: enough for signatures + early boxes/markers. */
export const RASTER_HEADER_PROBE_BYTES = 65_536;

export interface RasterValidationOk {
  ok: true;
  height: number;
  mediaType: SupportedRasterMediaType;
  width: number;
}

export interface RasterValidationFail {
  ok: false;
  code: PublishAssetDiagnosticCode;
  message: string;
}

export type RasterValidationResult = RasterValidationOk | RasterValidationFail;

const fail = (
  code: PublishAssetDiagnosticCode,
  message: string
): RasterValidationFail => ({ ok: false, code, message });

const asciiSlice = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

const readU16BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const readU16LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const readU24LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) |
  ((bytes[offset + 1] ?? 0) << 8) |
  ((bytes[offset + 2] ?? 0) << 16);

const readU32BE = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

const validateDimensions = (
  width: number,
  height: number
): RasterValidationFail | null => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_RASTER_DIMENSION_PX ||
    height < MIN_RASTER_DIMENSION_PX
  ) {
    return fail(
      "ASSET_DIMENSION_INVALID",
      `Raster dimensions ${width}x${height} are zero or non-integer`
    );
  }
  if (width > MAX_RASTER_DIMENSION_PX || height > MAX_RASTER_DIMENSION_PX) {
    return fail(
      "ASSET_DIMENSION_INVALID",
      `Raster dimensions ${width}x${height} exceed ${MAX_RASTER_DIMENSION_PX}px limit`
    );
  }
  return null;
};

const parsePngDimensions = (
  bytes: Uint8Array
): { width: number; height: number } | null => {
  if (bytes.length < 24) return null;
  if (asciiSlice(bytes, 12, 16) !== "IHDR") return null;
  return {
    width: readU32BE(bytes, 16),
    height: readU32BE(bytes, 20),
  };
};

const parseGifDimensions = (
  bytes: Uint8Array
): { width: number; height: number } | null => {
  if (bytes.length < 10) return null;
  return {
    width: readU16LE(bytes, 6),
    height: readU16LE(bytes, 8),
  };
};

const parseJpegDimensions = (
  bytes: Uint8Array
): { width: number; height: number } | null => {
  let offset = 2;
  const limit = Math.min(bytes.length, RASTER_HEADER_PROBE_BYTES);
  while (offset + 9 < limit) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > limit) return null;
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2) return null;
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (offset + 7 >= limit) return null;
      return {
        height: readU16BE(bytes, offset + 3),
        width: readU16BE(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
};

const parseWebpDimensions = (
  bytes: Uint8Array
): { width: number; height: number } | null => {
  if (bytes.length < 30) return null;
  const chunk = asciiSlice(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: readU24LE(bytes, 24) + 1,
      height: readU24LE(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    // Lossy bitstream start code 0x9d012a at payload+3
    if (
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a &&
      bytes.length >= 30
    ) {
      return {
        width: readU16LE(bytes, 26) & 0x3fff,
        height: readU16LE(bytes, 28) & 0x3fff,
      };
    }
    return null;
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    const bits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
};

/** ISO BMFF containers that may hold `ispe` (directly or nested). */
const BMFF_NEST_BOXES = new Set(["meta", "iprp", "ipco", "moov"]);
/** FullBox containers: 4-byte version+flags after the box header. */
const BMFF_FULLBOX_CONTAINERS = new Set(["meta"]);
const BMFF_MAX_DEPTH = 12;
const BMFF_MAX_BOXES = 512;

/**
 * Bounded recursive BMFF scan for HEIF/AVIF `ispe` (Image Spatial Extents).
 * Handles nested containers, `meta` FullBox payload, and 64-bit size fields.
 */
const parseAvifDimensions = (
  bytes: Uint8Array
): { width: number; height: number } | null => {
  const limit = Math.min(bytes.length, RASTER_HEADER_PROBE_BYTES);

  const scanRange = (
    start: number,
    end: number,
    depth: number,
    boxBudget: { remaining: number }
  ): { width: number; height: number } | null => {
    if (depth > BMFF_MAX_DEPTH) return null;
    let offset = start;
    while (offset + 8 <= end && boxBudget.remaining > 0) {
      boxBudget.remaining -= 1;
      let size = readU32BE(bytes, offset);
      const type = asciiSlice(bytes, offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return null;
        const high = readU32BE(bytes, offset + 8);
        const low = readU32BE(bytes, offset + 12);
        if (high !== 0) return null;
        size = low;
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize) return null;
      if (offset + headerSize > end) return null;

      // Clamp to available probe bytes so large boxes remain scannable.
      const boxEnd = Math.min(offset + size, end);

      if (type === "ispe") {
        // ispe is a FullBox: version(1)+flags(3) then width/height u32be.
        const payload = offset + headerSize;
        if (payload + 12 > boxEnd) return null;
        const width = readU32BE(bytes, payload + 4);
        const height = readU32BE(bytes, payload + 8);
        return { width, height };
      }

      if (BMFF_NEST_BOXES.has(type)) {
        let payloadStart = offset + headerSize;
        if (BMFF_FULLBOX_CONTAINERS.has(type)) {
          if (payloadStart + 4 > boxEnd) return null;
          payloadStart += 4;
        }
        const nested = scanRange(payloadStart, boxEnd, depth + 1, boxBudget);
        if (nested) return nested;
      }

      if (offset + size > end) {
        // Truncated declared size — stop rather than walk past the range.
        break;
      }
      offset += size;
    }
    return null;
  };

  return scanRange(0, limit, 0, { remaining: BMFF_MAX_BOXES });
};

const parseDimensions = (
  mediaType: SupportedRasterMediaType,
  bytes: Uint8Array
): { width: number; height: number } | null => {
  switch (mediaType) {
    case "image/png":
      return parsePngDimensions(bytes);
    case "image/jpeg":
      return parseJpegDimensions(bytes);
    case "image/gif":
      return parseGifDimensions(bytes);
    case "image/webp":
      return parseWebpDimensions(bytes);
    case "image/avif":
      return parseAvifDimensions(bytes);
    default:
      return null;
  }
};

/**
 * Validate raster bytes: signature sniff + bounded dimension parse.
 * Caller should reject oversized files before reading full content when possible.
 */
export const validateRasterBytes = (
  bytes: Uint8Array
): RasterValidationResult => {
  if (bytes.byteLength === 0) {
    return fail("ASSET_CORRUPT", "Image payload is empty");
  }
  if (bytes.byteLength > MAX_PUBLISH_UPLOAD_BYTES) {
    return fail(
      "ASSET_OVERSIZE",
      `Image payload is ${bytes.byteLength} bytes; max is ${MAX_PUBLISH_UPLOAD_BYTES}`
    );
  }

  const mediaType = sniffRasterMediaType(bytes);
  if (!mediaType) {
    if (
      bytes.length >= 5 &&
      (asciiSlice(bytes, 0, 5) === "<?xml" ||
        asciiSlice(bytes, 0, 4).toLowerCase() === "<svg")
    ) {
      return fail(
        "ASSET_UNSUPPORTED_FORMAT",
        "SVG is unsupported for bundled publish assets"
      );
    }
    return fail(
      "ASSET_UNSUPPORTED_FORMAT",
      "Payload does not match a supported raster signature"
    );
  }

  const dims = parseDimensions(mediaType, bytes);
  if (!dims) {
    return fail(
      "ASSET_CORRUPT",
      `Unable to parse ${mediaType} dimensions from bounded header`
    );
  }
  const dimError = validateDimensions(dims.width, dims.height);
  if (dimError) return dimError;

  return {
    ok: true,
    height: dims.height,
    mediaType,
    width: dims.width,
  };
};
