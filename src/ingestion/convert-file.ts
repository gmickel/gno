/**
 * Convert one file to the Markdown GNO would index for it, with nothing
 * persisted (`gno convert`, SDK `convertFile`).
 *
 * The file goes through the indexing path: extension MIME detection and the
 * record-adapter check, then a sniffed MIME and `prepareFile` in the
 * terminable file processor under the default time and memory budget. The
 * Markdown and mirror hash therefore equal what `gno update` stores for the
 * same bytes. No config, index, store or cache is read or written.
 *
 * @module src/ingestion/convert-file
 */

// node:fs/promises for stat (no Bun equivalent for file stats)
import { stat } from "node:fs/promises";
// node:path for basename/resolve (no Bun path utils)
import { basename, resolve } from "node:path";

import { getDefaultMimeDetector } from "../converters/mime";
import { markdownConverter } from "../converters/native/markdown";
import { getDefaultPipeline } from "../converters/pipeline";
import { DEFAULT_LIMITS } from "../converters/types";
import {
  defaultConversionMemoryMb,
  prepareInProcessor,
} from "./file-processor";
import { DEFAULT_CHUNK_PARAMS } from "./types";

export const CONVERT_SCHEMA_VERSION = "convert@1.0";

const BYTES_PER_MB = 1_048_576;
const SNIFF_BYTES = 512;

export interface ConvertFileResult {
  schemaVersion: typeof CONVERT_SCHEMA_VERSION;
  source: { path: string; mime: string; ext: string; sizeBytes: number };
  converter: { id: string; version: string };
  title: string | null;
  languageHint: string | null;
  markdown: string;
  mirrorHash: string;
  warnings: { code: string; message: string }[];
}

/**
 * Why a file was not converted. `validation` failures (missing file, over
 * the size limit, no converter, multi-record format) exit 1 on the CLI;
 * converter and processor failures exit 2.
 */
export interface ConvertFileFailure {
  reason: string;
  message: string;
  validation: boolean;
  details?: Record<string, unknown>;
}

export type ConvertFileOutcome =
  | { ok: true; value: ConvertFileResult }
  | { ok: false; error: ConvertFileFailure };

const fail = (
  reason: string,
  message: string,
  validation: boolean,
  details?: Record<string, unknown>
): ConvertFileOutcome => ({
  ok: false,
  error: { reason, message, validation, ...(details ? { details } : {}) },
});

/** Convert one file; see the module comment. */
export async function convertFile(path: string): Promise<ConvertFileOutcome> {
  const absPath = resolve(path);
  let sizeBytes: number;
  try {
    // stat follows symlinks: a link to a regular file converts, a link to
    // a directory does not.
    const stats = await stat(absPath);
    if (!stats.isFile()) {
      return fail("NOT_FOUND", `Not a regular file: ${path}`, true);
    }
    sizeBytes = stats.size;
  } catch {
    return fail("NOT_FOUND", `File not found: ${path}`, true);
  }

  // Refused before reading, so an oversized file is never loaded.
  if (sizeBytes > DEFAULT_LIMITS.maxBytes) {
    return fail(
      "TOO_LARGE",
      `File size ${sizeBytes} exceeds the indexing limit ${DEFAULT_LIMITS.maxBytes}`,
      true,
      { sizeBytes, limitBytes: DEFAULT_LIMITS.maxBytes }
    );
  }

  const detector = getDefaultMimeDetector();
  const byExtension = detector.detect(absPath, new Uint8Array());
  const recordAdapter = await getDefaultPipeline().selectRecordAdapter(
    byExtension.mime,
    byExtension.ext
  );
  if (recordAdapter) {
    return fail(
      "MULTI_DOCUMENT",
      `${recordAdapter.id} files hold several records; index them in a collection instead`,
      true,
      { format: recordAdapter.id }
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(absPath).bytes();
  } catch (error) {
    // Readable at stat but not at read: removed meanwhile, or no permission.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") {
      return fail("NOT_FOUND", `File not found: ${path}`, true);
    }
    const denied = code === "EACCES" || code === "EPERM";
    return fail(
      denied ? "PERMISSION" : "IO",
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      false
    );
  }
  const { mime, ext } = detector.detect(
    absPath,
    bytes.subarray(0, SNIFF_BYTES)
  );
  const prepared = await prepareInProcessor(
    {
      input: {
        sourcePath: absPath,
        relativePath: basename(absPath),
        collection: "",
        bytes,
        mime,
        ext,
        limits: { ...DEFAULT_LIMITS },
      },
      metadataExt: ext,
      contentTypeRules: [],
      chunkParams: DEFAULT_CHUNK_PARAMS,
      memoryManaged: false,
      markdownSource: markdownConverter.canHandle(mime, ext),
      previous: null,
    },
    {
      timeoutMs: DEFAULT_LIMITS.timeoutMs,
      maxMemoryBytes: defaultConversionMemoryMb() * BYTES_PER_MB,
    },
    { onPrevious: () => undefined }
  );
  if (!prepared.ok) {
    const { code, message, details } = prepared.error;
    return fail(code, message, code === "UNSUPPORTED", details);
  }

  const { artifact } = prepared.value;
  return {
    ok: true,
    value: {
      schemaVersion: CONVERT_SCHEMA_VERSION,
      source: { path: absPath, mime, ext, sizeBytes },
      converter: {
        id: artifact.meta.converterId,
        version: artifact.meta.converterVersion,
      },
      title: artifact.title ?? null,
      languageHint: artifact.languageHint ?? null,
      markdown: artifact.markdown,
      mirrorHash: artifact.mirrorHash,
      warnings: (artifact.meta.warnings ?? []).map(({ code, message }) => ({
        code,
        message,
      })),
    },
  };
}
