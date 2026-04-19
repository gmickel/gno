/**
 * markitdown-ts adapter for PDF, DOCX, XLSX conversion.
 * Uses convertBuffer() with bytes for determinism.
 */

import { MarkItDown } from "markitdown-ts";

import type {
  Converter,
  ConvertInput,
  ConvertResult,
  ConvertWarning,
} from "../../types";

import {
  adapterError,
  corruptError,
  permissionError,
  timeoutError,
  tooLargeError,
} from "../../errors";
import { ADAPTER_VERSIONS } from "../../versions";

const CONVERTER_ID = "adapter/markitdown-ts" as const;
const CONVERTER_VERSION = ADAPTER_VERSIONS["markitdown-ts"];

/** Supported extensions for this adapter */
const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx"];

/** Supported MIME types */
const SUPPORTED_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const CFB_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const ENCRYPTION_INFO = utf16le("EncryptionInfo");
const ENCRYPTED_PACKAGE = utf16le("EncryptedPackage");
const MAX_MESSAGE_LENGTH = 200;
const PASSWORD_ERROR_REGEX = /password(?:-protected)?|no password given/i;

/**
 * Create zero-copy Buffer view of Uint8Array.
 * Assumes input.bytes is immutable (contract requirement).
 */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function utf16le(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf16le"));
}

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }

  return true;
}

function includesBytes(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || bytes.length < needle.length) {
    return false;
  }

  outer: for (
    let index = 0;
    index <= bytes.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }

  return false;
}

function isPasswordProtectedPdf(bytes: Uint8Array): boolean {
  if (!hasPrefix(bytes, PDF_SIGNATURE)) {
    return false;
  }

  const tailStart = Math.max(0, bytes.length - 64 * 1024);
  const tail = Buffer.from(bytes.subarray(tailStart)).toString("latin1");
  return /\/Encrypt\b/.test(tail);
}

function isPasswordProtectedXlsx(bytes: Uint8Array): boolean {
  return (
    hasPrefix(bytes, CFB_SIGNATURE) &&
    includesBytes(bytes, ENCRYPTION_INFO) &&
    includesBytes(bytes, ENCRYPTED_PACKAGE)
  );
}

function isPasswordProtected(input: ConvertInput): boolean {
  if (input.ext === ".pdf") {
    return isPasswordProtectedPdf(input.bytes);
  }

  if (input.ext === ".xlsx") {
    return isPasswordProtectedXlsx(input.bytes);
  }

  return false;
}

function sanitizeErrorMessage(message: string, input: ConvertInput): string {
  const normalized = message.trim();

  let hasControlChars = false;
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31)
    ) {
      hasControlChars = true;
      break;
    }
  }

  if (
    normalized.length === 0 ||
    normalized.length > MAX_MESSAGE_LENGTH ||
    hasControlChars
  ) {
    return `Could not convert ${input.ext} file to markdown`;
  }

  return normalized;
}

export const markitdownAdapter: Converter = {
  id: CONVERTER_ID,
  version: CONVERTER_VERSION,

  canHandle(mime: string, ext: string): boolean {
    return SUPPORTED_EXTENSIONS.includes(ext) || SUPPORTED_MIMES.includes(mime);
  },

  async convert(input: ConvertInput): Promise<ConvertResult> {
    // 1. Check size limit (defense in depth; EPIC 5 does stat-based pre-check)
    if (input.bytes.length > input.limits.maxBytes) {
      return { ok: false, error: tooLargeError(input, CONVERTER_ID) };
    }

    // 1b. Detect password-protected documents before calling markitdown-ts.
    // markitdown-ts logs dependency stack traces to stderr for these files.
    if (isPasswordProtected(input)) {
      return {
        ok: false,
        error: permissionError(
          input,
          CONVERTER_ID,
          "File is password-protected",
          undefined,
          { protection: input.ext.slice(1) }
        ),
      };
    }

    // 2. Setup timeout handling
    // Note: markitdown-ts doesn't support AbortSignal, so underlying
    // work may continue after timeout (known limitation; process isolation future work)
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error("TIMEOUT"));
      }, input.limits.timeoutMs);
    });

    const converter = new MarkItDown();

    // IMPORTANT: Use convertBuffer with bytes for determinism
    // Path-based convert() could re-read a modified file
    // Zero-copy Buffer view (input.bytes is immutable by contract)
    const workPromise = converter.convertBuffer(toBuffer(input.bytes), {
      file_extension: input.ext,
    });

    try {
      const result = await Promise.race([workPromise, timeoutPromise]);

      // Clear timeout on success
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!result?.markdown) {
        return {
          ok: false,
          error: corruptError(input, CONVERTER_ID, "Empty conversion result"),
        };
      }

      // Emit warnings for suspicious output
      const warnings: ConvertWarning[] = [];
      if (result.markdown.length < 10 && input.bytes.length > 1000) {
        warnings.push({ code: "LOSSY", message: "Suspiciously short output" });
      }

      // NOTE: Canonicalization happens in pipeline.ts, not here
      return {
        ok: true,
        value: {
          markdown: result.markdown,
          title: result.title ?? undefined,
          meta: {
            converterId: CONVERTER_ID,
            converterVersion: CONVERTER_VERSION,
            sourceMime: input.mime,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        },
      };
    } catch (err) {
      // Clear timeout on error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // If we timed out, suppress any later rejection from the work promise
      // to prevent unhandled rejection crashes
      if (timedOut) {
        workPromise.catch(() => {
          // Intentionally swallowed - work continued after timeout
        });
        return { ok: false, error: timeoutError(input, CONVERTER_ID) };
      }

      // Map adapter errors
      const message =
        err instanceof Error
          ? sanitizeErrorMessage(err.message, input)
          : `Could not convert ${input.ext} file to markdown`;

      if (PASSWORD_ERROR_REGEX.test(message)) {
        return {
          ok: false,
          error: permissionError(
            input,
            CONVERTER_ID,
            "File is password-protected",
            err,
            { protection: input.ext.slice(1) }
          ),
        };
      }

      return {
        ok: false,
        error: adapterError(input, CONVERTER_ID, message, err),
      };
    }
  },
};
