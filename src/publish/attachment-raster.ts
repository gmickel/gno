/**
 * Bounded raster signature + dimension validation for publish attachments.
 * Extension/MIME are untrusted; only sniffed bytes decide media type.
 *
 * Structural validation is synchronous and closed-parser safe.
 * AVIF AV1 decodability is a separate async producer/file-ingress check.
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

const readU32LE = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset + 3] ?? 0) << 24) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 1] ?? 0) << 8) |
    (bytes[offset] ?? 0)) >>>
  0;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    const tableIndex = (crc ^ (bytes[index] ?? 0)) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[tableIndex] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

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
 * Validate the complete PNG chunk stream. This prevents a signature + fabricated
 * IHDR prefix from crossing the boundary as an image. CRCs, image data, the
 * terminal IEND chunk, and no trailing bytes are required.
 */
const isCompletePng = (bytes: Uint8Array): boolean => {
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  while (offset + 12 <= bytes.length) {
    const dataLength = readU32BE(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;
    const type = asciiSlice(bytes, typeStart, dataStart);
    if (crc32(bytes, typeStart, dataEnd) !== readU32BE(bytes, dataEnd)) {
      return false;
    }
    if (chunkIndex === 0 && (type !== "IHDR" || dataLength !== 13)) {
      return false;
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      return dataLength === 0 && sawIdat && chunkEnd === bytes.length;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
};

/** Complete marker walk: a JPEG needs frame metadata, a scan, and terminal EOI. */
const isCompleteJpeg = (bytes: Uint8Array): boolean => {
  if (bytes.length < 6 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEntropyData = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9) {
      return sawFrame && sawScan && sawEntropyData && offset === bytes.length;
    }
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return false;
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length)
      return false;
    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) sawFrame = true;
    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }
    sawScan = true;
    offset += segmentLength;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        sawEntropyData = true;
        offset += 1;
        continue;
      }
      const next = bytes[offset + 1];
      if (next === undefined) return false;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 2;
        continue;
      }
      break;
    }
  }
  return false;
};

const skipGifSubBlocks = (bytes: Uint8Array, start: number): number | null => {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0;
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.length) return null;
    offset += size;
  }
  return null;
};

/** Complete GIF block walk with at least one image and a terminal trailer. */
const isCompleteGif = (bytes: Uint8Array): boolean => {
  if (bytes.length < 14) return false;
  let offset = 13;
  const globalTable = (bytes[10] ?? 0) & 0x80;
  if (globalTable) offset += 3 * 2 ** (((bytes[10] ?? 0) & 0x07) + 1);
  if (offset > bytes.length) return false;
  let sawImage = false;
  while (offset < bytes.length) {
    const introducer = bytes[offset] ?? 0;
    offset += 1;
    if (introducer === 0x3b) return sawImage && offset === bytes.length;
    if (introducer === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === null) return false;
      offset = next;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.length) return false;
    const packed = bytes[offset + 8] ?? 0;
    offset += 9;
    if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
    if (offset >= bytes.length) return false;
    const minimumCodeSize = bytes[offset] ?? 0;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
    offset += 1;
    if ((bytes[offset] ?? 0) === 0) return false;
    const next = skipGifSubBlocks(bytes, offset);
    if (next === null) return false;
    offset = next;
    sawImage = true;
  }
  return false;
};

/** RIFF size/chunk walk; VP8X is metadata and cannot stand in for image data. */
const isCompleteWebp = (bytes: Uint8Array): boolean => {
  if (bytes.length < 20 || readU32LE(bytes, 4) + 8 !== bytes.length) {
    return false;
  }
  let offset = 12;
  let sawImageData = false;
  while (offset + 8 <= bytes.length) {
    const type = asciiSlice(bytes, offset, offset + 4);
    const size = readU32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const paddedEnd = dataStart + size + (size % 2);
    if (paddedEnd < dataStart || paddedEnd > bytes.length) return false;
    const isVp8 =
      type === "VP8 " &&
      size >= 10 &&
      bytes[dataStart + 3] === 0x9d &&
      bytes[dataStart + 4] === 0x01 &&
      bytes[dataStart + 5] === 0x2a;
    const isVp8l = type === "VP8L" && size >= 5 && bytes[dataStart] === 0x2f;
    const isAnimationFrame = type === "ANMF" && size >= 16;
    if (isVp8 || isVp8l || isAnimationFrame) {
      sawImageData = true;
    }
    offset = paddedEnd;
  }
  return sawImageData && offset === bytes.length;
};

