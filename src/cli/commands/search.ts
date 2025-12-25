/**
 * gno search command implementation.
 * BM25 keyword search over indexed documents.
 *
 * @module src/cli/commands/search
 */

import { searchBm25 } from '../../pipeline/search';
import type { SearchOptions, SearchResults } from '../../pipeline/types';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SearchCommandOptions = SearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
  /** Output as CSV */
  csv?: boolean;
  /** Output as XML */
  xml?: boolean;
  /** Output files only */
  files?: boolean;
};

export type SearchResult =
  | { success: true; data: SearchResults }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno search command.
 */
export async function search(
  query: string,
  options: SearchCommandOptions = {}
): Promise<SearchResult> {
  // Adjust default limit based on output format
  const isStructured =
    options.json || options.files || options.csv || options.xml;
  const limit = options.limit ?? (isStructured ? 20 : 5);

  const initResult = await initStore({
    configPath: options.configPath,
    collection: options.collection,
  });

  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store } = initResult;

  try {
    const result = await searchBm25(store, query, {
      ...options,
      limit,
    });

    if (!result.ok) {
      return { success: false, error: result.error.message };
    }

    return { success: true, data: result.value };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatTerminal(data: SearchResults): string {
  if (data.results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];
  for (const r of data.results) {
    lines.push(`[${r.docid}] ${r.uri} (score: ${r.score.toFixed(2)})`);
    if (r.title) {
      lines.push(`  ${r.title}`);
    }
    if (r.snippet) {
      // Truncate long snippets
      const snippet =
        r.snippet.length > 200 ? `${r.snippet.slice(0, 200)}...` : r.snippet;
      lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  lines.push(`${data.meta.totalResults} result(s) for "${data.meta.query}"`);
  return lines.join('\n');
}

function formatMarkdown(data: SearchResults): string {
  if (data.results.length === 0) {
    return `# Search Results\n\nNo results found for "${data.meta.query}".`;
  }

  const lines: string[] = [];
  lines.push(`# Search Results for "${data.meta.query}"`);
  lines.push('');
  lines.push(`*${data.meta.totalResults} result(s)*`);
  lines.push('');

  for (const r of data.results) {
    lines.push(`## ${r.title || r.source.relPath}`);
    lines.push('');
    lines.push(`- **URI**: \`${r.uri}\``);
    lines.push(`- **Score**: ${r.score.toFixed(2)}`);
    lines.push(`- **DocID**: \`${r.docid}\``);
    if (r.snippet) {
      lines.push('');
      lines.push('```');
      lines.push(r.snippet.slice(0, 500));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatCsv(data: SearchResults): string {
  const lines: string[] = [];
  lines.push('docid,score,uri,title,relPath');
  for (const r of data.results) {
    const title = (r.title ?? '').replace(/"/g, '""');
    lines.push(
      `"${r.docid}",${r.score.toFixed(4)},"${r.uri}","${title}","${r.source.relPath}"`
    );
  }
  return lines.join('\n');
}

function formatXml(data: SearchResults): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<searchResults>');
  lines.push(
    `  <meta query="${escapeXml(data.meta.query)}" mode="${data.meta.mode}" total="${data.meta.totalResults}"/>`
  );
  for (const r of data.results) {
    lines.push('  <result>');
    lines.push(`    <docid>${escapeXml(r.docid)}</docid>`);
    lines.push(`    <score>${r.score}</score>`);
    lines.push(`    <uri>${escapeXml(r.uri)}</uri>`);
    if (r.title) {
      lines.push(`    <title>${escapeXml(r.title)}</title>`);
    }
    lines.push(`    <relPath>${escapeXml(r.source.relPath)}</relPath>`);
    if (r.snippet) {
      lines.push(
        `    <snippet>${escapeXml(r.snippet.slice(0, 500))}</snippet>`
      );
    }
    lines.push('  </result>');
  }
  lines.push('</searchResults>');
  return lines.join('\n');
}

function formatFiles(data: SearchResults): string {
  // Output just file paths, one per line
  return data.results
    .map((r) => r.source.absPath ?? r.source.relPath)
    .join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format search result for output.
 */
export function formatSearch(
  result: SearchResult,
  options: SearchCommandOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: 'QUERY_FAILED', message: result.error },
        })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.data, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result.data);
  }

  if (options.csv) {
    return formatCsv(result.data);
  }

  if (options.xml) {
    return formatXml(result.data);
  }

  if (options.files) {
    return formatFiles(result.data);
  }

  return formatTerminal(result.data);
}
