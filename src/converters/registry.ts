/**
 * Converter registry for routing files to appropriate converters.
 * PRD §8.6 - Converter registry
 */

import type {
  Converter,
  ConvertInput,
  ConvertResult,
  RecordAdapter,
} from "./types";

import { unsupportedError } from "./errors";

export class ConverterRegistry {
  private readonly converters: Converter[] = [];
  private readonly recordAdapters: RecordAdapter[] = [];

  /**
   * Register a converter. Order matters - first match wins.
   */
  register(converter: Converter): void {
    this.converters.push(converter);
  }

  /**
   * Select the first converter that can handle the given MIME/ext.
   * Normalizes to lowercase for consistent matching.
   */
  select(mime: string, ext: string): Converter | undefined {
    const m = mime.toLowerCase();
    const e = ext.toLowerCase();
    return this.converters.find((c) => c.canHandle(m, e));
  }

  /**
   * List all registered converter IDs.
   */
  listConverters(): string[] {
    return this.converters.map((c) => c.id);
  }

  /** Register a streaming container adapter without changing converter routing. */
  registerRecordAdapter(adapter: RecordAdapter): void {
    this.recordAdapters.push(adapter);
  }

  /** Select the first streaming adapter that handles a MIME/extension pair. */
  selectRecordAdapter(mime: string, ext: string): RecordAdapter | undefined {
    const normalizedMime = mime.toLowerCase();
    const normalizedExt = ext.toLowerCase();
    return this.recordAdapters.find((adapter) =>
      adapter.canHandle(normalizedMime, normalizedExt)
    );
  }

  /** List streaming adapters independently of byte-oriented converters. */
  listRecordAdapters(): string[] {
    return this.recordAdapters.map((adapter) => adapter.id);
  }

  /**
   * Convert a file using the appropriate converter.
   */
  convert(input: ConvertInput): Promise<ConvertResult> {
    const converter = this.select(input.mime, input.ext);
    if (!converter) {
      return Promise.resolve({ ok: false, error: unsupportedError(input) });
    }
    return converter.convert(input);
  }
}

/**
 * Create the default registry with all MVP converters.
 * Priority order per PRD §8.6:
 * 1. native/markdown - handles .md
 * 2. native/plaintext - handles .txt
 * 3. adapter/xlsx - handles .xlsx (linear SheetJS -> Markdown tables)
 * 4. adapter/markitdown-ts - handles .pdf, .docx
 * 5. adapter/officeparser - handles .pptx
 */
export async function createDefaultRegistry(): Promise<ConverterRegistry> {
  const registry = new ConverterRegistry();

  // Import converters dynamically to avoid circular deps
  const { markdownConverter } = await import("./native/markdown");
  const { plaintextConverter } = await import("./native/plaintext");
  const { xlsxAdapter } = await import("./adapters/xlsx/adapter");
  const { markitdownAdapter } = await import("./adapters/markitdownTs/adapter");
  const { officeparserAdapter } =
    await import("./adapters/officeparser/adapter");
  const { jsonlAdapter } = await import("./adapters/jsonl/adapter");
  const { transcriptAdapter } = await import("./adapters/transcript/adapter");
  const { emailRecordAdapter } = await import("./adapters/email/adapter");
  const { icalAdapter } = await import("./adapters/ical/adapter");
  const { browserExportAdapter } =
    await import("./adapters/browser-export/adapter");

  // Register in priority order
  registry.register(markdownConverter);
  registry.register(plaintextConverter);
  registry.register(xlsxAdapter);
  registry.register(markitdownAdapter);
  registry.register(officeparserAdapter);
  registry.registerRecordAdapter(jsonlAdapter);
  registry.registerRecordAdapter(transcriptAdapter);
  registry.registerRecordAdapter(emailRecordAdapter);
  registry.registerRecordAdapter(icalAdapter);
  registry.registerRecordAdapter(browserExportAdapter);

  return registry;
}
