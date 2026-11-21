/**
 * Native plaintext converter.
 * Converts .txt files to markdown (passthrough as paragraphs).
 */

import type { Converter, ConvertInput, ConvertResult } from "../types";

import { basenameWithoutExt } from "../path";
import { NATIVE_VERSIONS } from "../versions";

const CONVERTER_ID = "native/plaintext" as const;
const CONVERTER_VERSION = NATIVE_VERSIONS.plaintext;

/** UTF-8 BOM character */
const BOM = "\uFEFF";
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: false, // Don't throw on invalid bytes
  ignoreBOM: false, // We'll strip manually for determinism
});

export const plaintextConverter: Converter = {
  id: CONVERTER_ID,
  version: CONVERTER_VERSION,

  canHandle(mime: string, ext: string): boolean {
    return mime === "text/plain" || ext === ".txt";
  },

  convert(input: ConvertInput): Promise<ConvertResult> {
    // Decode as UTF-8 with replacement for invalid bytes (deterministic)
    let text = UTF8_DECODER.decode(input.bytes);

    // Strip BOM if present (ensures consistent hashes)
    if (text.startsWith(BOM)) {
      text = text.slice(1);
    }

    // Derive title from filename (cross-platform safe)
    const title = basenameWithoutExt(input.relativePath);

    // Pass through as paragraphs (no code fence wrapping - better for search)
    // NOTE: Do NOT canonicalize here - pipeline.ts handles all normalization
    return Promise.resolve({
      ok: true,
      value: {
        markdown: text,
        title,
        meta: {
          converterId: CONVERTER_ID,
          converterVersion: CONVERTER_VERSION,
          sourceMime: input.mime,
        },
      },
    });
  },
};
