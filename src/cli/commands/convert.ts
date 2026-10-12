/**
 * gno convert command - convert one file to canonical Markdown without
 * indexing it. Uses the same conversion path as indexing
 * (`convertForPreparation`), so the Markdown and mirrorHash match what
 * `gno update` would store for the same bytes.
 *
 * @module src/cli/commands/convert
 */

// node:fs/promises for stat(): Bun.file().size reports 0 for directories.
import { stat } from "node:fs/promises";
// node:path for basename/resolve: no Bun equivalent.
import { basename, resolve } from "node:path";

import type { ConvertErrorCode, ConvertWarning } from "../../converters/types";

import { getDefaultMimeDetector } from "../../converters/mime";
import { DEFAULT_LIMITS } from "../../converters/types";
import { convertForPreparation } from "../../ingestion/prepare-convert";
import { CliError } from "../errors";

export const CONVERT_SCHEMA_VERSION = "convert@1.0";

export interface ConvertOptions {
  /** Max input size in bytes (default: DEFAULT_LIMITS.maxBytes) */
  maxBytes?: number;
  /** Conversion timeout in ms (default: DEFAULT_LIMITS.timeoutMs) */
  timeoutMs?: number;
}

export interface ConvertCommandResult {
  schemaVersion: typeof CONVERT_SCHEMA_VERSION;
  source: {
    path: string;
    mime: string;
    ext: string;
    sizeBytes: number;
  };
  converter: { id: string; version: string };
  title: string | null;
  languageHint: string | null;
  markdown: string;
  mirrorHash: string;
  warnings: ConvertWarning[];
}

/** Input problems exit 1; conversion failures exit 2. */
const VALIDATION_REASONS: ReadonlySet<ConvertErrorCode> = new Set([
  "UNSUPPORTED",
  "TOO_LARGE",
]);

function convertFailure(
  reason: ConvertErrorCode | "NOT_FOUND",
  message: string,
  extra: Record<string, unknown> = {}
): CliError {
  const code =
    reason === "NOT_FOUND" || VALIDATION_REASONS.has(reason as ConvertErrorCode)
      ? "VALIDATION"
      : "RUNTIME";
  return new CliError(code, message, {
    details: { reason, ...extra },
  });
}

/**
 * Convert one file. Throws CliError with `details.reason` set to the
 * converter error code (`TOO_LARGE`, `UNSUPPORTED`, `CORRUPT`, ...) or
 * `NOT_FOUND`.
 */
export async function convertFile(
  file: string,
  options: ConvertOptions = {}
): Promise<ConvertCommandResult> {
  const sourcePath = resolve(file);
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_LIMITS.maxBytes,
    timeoutMs: options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxOutputChars: DEFAULT_LIMITS.maxOutputChars,
  };

  let size: number;
  try {
    const info = await stat(sourcePath);
    if (!info.isFile()) {
      throw convertFailure("NOT_FOUND", `Not a file: ${sourcePath}`, {
        path: sourcePath,
      });
    }
    size = info.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw convertFailure("NOT_FOUND", `File not found: ${sourcePath}`, {
      path: sourcePath,
    });
  }

  // Refuse before reading, so an oversized file is never loaded.
  if (size > limits.maxBytes) {
    throw convertFailure(
      "TOO_LARGE",
      `File size ${size} exceeds limit ${limits.maxBytes}`,
      { path: sourcePath, size, limit: limits.maxBytes }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(sourcePath).bytes();
  } catch (err) {
    throw convertFailure(
      "IO",
      `Cannot read ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
      { path: sourcePath }
    );
  }

  const detected = getDefaultMimeDetector().detect(sourcePath, bytes);
  const result = await convertForPreparation({
    sourcePath,
    relativePath: basename(sourcePath),
    collection: "",
    bytes,
    mime: detected.mime,
    ext: detected.ext,
    limits,
  });

  if (!result.ok) {
    const { error } = result;
    throw convertFailure(error.code, error.message, {
      ...error.details,
      path: sourcePath,
      mime: error.mime,
      ext: error.ext,
      converterId: error.converterId,
    });
  }

  const artifact = result.value;
  return {
    schemaVersion: CONVERT_SCHEMA_VERSION,
    source: {
      path: sourcePath,
      mime: detected.mime,
      ext: detected.ext,
      sizeBytes: size,
    },
    converter: {
      id: artifact.meta.converterId,
      version: artifact.meta.converterVersion,
    },
    title: artifact.title ?? null,
    languageHint: artifact.languageHint ?? null,
    markdown: artifact.markdown,
    mirrorHash: artifact.mirrorHash,
    warnings: artifact.meta.warnings ?? [],
  };
}

/** JSON: the full payload. Terminal: Markdown only (warnings go to stderr). */
export function formatConvert(
  result: ConvertCommandResult,
  options: { json?: boolean } = {}
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  return result.markdown;
}

export function formatConvertWarnings(result: ConvertCommandResult): string[] {
  return result.warnings.map((w) => `Warning [${w.code}]: ${w.message}`);
}
