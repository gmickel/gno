/**
 * gno multi-get command implementation.
 * Retrieve multiple documents by reference.
 *
 * @module src/cli/commands/multi-get
 */

import { minimatch } from 'minimatch';
import type { DocumentRow, StorePort, StoreResult } from '../../store/types';
import type { ParsedRef } from './ref-parser';
import { isGlobPattern, parseRef, splitRefs } from './ref-parser';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MultiGetCommandOptions = {
  /** Override config path */
  configPath?: string;
  /** Max bytes per document (default 10240) */
  maxBytes?: number;
  /** Include line numbers */
  lineNumbers?: boolean;
  /** JSON output */
  json?: boolean;
  /** File protocol output */
  files?: boolean;
  /** Markdown output */
  md?: boolean;
};

export type MultiGetResult =
  | { success: true; data: MultiGetResponse }
  | { success: false; error: string; isValidation?: boolean };

export type MultiGetDocument = {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  truncated?: boolean;
  totalLines?: number;
  source: { absPath?: string; relPath: string; mime: string; ext: string };
};

export type SkippedDoc = {
  ref: string;
  reason: 'not_found' | 'conversion_error' | 'invalid_ref';
};

export type MultiGetResponse = {
  documents: MultiGetDocument[];
  skipped: SkippedDoc[];
  meta: {
    requested: number;
    returned: number;
    skipped: number;
    maxBytes?: number;
  };
};

