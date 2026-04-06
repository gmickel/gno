/**
 * MIME type detection with magic byte sniffing and extension mapping.
 * PRD §8.5 - MIME detection strategy
 */

import { extname } from "./path";

export interface MimeDetection {
  mime: string;
  ext: string;
  confidence: "high" | "medium" | "low";
  via: "sniff" | "sniff+ext" | "ext" | "fallback";
}

export interface MimeDetector {
  detect(path: string, bytes: Uint8Array): MimeDetection;
}

/** Extension to MIME type mapping (PRD §8.5) */
const EXTENSION_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".jsx": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** OOXML extension to MIME mapping */
const OOXML_MAP: Record<string, string> = {
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** PDF magic bytes: %PDF- */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** ZIP/OOXML magic bytes: PK\x03\x04 */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/**
 * Check if bytes start with the given prefix.
 */
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

interface SniffResult {
  mime: string;
  /** True if sniff alone is sufficient (e.g., PDF); false if ext-assisted (OOXML) */
  pureSniff: boolean;
}

/**
 * Sniff MIME type from magic bytes.
 * Returns detected MIME or undefined if no match.
 */
function sniffMagicBytes(
  bytes: Uint8Array,
  ext: string
): SniffResult | undefined {
  // PDF detection - pure sniff, no extension needed
  if (startsWith(bytes, PDF_MAGIC)) {
    return { mime: "application/pdf", pureSniff: true };
  }

  // ZIP/OOXML detection - requires extension to distinguish OOXML from generic ZIP
  if (startsWith(bytes, ZIP_MAGIC)) {
    const ooxmlMime = Object.hasOwn(OOXML_MAP, ext)
      ? OOXML_MAP[ext]
      : undefined;
    if (ooxmlMime) {
      // ZIP magic + OOXML extension = extension-assisted sniff
      return { mime: ooxmlMime, pureSniff: false };
    }
    // Generic ZIP (not OOXML)
    return { mime: "application/zip", pureSniff: true };
  }

  return;
}

/**
 * Default MIME detector implementation.
 * Detection priority:
 * 1. Magic bytes (sniff) → high confidence for pure sniff
 * 2. Magic bytes + extension → medium confidence (OOXML via ZIP+ext)
 * 3. Extension map → medium confidence
 * 4. Fallback application/octet-stream → low confidence
 */
export class DefaultMimeDetector implements MimeDetector {
  detect(path: string, bytes: Uint8Array): MimeDetection {
    const ext = extname(path);

    // 1. Try magic byte sniffing (first 512 bytes sufficient)
    // Use subarray for zero-copy view (no allocation)
    const sniffBytes = bytes.subarray(0, 512);
    const sniffed = sniffMagicBytes(sniffBytes, ext);
    if (sniffed) {
      return {
        mime: sniffed.mime,
        ext,
        // Pure sniff (e.g., PDF) is high confidence
        // Extension-assisted sniff (OOXML) is medium confidence
        confidence: sniffed.pureSniff ? "high" : "medium",
        via: sniffed.pureSniff ? "sniff" : "sniff+ext",
      };
    }

    // 2. Try extension mapping
    const extMime = Object.hasOwn(EXTENSION_MAP, ext)
      ? EXTENSION_MAP[ext]
      : undefined;
    if (extMime) {
      return {
        mime: extMime,
        ext,
        confidence: "medium",
        via: "ext",
      };
    }

    // 3. Fallback
    return {
      mime: "application/octet-stream",
      ext,
      confidence: "low",
      via: "fallback",
    };
  }
}

/** Singleton default detector */
let defaultDetector: MimeDetector | null = null;

export function getDefaultMimeDetector(): MimeDetector {
  if (!defaultDetector) {
    defaultDetector = new DefaultMimeDetector();
  }
  return defaultDetector;
}

/** Supported extensions for conversion */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

/** Check if extension is supported for conversion (prototype-safe) */
export function isSupportedExtension(ext: string): boolean {
  const normalized = ext.toLowerCase();
  return Object.hasOwn(EXTENSION_MAP, normalized);
}