/** Exact top-level BMFF walk; AVIF needs metadata and a non-empty media payload. */
const isCompleteAvif = (bytes: Uint8Array): boolean => {
  let offset = 0;
  let sawFtyp = false;
  let sawMeta = false;
  let sawMediaData = false;
  while (offset + 8 <= bytes.length) {
    let size = readU32BE(bytes, offset);
    const type = asciiSlice(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length || readU32BE(bytes, offset + 8) !== 0) {
        return false;
      }
      size = readU32BE(bytes, offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) return false;
    if (type === "ftyp" && size >= headerSize + 8) sawFtyp = true;
    if (type === "meta") sawMeta = true;
    if (type === "mdat" && size > headerSize) sawMediaData = true;
    offset += size;
  }
  return sawFtyp && sawMeta && sawMediaData && offset === bytes.length;
};

const isCompleteRaster = (
  mediaType: SupportedRasterMediaType,
  bytes: Uint8Array
): boolean => {
  switch (mediaType) {
    case "image/png":
      return isCompletePng(bytes);
    case "image/jpeg":
      return isCompleteJpeg(bytes);
    case "image/gif":
      return isCompleteGif(bytes);
    case "image/webp":
      return isCompleteWebp(bytes);
    case "image/avif":
      return isCompleteAvif(bytes);
    default:
      return false;
  }
};

/**
 * Synchronous structural raster validation: signature sniff, bounded
 * dimensions, and container completeness. Does **not** prove AV1
 * decodability for AVIF — producers must also await
 * `validateRasterDecodable` before bundling.
 */
export const validateRasterBytesStructural = (
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
  if (!isCompleteRaster(mediaType, bytes)) {
    return fail(
      "ASSET_CORRUPT",
      `${mediaType} payload is not a complete, structurally renderable image`
    );
  }

  return {
    ok: true,
    height: dims.height,
    mediaType,
    width: dims.width,
  };
};

const MAX_AVIF_DECODE_INPUT_PIXELS =
  MAX_RASTER_DIMENSION_PX * MAX_RASTER_DIMENSION_PX;

/**
 * Prove AVIF payloads contain a decodable AV1 image via a bounded 1×1 decode.
 * Bun has no native image decoder; sharp provides the cross-platform AV1 path.
 * Call only after structural dimension/bomb checks. Avoids retaining decoded
 * pixel buffers beyond the 1×1 probe.
 */
const assertAvifAv1Decodable = async (
  bytes: Uint8Array,
  structural: RasterValidationOk
): Promise<RasterValidationResult> => {
  try {
    // sharp — Bun has no native AV1/image decoder; pin exact version in package.json.
    const sharp = (await import("sharp")).default;
    await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_AVIF_DECODE_INPUT_PIXELS,
    })
      .resize(1, 1, { fit: "fill" })
      .raw()
      .toBuffer();
    return structural;
  } catch {
    return fail("ASSET_CORRUPT", "image/avif payload is not AV1-decodable");
  }
};

/**
 * Producer/file-ingress validation: structural checks, then AVIF AV1
 * decodability. Closed artifact parsers must keep using
 * `validateRasterBytesStructural` only (sync).
 */
export const validateRasterDecodable = async (
  bytes: Uint8Array
): Promise<RasterValidationResult> => {
  const structural = validateRasterBytesStructural(bytes);
  if (!structural.ok) return structural;
  if (structural.mediaType !== "image/avif") return structural;
  return assertAvifAv1Decodable(bytes, structural);
};