type ConfigLike = {
  collections: { name: string; path: string }[];
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
      return Promise.resolve({ ok: true as const, value: null });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob Expansion
// ─────────────────────────────────────────────────────────────────────────────

type ExpandResult = {
  expanded: string[];
  invalidRefs: string[];
};

async function expandGlobs(
  refs: string[],
  store: StorePort
): Promise<ExpandResult> {
  const expanded: string[] = [];
  const invalidRefs: string[] = [];

  for (const ref of refs) {
    if (!isGlobPattern(ref)) {
      expanded.push(ref);
      continue;
    }

    const slashIdx = ref.indexOf('/');
    if (slashIdx === -1) {
      invalidRefs.push(ref);
      continue;
    }

    const collection = ref.slice(0, slashIdx);
    const pattern = ref.slice(slashIdx + 1);
    const listResult = await store.listDocuments(collection);

    if (listResult.ok) {
      for (const doc of listResult.value) {
        if (doc.active && minimatch(doc.relPath, pattern)) {
          expanded.push(`${collection}/${doc.relPath}`);
        }
      }
    }
  }

  return { expanded, invalidRefs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content Truncation
// ─────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function truncateContent(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  if (encoder.encode(content).length <= maxBytes) {
    return { content, truncated: false };
  }

  const lines = content.split('\n');
  let accumulated = '';
  let byteLen = 0;

  for (const line of lines) {
    const lineBytes = encoder.encode(`${line}\n`).length;
    if (byteLen + lineBytes > maxBytes) {
      return { content: accumulated.trimEnd(), truncated: true };
    }
    accumulated += `${line}\n`;
    byteLen += lineBytes;
  }

  return { content: accumulated.trimEnd(), truncated: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Fetching
// ─────────────────────────────────────────────────────────────────────────────

type FetchContext = {
  store: StorePort;
  config: ConfigLike;
  maxBytes: number;
  documents: MultiGetDocument[];
  skipped: SkippedDoc[];
  seen: Set<string>;
};

async function fetchSingleDocument(
  ref: string,
  ctx: FetchContext
): Promise<void> {
  if (ctx.seen.has(ref)) {
    return;
  }
  ctx.seen.add(ref);

  const parsed = parseRef(ref);
  if ('error' in parsed) {
    ctx.skipped.push({ ref, reason: 'invalid_ref' });
    return;
  }

  const docResult = await lookupDocument(ctx.store, parsed);
  if (!docResult.ok) {
    ctx.skipped.push({ ref, reason: 'not_found' });
    return;
  }

  const doc = docResult.value;
  if (!doc?.active) {
    ctx.skipped.push({ ref, reason: 'not_found' });
    return;
  }

  if (!doc.mirrorHash) {
    ctx.skipped.push({ ref, reason: 'conversion_error' });
    return;
  }

  const contentResult = await ctx.store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    ctx.skipped.push({ ref, reason: 'conversion_error' });
    return;
  }

  const { content, truncated } = truncateContent(
    contentResult.value,
    ctx.maxBytes
  );
  const coll = ctx.config.collections.find((c) => c.name === doc.collection);

  ctx.documents.push({
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title ?? undefined,
    content,
    truncated: truncated || undefined,
    totalLines: content.split('\n').length,
    source: {
      absPath: coll ? `${coll.path}/${doc.relPath}` : undefined,
      relPath: doc.relPath,
      mime: doc.sourceMime,
      ext: doc.sourceExt,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno multi-get command.
 */
export async function multiGet(
  refs: string[],
  options: MultiGetCommandOptions = {}
): Promise<MultiGetResult> {
  const maxBytes = options.maxBytes ?? 10_240;
  const allRefs = splitRefs(refs);

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store, config } = initResult;

  try {
    const { expanded: expandedRefs, invalidRefs } = await expandGlobs(
      allRefs,
      store
    );
    const ctx: FetchContext = {
      store,
      config,
      maxBytes,
      documents: [],
      skipped: [],
      seen: new Set(),
    };

    // Track invalid refs as skipped
    for (const ref of invalidRefs) {
      ctx.skipped.push({ ref, reason: 'invalid_ref' });
    }

    for (const ref of expandedRefs) {
      await fetchSingleDocument(ref, ctx);
    }

    const totalRequested = expandedRefs.length + invalidRefs.length;
    return {
      success: true,
      data: {
        documents: ctx.documents,
        skipped: ctx.skipped,
        meta: {
          requested: totalRequested,
          returned: ctx.documents.length,
          skipped: ctx.skipped.length,
          maxBytes,
        },
      },
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────────

function addLineNumbers(text: string, startLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');
}

function formatContent(content: string, lineNumbers: boolean): string {
  return lineNumbers ? addLineNumbers(content) : content;
}

function formatMarkdown(
  data: MultiGetResponse,
  options: MultiGetCommandOptions
): string {
  const lines: string[] = [];
  lines.push('# Multi-Get Results');
  lines.push('');
  lines.push(`*${data.meta.returned} of ${data.meta.requested} documents*`);
  lines.push('');

  for (const doc of data.documents) {
    lines.push(`## ${doc.title || doc.source.relPath}`);
    lines.push(`- **URI**: \`${doc.uri}\``);
    if (doc.truncated) {
      lines.push(`- **Truncated**: yes (max ${data.meta.maxBytes} bytes)`);
    }
    lines.push('');
    lines.push('```');
    lines.push(formatContent(doc.content, Boolean(options.lineNumbers)));
    lines.push('```');
    lines.push('');
  }

  if (data.skipped.length > 0) {
    lines.push('## Skipped');
    for (const s of data.skipped) {
      lines.push(`- ${s.ref}: ${s.reason}`);
    }
  }

  return lines.join('\n');
}

function formatTerminal(
  data: MultiGetResponse,
  options: MultiGetCommandOptions
): string {
  const lines: string[] = [];

  for (const doc of data.documents) {
    lines.push(`=== ${doc.uri} ===`);
    lines.push(formatContent(doc.content, Boolean(options.lineNumbers)));
    lines.push('');
  }

  if (data.skipped.length > 0) {
    lines.push(`Skipped: ${data.skipped.map((s) => s.ref).join(', ')}`);
  }

  lines.push(
    `${data.meta.returned}/${data.meta.requested} documents retrieved`
  );
  return lines.join('\n');
}

/**
 * Format multi-get result for output.
 */
export function formatMultiGet(
  result: MultiGetResult,
  options: MultiGetCommandOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: 'MULTI_GET_FAILED', message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.files) {
    return data.documents.map((d) => `${d.docid},${d.uri}`).join('\n');
  }

  if (options.md) {
    return formatMarkdown(data, options);
  }

  return formatTerminal(data, options);
}
