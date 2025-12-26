/**
 * gno ls command implementation.
 * List indexed documents.
 *
 * @module src/cli/commands/ls
 */

import type { DocumentRow, StorePort, StoreResult } from '../../store/types';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LsCommandOptions = {
  /** Override config path */
  configPath?: string;
  /** Max results (default 20) */
  limit?: number;
  /** Skip first N results */
  offset?: number;
  /** JSON output */
  json?: boolean;
  /** File protocol output */
  files?: boolean;
  /** Markdown output */
  md?: boolean;
};

export type LsResult =
  | { success: true; data: LsResponse }
  | { success: false; error: string; isValidation?: boolean };

export type LsDocument = {
  docid: string;
  uri: string;
  title?: string;
  source: { relPath: string; mime: string; ext: string };
};

export type LsResponse = {
  documents: LsDocument[];
  meta: {
    total: number;
    returned: number;
    offset: number;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Scope validation regex
// ─────────────────────────────────────────────────────────────────────────────

const URI_PREFIX_PATTERN = /^gno:\/\/[^/]+\//;

// ─────────────────────────────────────────────────────────────────────────────
// Document Fetching Helper
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDocuments(
  store: StorePort,
  scope: string | undefined
): Promise<StoreResult<DocumentRow[]>> {
  if (!scope) {
    return store.listDocuments();
  }

  if (scope.startsWith('gno://')) {
    const allDocs = await store.listDocuments();
    if (!allDocs.ok) {
      return allDocs;
    }
    return {
      ok: true,
      value: allDocs.value.filter((d) => d.uri.startsWith(scope)),
    };
  }

  return store.listDocuments(scope);
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno ls command.
 */
export async function ls(
  scope: string | undefined,
  options: LsCommandOptions = {}
): Promise<LsResult> {
  // Validate scope if it's a gno:// URI
  if (scope?.startsWith('gno://')) {
    if (scope === 'gno://') {
      return {
        success: false,
        error: 'Invalid scope: missing collection',
        isValidation: true,
      };
    }
    if (!URI_PREFIX_PATTERN.test(scope)) {
      return {
        success: false,
        error: 'Invalid scope: missing trailing path (use gno://collection/)',
        isValidation: true,
      };
    }
  }

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    const docs = await fetchDocuments(store, scope);
    if (!docs.ok) {
      return { success: false, error: docs.error.message };
    }

    // Filter active only, sort by URI
    const allActive = docs.value
      .filter((d) => d.active)
      .map((d) => ({
        docid: d.docid,
        uri: d.uri,
        title: d.title ?? undefined,
        source: {
          relPath: d.relPath,
          mime: d.sourceMime,
          ext: d.sourceExt,
        },
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri));

    // Apply offset and limit
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;
    const paged = allActive.slice(offset, offset + limit);

    return {
      success: true,
      data: {
        documents: paged,
        meta: {
          total: allActive.length,
          returned: paged.length,
          offset,
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

/**
 * Format ls result for output.
 */
export function formatLs(result: LsResult, options: LsCommandOptions): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: 'LS_FAILED', message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;
  const docs = data.documents;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.files) {
    return docs.map((d) => `${d.docid},${d.uri}`).join('\n');
  }

  if (options.md) {
    if (docs.length === 0) {
      return '# Documents\n\nNo documents found.';
    }
    const lines: string[] = [];
    lines.push('# Documents');
    lines.push('');
    lines.push(
      `*Showing ${data.meta.returned} of ${data.meta.total} documents*`
    );
    lines.push('');
    lines.push('| DocID | URI | Title |');
    lines.push('|-------|-----|-------|');
    for (const d of docs) {
      lines.push(`| \`${d.docid}\` | \`${d.uri}\` | ${d.title || '-'} |`);
    }
    return lines.join('\n');
  }

  // Terminal format
  if (docs.length === 0) {
    return 'No documents found.';
  }
  const lines = docs.map((d) => `${d.docid}\t${d.uri}`);
  if (data.meta.returned < data.meta.total) {
    lines.push(
      `\n(${data.meta.returned} of ${data.meta.total} documents shown)`
    );
  }
  return lines.join('\n');
}
