/**
 * gno get command implementation.
 * Retrieve single document by reference.
 *
 * @module src/cli/commands/get
 */

import type { DocumentRow, StorePort, StoreResult } from '../../store/types';
import type { ParsedRef } from './ref-parser';
import { parseRef } from './ref-parser';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GetCommandOptions = {
  /** Override config path */
  configPath?: string;
  /** --from <line>, overrides :line suffix */
  from?: number;
  /** -l <lines> */
  limit?: number;
  /** --line-numbers */
  lineNumbers?: boolean;
  /** --source flag for metadata */
  source?: boolean;
  /** JSON output */
  json?: boolean;
  /** Markdown output */
  md?: boolean;
};

export type GetResult =
  | { success: true; data: GetResponse }
  | { success: false; error: string; isValidation?: boolean };

export type GetResponse = {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  totalLines: number;
  returnedLines?: { start: number; end: number };
  language?: string;
  source: {
    absPath?: string;
    relPath: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
    sourceHash?: string;
  };
  conversion?: {
    converterId?: string;
    converterVersion?: string;
    mirrorHash?: string;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Document Lookup Helper
// ─────────────────────────────────────────────────────────────────────────────

function lookupDocument(
  store: StorePort,
  parsed: ParsedRef
): Promise<StoreResult<DocumentRow | null>> {
  switch (parsed.type) {
    case 'docid':
      return store.getDocumentByDocid(parsed.value);
    case 'uri':
      return store.getDocumentByUri(parsed.value);
    case 'collPath':
      if (!(parsed.collection && parsed.relPath)) {
        return Promise.resolve({ ok: true as const, value: null });
      }
      return store.getDocument(parsed.collection, parsed.relPath);
    default:
      // Exhaustive check - should never reach here
      return Promise.resolve({ ok: true as const, value: null });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno get command.
 */
export async function get(
  ref: string,
  options: GetCommandOptions = {}
): Promise<GetResult> {
  const validationError = validateOptions(options);
  if (validationError) {
    return validationError;
  }

  const parsed = parseRef(ref);
  if ('error' in parsed) {
    return { success: false, error: parsed.error, isValidation: true };
  }

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store, config } = initResult;

  try {
    return await fetchDocument(store, parsed, options, config);
  } finally {
    await store.close();
  }
}

function validateOptions(options: GetCommandOptions): GetResult | null {
  if (options.from !== undefined && options.from <= 0) {
    return {
      success: false,
      error: '--from must be a positive integer',
      isValidation: true,
    };
  }
  if (options.limit !== undefined && options.limit < 0) {
    return {
      success: false,
      error: '-l/--limit cannot be negative',
      isValidation: true,
    };
  }
  return null;
}

type ConfigLike = {
  collections: { name: string; path: string }[];
};

async function fetchDocument(
  store: StorePort,
  parsed: ParsedRef,
  options: GetCommandOptions,
  config: ConfigLike
): Promise<GetResult> {
  const docResult = await lookupDocument(store, parsed);
  if (!docResult.ok) {
    return { success: false, error: docResult.error.message };
  }

  const doc = docResult.value;
  if (!doc?.active) {
    return { success: false, error: 'Document not found' };
  }

  if (!doc.mirrorHash) {
    return {
      success: false,
      error: 'Mirror content unavailable (conversion error)',
    };
  }

  const contentResult = await store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    return { success: false, error: 'Mirror content unavailable' };
  }

  return buildResponse({
    doc,
    fullContent: contentResult.value,
    parsed,
    options,
    config,
  });
}

type BuildResponseContext = {
  doc: DocumentRow;
  fullContent: string;
  parsed: ParsedRef;
  options: GetCommandOptions;
  config: ConfigLike;
};

function buildResponse(ctx: BuildResponseContext): GetResult {
  const { doc, fullContent, parsed, options, config } = ctx;
  const lines = fullContent.split('\n');
  const totalLines = lines.length;

  // Handle -l 0 case - return empty content
  if (options.limit === 0) {
    return {
      success: true,
      data: {
        docid: doc.docid,
        uri: doc.uri,
        title: doc.title ?? undefined,
        content: '',
        totalLines,
        language: doc.languageHint ?? undefined,
        source: buildSourceMeta(doc, config),
        conversion: buildConversionMeta(doc),
      },
    };
  }

  // --from overrides :line suffix
  const startLine = options.from ?? parsed.line ?? 1;
  const limit = options.limit ?? totalLines;

  // Clamp to valid range (1-indexed)
  const clampedStart = Math.max(1, Math.min(startLine, totalLines));
  const clampedEnd = Math.min(clampedStart + limit - 1, totalLines);

  const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
  const content = selectedLines.join('\n');
  const isPartial = clampedStart > 1 || clampedEnd < totalLines;

  return {
    success: true,
    data: {
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title ?? undefined,
      content,
      totalLines,
      returnedLines: isPartial
        ? { start: clampedStart, end: clampedEnd }
        : undefined,
      language: doc.languageHint ?? undefined,
      source: buildSourceMeta(doc, config),
      conversion: buildConversionMeta(doc),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type DocRow = {
  collection: string;
  relPath: string;
  sourceMime: string;
  sourceExt: string;
  sourceSize: number;
  sourceHash: string;
};

function buildSourceMeta(
  doc: DocRow,
  config: ConfigLike
): GetResponse['source'] {
  const coll = config.collections.find((c) => c.name === doc.collection);
  const absPath = coll ? `${coll.path}/${doc.relPath}` : undefined;

  return {
    absPath,
    relPath: doc.relPath,
    mime: doc.sourceMime,
    ext: doc.sourceExt,
    sizeBytes: doc.sourceSize,
    sourceHash: doc.sourceHash,
  };
}

type ConversionDoc = {
  converterId?: string | null;
  converterVersion?: string | null;
  mirrorHash?: string | null;
};

function buildConversionMeta(
  doc: ConversionDoc
): GetResponse['conversion'] | undefined {
  if (!doc.converterId) {
    return;
  }
  return {
    converterId: doc.converterId,
    converterVersion: doc.converterVersion ?? undefined,
    mirrorHash: doc.mirrorHash ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────────

function addLineNumbers(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');
}

function getContentWithLineNumbers(
  data: GetResponse,
  options: GetCommandOptions
): string {
  if (!options.lineNumbers) {
    return data.content;
  }
  const startLine = data.returnedLines?.start ?? 1;
  return addLineNumbers(data.content, startLine);
}

/**
 * Format get result for output.
 */
export function formatGet(
  result: GetResult,
  options: GetCommandOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: 'GET_FAILED', message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    return formatMarkdown(data, options);
  }

  // Terminal format
  return getContentWithLineNumbers(data, options);
}

function formatMarkdown(data: GetResponse, options: GetCommandOptions): string {
  const lines: string[] = [];
  lines.push(`# ${data.title || data.source.relPath}`);
  lines.push('');
  lines.push(`- **URI**: \`${data.uri}\``);
  lines.push(`- **DocID**: \`${data.docid}\``);
  if (data.returnedLines) {
    lines.push(
      `- **Lines**: ${data.returnedLines.start}-${data.returnedLines.end} of ${data.totalLines}`
    );
  }
  lines.push('');
  lines.push('```');
  lines.push(getContentWithLineNumbers(data, options));
  lines.push('```');
  return lines.join('\n');
}
