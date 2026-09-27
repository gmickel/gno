/**
 * Conversion pipeline - single entry point for all document conversions.
 * PRD §8.4 - Canonical Markdown conventions
 *
 * The pipeline:
 * 1. Delegates to the registry to find and invoke the appropriate converter
 * 2. Enforces pre-canonicalization output size limit (early bailout)
 * 3. Canonicalizes the raw markdown output (centralized, not per-converter)
 * 4. Enforces post-canonicalization output size limit (zip bomb protection)
 * 5. Computes mirrorHash from canonical markdown
 * 6. Returns ConversionArtifact (not ConvertOutput)
 *
 * CRITICAL: Canonicalization is ONLY done here, not in individual converters.
 */

import type {
  ConversionArtifact,
  ConvertInput,
  PipelineResult,
  RecordAdapter,
} from "./types";

import { canonicalize, mirrorHash } from "./canonicalize";
import { internalError, outputTooLargeError } from "./errors";
import { type ConverterRegistry, createDefaultRegistry } from "./registry";

export class ConversionPipeline {
  private registry: ConverterRegistry | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Create a pipeline with default registry.
   * Registry is lazily initialized on first use.
   */
  constructor(registry?: ConverterRegistry) {
    if (registry) {
      this.registry = registry;
    }
  }

  /**
   * Ensure registry is initialized.
   * Resets initPromise on failure to allow retry.
   */
  private async ensureRegistry(): Promise<ConverterRegistry> {
    if (this.registry) {
      return this.registry;
    }

    if (!this.initPromise) {
      this.initPromise = createDefaultRegistry().then((r) => {
        this.registry = r;
      });
    }

    try {
      await this.initPromise;
    } catch (err) {
      // Reset to allow retry on next call
      this.initPromise = null;
      throw err;
    }

    // Safe: after await, this.registry is always set
    return this.registry as unknown as ConverterRegistry;
  }

  /**
   * Convert a file through the pipeline.
   * Returns ConversionArtifact with canonical markdown and mirrorHash.
   *
   * All exceptions are caught and mapped to INTERNAL errors.
   */
  async convert(input: ConvertInput): Promise<PipelineResult> {
    try {
      // 0. Initialize registry
      const registry = await this.ensureRegistry();

      // 1. Delegate to registry (finds converter + invokes)
      const result = await registry.convert(input);

      if (!result.ok) {
        return result; // Pass through error
      }

      const maxChars = input.limits.maxOutputChars ?? 0;
      const rawMarkdown = result.value.markdown;

      // 2. Pre-canonicalization size check (early bailout to avoid expensive canonicalization)
      if (maxChars > 0 && rawMarkdown.length > maxChars) {
        return {
          ok: false,
          error: outputTooLargeError(input, "pipeline", {
            outputChars: rawMarkdown.length,
            limitChars: maxChars,
            stage: "raw",
          }),
        };
      }

      // 3. Canonicalize the raw markdown output
      const canonical = canonicalize(rawMarkdown);

      // 4. Post-canonicalization size check (canonicalization may expand slightly)
      if (maxChars > 0 && canonical.length > maxChars) {
        return {
          ok: false,
          error: outputTooLargeError(input, "pipeline", {
            outputChars: canonical.length,
            limitChars: maxChars,
            stage: "canonical",
          }),
        };
      }

      // 5. Compute content-addressed hash
      const hash = mirrorHash(canonical);

      // 6. Return artifact with all pipeline-computed fields
      const artifact: ConversionArtifact = {
        markdown: canonical,
        mirrorHash: hash,
        title: result.value.title,
        languageHint: result.value.languageHint,
        meta: result.value.meta,
      };

      return { ok: true, value: artifact };
    } catch (cause) {
      // Catch any unhandled exceptions and map to INTERNAL error
      return {
        ok: false,
        error: internalError(
          input,
          "pipeline",
          cause instanceof Error ? cause.message : "Unknown pipeline error",
          cause
        ),
      };
    }
  }

  /** Select a streaming multi-record adapter without reading the full file. */
  async selectRecordAdapter(
    mime: string,
    ext: string
  ): Promise<RecordAdapter | undefined> {
    const registry = await this.ensureRegistry();
    return registry.selectRecordAdapter(mime, ext);
  }

  /**
   * List available converters.
   */
  async listConverters(): Promise<string[]> {
    const registry = await this.ensureRegistry();
    return registry.listConverters();
  }
}

/** Singleton for simple usage */
let defaultPipeline: ConversionPipeline | null = null;

export function getDefaultPipeline(): ConversionPipeline {
  if (!defaultPipeline) {
    defaultPipeline = new ConversionPipeline();
  }
  return defaultPipeline;
}

/** Reset singleton (for testing) */
export function resetDefaultPipeline(): void {
  defaultPipeline = null;
}
