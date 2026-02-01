/**
 * officeparser adapter for PPTX conversion.
 * Uses parseOffice() v6 API with Buffer for in-memory extraction.
 */

import { parseOffice } from "officeparser";

import type {
  Converter,
  ConvertInput,
  ConvertResult,
  ConvertWarning,
} from "../../types";

import { adapterError, corruptError, tooLargeError } from "../../errors";
import { basenameWithoutExt } from "../../path";
import { ADAPTER_VERSIONS } from "../../versions";

const CONVERTER_ID = "adapter/officeparser" as const;
const CONVERTER_VERSION = ADAPTER_VERSIONS.officeparser;

/** Supported MIME type */
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Control character pattern built dynamically to avoid lint issues.
 * Matches U+0000-U+001F and U+007F (all ASCII control chars).
 */
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);

/**
 * Sanitize title for safe Markdown output.
 * Removes control chars, collapses whitespace, ensures single line.
 */
function sanitizeTitle(title: string): string {
  return title
    .replace(/[\r\n]/g, " ")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Get sanitized title from relative path.
 */
function getTitleFromPath(relativePath: string): string {
  return sanitizeTitle(basenameWithoutExt(relativePath));
}

/**
 * Create zero-copy Buffer view of Uint8Array.
 * Assumes input.bytes is immutable (contract requirement).
 */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export const officeparserAdapter: Converter = {
  id: CONVERTER_ID,
  version: CONVERTER_VERSION,

  canHandle(mime: string, ext: string): boolean {
    return ext === ".pptx" || mime === PPTX_MIME;
  },

  async convert(input: ConvertInput): Promise<ConvertResult> {
    // Size check (defense in depth; EPIC 5 does stat-based pre-check)
    if (input.bytes.length > input.limits.maxBytes) {
      return { ok: false, error: tooLargeError(input, CONVERTER_ID) };
    }

    try {
      // Zero-copy Buffer view (input.bytes is immutable by contract)
      const buffer = toBuffer(input.bytes);
      // v6 API: parseOffice returns AST, use .toText() for plain text
      const ast = await parseOffice(buffer, {
        newlineDelimiter: "\n",
        ignoreNotes: false, // Include speaker notes
      });
      const text = ast.toText();

      if (!text || text.trim().length === 0) {
        return {
          ok: false,
          error: corruptError(input, CONVERTER_ID, "Empty extraction result"),
        };
      }

      // Get sanitized title
      const title = getTitleFromPath(input.relativePath);

      // Convert plain text to Markdown structure
      const markdown = `# ${title}\n\n${text}`;

      // NOTE: Do NOT canonicalize here - pipeline.ts handles all normalization
      const warnings: ConvertWarning[] = [];
      if (markdown.length < 10 && input.bytes.length > 1000) {
        warnings.push({ code: "LOSSY", message: "Suspiciously short output" });
      }

      return {
        ok: true,
        value: {
          markdown,
          title,
          meta: {
            converterId: CONVERTER_ID,
            converterVersion: CONVERTER_VERSION,
            sourceMime: input.mime,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: adapterError(
          input,
          CONVERTER_ID,
          err instanceof Error ? err.message : "Unknown error",
          err
        ),
      };
    }
  },
};
