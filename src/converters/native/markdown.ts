/**
 * Native Markdown converter (passthrough).
 * Simply reads .md files and extracts title from first heading.
 */

import type { Converter, ConvertInput, ConvertResult } from "../types";

import { basenameWithoutExt } from "../path";
import { NATIVE_VERSIONS } from "../versions";

/** Converter id of Markdown sources, the only documents with link edges. */
export const MARKDOWN_CONVERTER_ID = "native/markdown" as const;
const CONVERTER_ID = MARKDOWN_CONVERTER_ID;
const CONVERTER_VERSION = NATIVE_VERSIONS.markdown;

/** UTF-8 BOM character */
const BOM = "\uFEFF";

/** Regex to match # heading at line start */
const HEADING_PATTERN = /^\s*#\s+(.+)/;

/** Regex to detect code fence start (captures the fence chars and optional info string) */
const CODE_FENCE_START = /^(`{3,}|~{3,})/;

/**
 * Check if a line closes a code fence.
 * Closing fence must be same char type and at least as long as opening.
 */
function isClosingFence(
  line: string,
  fenceChar: string,
  fenceLen: number
): boolean {
  const trimmed = line.trim();
  // Must be only fence chars (no info string on close)
  if (trimmed.length < fenceLen) {
    return false;
  }
  // All chars must be the fence char
  for (const char of trimmed) {
    if (char !== fenceChar) {
      return false;
    }
  }
  return true;
}

/**
 * Extract title from first # heading in markdown, skipping code blocks.
 * Returns undefined if no heading found.
 */
function extractFirstHeading(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    // If inside a fence, check for closing
    if (fenceLen > 0) {
      if (isClosingFence(line, fenceChar, fenceLen)) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }

    // Check for fence opening
    const fenceMatch = line.match(CODE_FENCE_START);
    if (fenceMatch?.[1]) {
      fenceChar = fenceMatch[1].charAt(0);
      fenceLen = fenceMatch[1].length;
      continue;
    }

    // Check for heading (not inside fence)
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch?.[1]) {
      return headingMatch[1].trim();
    }
  }

  return;
}

export const markdownConverter: Converter = {
  id: CONVERTER_ID,
  version: CONVERTER_VERSION,

  canHandle(mime: string, ext: string): boolean {
    return mime === "text/markdown" || ext === ".md";
  },

  convert(input: ConvertInput): Promise<ConvertResult> {
    // Decode bytes to string (assumes UTF-8)
    let text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);

    // Strip BOM if present (ensures consistent hashes)
    if (text.startsWith(BOM)) {
      text = text.slice(1);
    }

    // Extract title from first heading, fall back to filename
    const title =
      extractFirstHeading(text) || basenameWithoutExt(input.relativePath);

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
