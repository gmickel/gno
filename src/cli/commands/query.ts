/**
 * gno query command implementation.
 * Hybrid search with expansion, fusion, and reranking.
 *
 * @module src/cli/commands/query
 */

import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from '../../llm/types';
import { type HybridSearchDeps, searchHybrid } from '../../pipeline/hybrid';
import type { HybridSearchOptions, SearchResults } from '../../pipeline/types';
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from '../../store/vector';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueryCommandOptions = HybridSearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Override embedding model */
  embedModel?: string;
  /** Override generation model */
  genModel?: string;
  /** Override rerank model */
  rerankModel?: string;
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

export type QueryResult =
  | { success: true; data: SearchResults }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno query command.
 */
export async function query(
  queryText: string,
  options: QueryCommandOptions = {}
): Promise<QueryResult> {
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

  let embedPort: EmbeddingPort | null = null;
  let genPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;

  try {
    const preset = getActivePreset(config);
    const llm = new LlmAdapter(config);

    // Create embedding port (for vector search)
    const embedUri = options.embedModel ?? preset.embed;
    const embedResult = await llm.createEmbeddingPort(embedUri);
    if (embedResult.ok) {
      embedPort = embedResult.value;
    }

    // Create generation port (for expansion) - optional
    if (!options.noExpand) {
      const genUri = options.genModel ?? preset.gen;
      const genResult = await llm.createGenerationPort(genUri);
      if (genResult.ok) {
        genPort = genResult.value;
      }
    }

    // Create rerank port - optional
    if (!options.noRerank) {
      const rerankUri = options.rerankModel ?? preset.rerank;
      const rerankResult = await llm.createRerankPort(rerankUri);
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      }
    }

    // Create vector index (optional)
    let vectorIndex: VectorIndexPort | null = null;
    if (embedPort) {
      const probeResult = await embedPort.embed('dimension probe');
      if (probeResult.ok) {
        const dimensions = probeResult.value.length;
        const db = store.getRawDb();
        const vectorResult = await createVectorIndexPort(db, {
          model: embedUri,
          dimensions,
        });
        if (vectorResult.ok) {
          vectorIndex = vectorResult.value;
        }
      }
    }

    const deps: HybridSearchDeps = {
      store,
      config,
      vectorIndex,
      embedPort,
      genPort,
      rerankPort,
    };

    const result = await searchHybrid(deps, queryText, {
      ...options,
      limit,
    });

    if (!result.ok) {
      return { success: false, error: result.error.message };
    }

    return { success: true, data: result.value };
  } finally {
    if (embedPort) {
      await embedPort.dispose();
    }
    if (genPort) {
      await genPort.dispose();
    }
    if (rerankPort) {
      await rerankPort.dispose();
    }
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

  // Show mode info
  const modeInfo: string[] = [];
  if (data.meta.expanded) {
    modeInfo.push('expanded');
  }
  if (data.meta.vectorsUsed) {
    modeInfo.push('hybrid');
  }
  if (data.meta.reranked) {
    modeInfo.push('reranked');
  }
  if (modeInfo.length > 0) {
    lines.push(`Mode: ${modeInfo.join(', ')}`);
    lines.push('');
  }

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
  lines.push(`${data.meta.totalResults} result(s) for "${data.meta.query}"`);
  return lines.join('\n');
}

function formatMarkdown(data: SearchResults): string {
  if (data.results.length === 0) {
    return `# Query Results\n\nNo results found for "${data.meta.query}".`;
  }

  const lines: string[] = [];
  lines.push(`# Query Results for "${data.meta.query}"`);
  lines.push('');

  const modeInfo: string[] = [];
  if (data.meta.expanded) {
    modeInfo.push('expanded');
  }
  if (data.meta.vectorsUsed) {
    modeInfo.push('hybrid');
  }
  if (data.meta.reranked) {
    modeInfo.push('reranked');
  }
  lines.push(
    `*${data.meta.totalResults} result(s) | Mode: ${modeInfo.join(', ') || 'bm25'}*`
  );
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
  lines.push('<queryResults>');
  lines.push(
    `  <meta query="${escapeXml(data.meta.query)}" mode="${data.meta.mode}" expanded="${data.meta.expanded}" reranked="${data.meta.reranked}" total="${data.meta.totalResults}"/>`
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
  lines.push('</queryResults>');
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
 * Format explain data to stderr.
 */
function formatExplainToStderr(data: SearchResults): void {
  if (!data.meta.explain) {
    return;
  }

  const lines: string[] = [];

  // Format pipeline stages
  for (const line of data.meta.explain.lines) {
    lines.push(`[explain] ${line.stage}: ${line.message}`);
  }

  // Format result breakdown
  for (const r of data.meta.explain.results.slice(0, 10)) {
    let msg = `score=${r.score.toFixed(2)}`;
    if (r.bm25Score !== undefined) {
      msg += ` (bm25=${r.bm25Score.toFixed(2)}`;
      if (r.vecScore !== undefined) {
        msg += `, vec=${r.vecScore.toFixed(2)}`;
      }
      if (r.rerankScore !== undefined) {
        msg += `, rerank=${r.rerankScore.toFixed(2)}`;
      }
      msg += ')';
    }
    lines.push(`[explain] result ${r.rank}: ${r.docid} ${msg}`);
  }

  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Format query result for output.
 */
export function formatQuery(
  result: QueryResult,
  options: QueryCommandOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: 'QUERY_FAILED', message: result.error },
        })
      : `Error: ${result.error}`;
  }

  // Output explain to stderr if present
  formatExplainToStderr(result.data);

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
