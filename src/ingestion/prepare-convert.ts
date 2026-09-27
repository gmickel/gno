/**
 * Conversion used by the file processor backends (fn-198).
 *
 * Native files (Markdown, plain text) skip the default registry, whose
 * PDF/Office adapters take about half a second to load. The default
 * registry tries these two converters first, so the output is the same.
 *
 * @module src/ingestion/prepare-convert
 */

import type { ConvertInput, PipelineResult } from "../converters/types";

import { markdownConverter } from "../converters/native/markdown";
import { plaintextConverter } from "../converters/native/plaintext";
import { ConversionPipeline, getDefaultPipeline } from "../converters/pipeline";
import { ConverterRegistry } from "../converters/registry";

const nativeRegistry = new ConverterRegistry();
nativeRegistry.register(markdownConverter);
nativeRegistry.register(plaintextConverter);
const nativePipeline = new ConversionPipeline(nativeRegistry);

/** Convert one file, loading the heavy adapters only when needed. */
export function convertForPreparation(
  input: ConvertInput
): Promise<PipelineResult> {
  return (
    nativeRegistry.select(input.mime, input.ext)
      ? nativePipeline
      : getDefaultPipeline()
  ).convert(input);
}
