/**
 * gno vsearch command implementation.
 * Vector semantic search over indexed documents.
 *
 * @module src/cli/commands/vsearch
 */

import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import type { SearchOptions, SearchResults } from '../../pipeline/types';
import { searchVector, type VectorSearchDeps } from '../../pipeline/vsearch';
import { createVectorIndexPort } from '../../store/vector';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VsearchCommandOptions = SearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Override model URI */
  model?: string;
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

export type VsearchResult =
  | { success: true; data: SearchResults }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno vsearch command.
 */
export async function vsearch(
  query: string,
  options: VsearchCommandOptions = {}
): Promise<VsearchResult> {
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

  const { store, config } = initResult;

  try {
    // Get model URI from preset
    const preset = getActivePreset(config);
    const modelUri = options.model ?? preset.embed;

    // Create LLM adapter for embeddings
    const llm = new LlmAdapter(config);
    const embedResult = await llm.createEmbeddingPort(modelUri);
    if (!embedResult.ok) {
      return { success: false, error: embedResult.error.message };
    }

    const embedPort = embedResult.value;

    try {
      // Get dimensions via probe
      const probeResult = await embedPort.embed('dimension probe');
      if (!probeResult.ok) {
        return { success: false, error: probeResult.error.message };
      }
      const dimensions = probeResult.value.length;

      // Create vector index port
      const db = store.getRawDb();
      const vectorResult = await createVectorIndexPort(db, {
        model: modelUri,
        dimensions,
      });

      if (!vectorResult.ok) {
        return { success: false, error: vectorResult.error.message };
      }

      const vectorIndex = vectorResult.value;

      const deps: VectorSearchDeps = {
        store,
        vectorIndex,
        embedPort,
        config,
      };

      const result = await searchVector(deps, query, {
        ...options,
        limit,
      });

      if (!result.ok) {
        return { success: false, error: result.error.message };
      }

      return { success: true, data: result.value };
    } finally {
      await embedPort.dispose();
    }
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters (same as search command)
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
      const snippet =
        r.snippet.length > 200 ? `${r.snippet.slice(0, 200)}...` : r.snippet;
      lines.push(`  ${snippet.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  lines.push(
    `${data.meta.totalResults} result(s) for "${data.meta.query}" (vector)`
  );
  return lines.join('\n');
}

function formatMarkdown(data: SearchResults): string {
  if (data.results.length === 0) {
    return `# Vector Search Results\n\nNo results found for "${data.meta.query}".`;
  }

  const lines: string[] = [];
  lines.push(`# Vector Search Results for "${data.meta.query}"`);
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
 * Format vsearch result for output.
 */
export function formatVsearch(
  result: VsearchResult,
  options: VsearchCommandOptions
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
