/**
 * Load and validate attachment bytes into pending publish asset payloads.
 *
 * @module src/publish/attachment-load
 */

import type {
  AttachmentDiagnostic,
  PendingAssetPayload,
} from "./attachment-types";

import { encodeBytesToBase64, sha256BytesHex } from "./artifact-asset-codec";
import { MAX_PUBLISH_UPLOAD_BYTES } from "./artifact-asset-contract";
import { diagnostic, extensionOf } from "./attachment-path";
import {
  RASTER_HEADER_PROBE_BYTES,
  validateRasterBytesStructural,
  validateRasterDecodable,
} from "./attachment-raster";

const SUPPORTED_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
]);
const UNSUPPORTED_EXT = new Set([".svg", ".pdf", ".html", ".htm"]);

export async function readAndValidateAsset(
  absPath: string,
  noteSlug: string,
  sourceRef: string,
  relPath: string
): Promise<PendingAssetPayload | AttachmentDiagnostic> {
  const ext = extensionOf(relPath);
  if (UNSUPPORTED_EXT.has(ext)) {
    return diagnostic(
      "ASSET_UNSUPPORTED_FORMAT",
      `Unsupported attachment format "${ext}"`,
      noteSlug,
      sourceRef
    );
  }
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return diagnostic(
      "ASSET_MISSING",
      `Attachment not found: ${relPath}`,
      noteSlug,
      sourceRef
    );
  }
  const size = file.size;
  if (size <= 0) {
    return diagnostic(
      "ASSET_CORRUPT",
      "Attachment is empty",
      noteSlug,
      sourceRef
    );
  }
  if (size > MAX_PUBLISH_UPLOAD_BYTES) {
    return diagnostic(
      "ASSET_OVERSIZE",
      `Attachment is ${size} bytes before read; max is ${MAX_PUBLISH_UPLOAD_BYTES}`,
      noteSlug,
      sourceRef
    );
  }

  const header = new Uint8Array(
    await file.slice(0, Math.min(size, RASTER_HEADER_PROBE_BYTES)).arrayBuffer()
  );
  // Header probe uses structural checks only (sync, cheap reject).
  const headerCheck = validateRasterBytesStructural(header);
  if (!headerCheck.ok) {
    const rejectEarly =
      headerCheck.code === "ASSET_DIMENSION_INVALID" ||
      headerCheck.code === "ASSET_UNSUPPORTED_FORMAT" ||
      (headerCheck.code === "ASSET_CORRUPT" &&
        size <= RASTER_HEADER_PROBE_BYTES);
    if (rejectEarly) {
      if (
        headerCheck.code === "ASSET_UNSUPPORTED_FORMAT" &&
        SUPPORTED_EXT.has(ext)
      ) {
        return diagnostic(
          "ASSET_MIME_SPOOF",
          `Extension ${ext} does not match raster bytes`,
          noteSlug,
          sourceRef
        );
      }
      return diagnostic(
        headerCheck.code,
        headerCheck.message,
        noteSlug,
        sourceRef
      );
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Full producer path: structural validation plus pixel decodability before bundling.
  const validated = await validateRasterDecodable(bytes);
  if (!validated.ok) {
    if (
      validated.code === "ASSET_UNSUPPORTED_FORMAT" &&
      SUPPORTED_EXT.has(ext)
    ) {
      return diagnostic(
        "ASSET_MIME_SPOOF",
        `Extension ${ext} does not match raster bytes`,
        noteSlug,
        sourceRef
      );
    }
    return diagnostic(validated.code, validated.message, noteSlug, sourceRef);
  }

  const sha256 = sha256BytesHex(bytes);
  return {
    byteLength: bytes.byteLength,
    data: encodeBytesToBase64(bytes),
    height: validated.height,
    mediaType: validated.mediaType,
    references: [{ noteSlug, sourceRef: relPath }],
    sha256,
    width: validated.width,
  };
}
