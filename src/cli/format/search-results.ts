/**
 * Shared formatters for search/vsearch commands.
 * Centralizes output formatting to avoid duplication.
 *
 * @module src/cli/format/searchResults
 */

import type { SearchResults } from '../../pipeline/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FormatOptions = {
  full?: boolean;
  lineNumbers?: boolean;
  format: 'terminal' | 'json' | 'files' | 'csv' | 'md' | 'xml';
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SNIPPET_LIMIT_TERMINAL = 200;
const SNIPPET_LIMIT_STRUCTURED = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Main Formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format search results based on output format and options.
 */
export function formatSearchResults(
  data: SearchResults,
  options: FormatOptions
): string {
  switch (options.format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'files':
      return formatFiles(data);
    case 'csv':
      return formatCsv(data);
    case 'md':
      return formatMarkdown(data, options);
    case 'xml':
      return formatXml(data, options);
    default:
      return formatTerminal(data, options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format as line protocol per spec.
 * Output: #docid,score,gno://collection/path
 */
function formatFiles(data: SearchResults): string {
  return data.results
    .map((r) => {
      // Defensive: ensure docid starts with #
      const docid = r.docid.startsWith('#') ? r.docid : `#${r.docid}`;
      return `${docid},${r.score.toFixed(4)},${r.uri}`;
    })
    .join('\n');
}

function formatTerminal(data: SearchResults, options: FormatOptions): string {
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
      const content = options.full
        ? r.snippet
        : truncate(r.snippet, SNIPPET_LIMIT_TERMINAL);
      // For --full, snippetRange is undefined; start at line 1
      const startLine = r.snippetRange?.startLine ?? 1;
      const formatted = options.lineNumbers
        ? addLineNumbers(content, startLine)
        : content;
      // Indent multiline snippets
      lines.push(`  ${formatted.replace(/\n/g, '\n  ')}`);
    }
    lines.push('');
  }
  lines.push(
    `${data.meta.totalResults} result(s) for "${data.meta.query}" (${data.meta.mode})`
  );
  return lines.join('\n');
}

function formatMarkdown(data: SearchResults, options: FormatOptions): string {
  const modeLabel = data.meta.mode === 'vector' ? 'Vector ' : '';
  if (data.results.length === 0) {
    return `# ${modeLabel}Search Results\n\nNo results found for "${data.meta.query}".`;
  }

  const lines: string[] = [];
  lines.push(`# ${modeLabel}Search Results for "${data.meta.query}"`);
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
      const content = options.full
        ? r.snippet
        : truncate(r.snippet, SNIPPET_LIMIT_STRUCTURED);
      const startLine = r.snippetRange?.startLine ?? 1;
      const formatted = options.lineNumbers
        ? addLineNumbers(content, startLine)
        : content;
      lines.push('');
      lines.push('```');
      lines.push(formatted);
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
    const title = escapeCsv(r.title ?? '');
    const relPath = escapeCsv(r.source.relPath);
    lines.push(
      `"${r.docid}",${r.score.toFixed(4)},"${r.uri}","${title}","${relPath}"`
    );
  }
  return lines.join('\n');
}

function formatXml(data: SearchResults, options: FormatOptions): string {
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
      const content = options.full
        ? r.snippet
        : truncate(r.snippet, SNIPPET_LIMIT_STRUCTURED);
      const startLine = r.snippetRange?.startLine ?? 1;
      const formatted = options.lineNumbers
        ? addLineNumbers(content, startLine)
        : content;
      lines.push(`    <snippet>${escapeXml(formatted)}</snippet>`);
    }
    lines.push('  </result>');
  }
  lines.push('</searchResults>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function addLineNumbers(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${startLine + i}: ${line}`)
    .join('\n');
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function escapeCsv(str: string): string {
  return str.replace(/"/g, '""');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
