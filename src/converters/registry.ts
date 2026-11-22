/**
 * Converter registry for routing files to appropriate converters.
 * PRD §8.6 - Converter registry
 */

import type {
  Converter,
  ConverterId,
  ConvertInput,
  ConvertResult,
  RecordAdapter,
} from "./types";

import {
  MARKITDOWN_CONVERTER_ID,
  markitdownCanHandle,
} from "./adapters/markitdownTs/match";
import {
  OFFICEPARSER_CONVERTER_ID,
  officeparserCanHandle,
} from "./adapters/officeparser/match";
import { adapterError, unsupportedError } from "./errors";
import { ADAPTER_VERSIONS } from "./versions";

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

/** Identity and routing of an adapter whose module loads on first use. */
export interface LazyAdapterSpec {
  id: ConverterId;
  version: string;
  canHandle: Converter["canHandle"];
}

/**
 * An adapter that loads its module on its first conversion. Routing and
 * identity come from the spec, so selecting a converter or a record adapter
 * never loads the parser: the PDF/Office parsers took 9-11 s to load on a
 * cold Windows runner, inside every `gno update` (fn-201). If the module
 * cannot load in this runtime (pdf.js without its native canvas binding in a
 * standalone executable), its file types fail with ADAPTER_FAILURE and the
 * reason, and other file types are unaffected.
 */
export function lazyAdapter(
  spec: LazyAdapterSpec,
  load: () => Promise<Converter>
): Converter {
  let loaded: Promise<Converter> | undefined;
  return {
    id: spec.id,
    version: spec.version,
    canHandle: spec.canHandle,
    async convert(input) {
      loaded ??= load().catch((cause: unknown) =>
        unavailableAdapter(
          spec,
          cause instanceof Error ? cause.message : String(cause)
        )
      );
      return (await loaded).convert(input);
    },
  };
}

function unavailableAdapter(spec: LazyAdapterSpec, reason: string): Converter {
  return {
    ...spec,
    convert: (input) =>
      Promise.resolve({
        ok: false,
        error: adapterError(
          input,
          spec.id,
          `${spec.id} is unavailable in this build: ${reason}`
        ),
      }),
  };
}

/** Identity and routing of a record adapter whose module loads on first use. */
export interface LazyRecordAdapterSpec {
  id: string;
  version: string;
  configurationFingerprint?: string;
  canHandle: RecordAdapter["canHandle"];
}

/**
 * A streaming record adapter that defers loading its parser module until first
 * invocation. Routing, identity, and configuration fingerprint match the eager
 * adapter identically while keeping startup free of unused adapter modules.
 */
export function lazyRecordAdapter(
  spec: LazyRecordAdapterSpec,
  load: () => Promise<RecordAdapter>
): RecordAdapter {
  let loaded: Promise<RecordAdapter> | undefined;
  return {
    id: spec.id,
    version: spec.version,
    ...(spec.configurationFingerprint !== undefined
      ? { configurationFingerprint: spec.configurationFingerprint }
      : {}),
    canHandle: spec.canHandle,
    async *records(input) {
      loaded ??= load();
      let adapter: RecordAdapter;
      try {
        adapter = await loaded;
      } catch (cause) {
        loaded = undefined;
        yield {
          type: "failure",
          failure: {
            code: "ADAPTER_FAILURE",
            message: `${spec.id} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
            retryable: true,
          },
        };
        yield { type: "snapshot", state: "partial" };
        return;
      }
      yield* adapter.records(input);
    },
  };
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_JSONL_CONFIG_FINGERPRINT =
  "35e7c3045f7eef59f74a6b6bfe450e5e50f37ef5e023edd0bc1c4327035cc5a2";
const DEFAULT_TRANSCRIPT_CONFIG_FINGERPRINT =
  "f1de45113a28155cdbe998e44af239561c91e4357cfd9a7b05f7765f5ba20cf4";

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

  // Only lightweight native converters load eagerly; heavy office parsers and
  // streaming record adapters defer module evaluation until first matched.
  const { markdownConverter } = await import("./native/markdown");
  const { plaintextConverter } = await import("./native/plaintext");
  const xlsxAdapter = lazyAdapter(
    {
      id: "adapter/xlsx",
      version: ADAPTER_VERSIONS.xlsx,
      canHandle: (mime, ext) => ext === ".xlsx" || mime === XLSX_MIME,
    },
    async () => (await import("./adapters/xlsx/adapter")).xlsxAdapter
  );
  const markitdownAdapter = lazyAdapter(
    {
      id: MARKITDOWN_CONVERTER_ID,
      version: ADAPTER_VERSIONS["markitdown-ts"],
      canHandle: markitdownCanHandle,
    },
    async () =>
      (await import("./adapters/markitdownTs/adapter")).markitdownAdapter
  );
  const officeparserAdapter = lazyAdapter(
    {
      id: OFFICEPARSER_CONVERTER_ID,
      version: ADAPTER_VERSIONS.officeparser,
      canHandle: officeparserCanHandle,
    },
    async () =>
      (await import("./adapters/officeparser/adapter")).officeparserAdapter
  );
  const jsonlAdapter = lazyRecordAdapter(
    {
      id: "adapter/jsonl",
      version: "1.0.0",
      configurationFingerprint: DEFAULT_JSONL_CONFIG_FINGERPRINT,
      canHandle: (mime, ext) =>
        mime === "application/x-ndjson" ||
        mime === "application/jsonl" ||
        ext === ".jsonl" ||
        ext === ".ndjson",
    },
    async () => (await import("./adapters/jsonl/adapter")).jsonlAdapter
  );
  const transcriptAdapter = lazyRecordAdapter(
    {
      id: "adapter/transcript",
      version: "1.0.0",
      configurationFingerprint: DEFAULT_TRANSCRIPT_CONFIG_FINGERPRINT,
      canHandle: (mime, ext) =>
        mime === "text/vtt" ||
        ext === ".vtt" ||
        mime === "application/x-subrip" ||
        mime === "text/srt" ||
        ext === ".srt",
    },
    async () =>
      (await import("./adapters/transcript/adapter")).transcriptAdapter
  );
  const emailRecordAdapter = lazyRecordAdapter(
    {
      id: "native/email-export",
      version: "1.0.0",
      canHandle: (mime, ext) => {
        const normalizedMime = mime.toLowerCase();
        const normalizedExt = ext.toLowerCase();
        return (
          normalizedExt === ".eml" ||
          normalizedExt === ".mbox" ||
          normalizedMime === "message/rfc822" ||
          normalizedMime === "application/mbox"
        );
      },
    },
    async () => (await import("./adapters/email/adapter")).emailRecordAdapter
  );
  const icalAdapter = lazyRecordAdapter(
    {
      id: "adapter/ical-export",
      version: "1.0.0",
      canHandle: (mime, ext) => mime === "text/calendar" || ext === ".ics",
    },
    async () => (await import("./adapters/ical/adapter")).icalAdapter
  );
  const browserExportAdapter = lazyRecordAdapter(
    {
      id: "adapter/browser-export",
      version: "1.0.0",
      canHandle: (mime, ext) =>
        mime === "application/x-gno-browser-export+json" ||
        mime === "text/x-gno-browser-bookmarks+html" ||
        ext === ".browser-export",
    },
    async () =>
      (await import("./adapters/browser-export/adapter")).browserExportAdapter
  );

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
