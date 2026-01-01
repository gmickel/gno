/**
 * gno ask command implementation.
 * Human-friendly query with citations and optional grounded answer.
 *
 * @module src/cli/commands/ask
 */

import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from '../../llm/types';
import {
  generateGroundedAnswer,
  processAnswerResult,
} from '../../pipeline/answer';
import { type HybridSearchDeps, searchHybrid } from '../../pipeline/hybrid';
import type { AskOptions, AskResult, Citation } from '../../pipeline/types';
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from '../../store/vector';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AskCommandOptions = AskOptions & {
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
  /** Show all retrieved sources (not just cited) */
  showSources?: boolean;
};

export type AskCommandResult =
  | { success: true; data: AskResult }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno ask command.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI orchestration with multiple output formats
export async function ask(
  query: string,
  options: AskCommandOptions = {}
): Promise<AskCommandResult> {
  const limit = options.limit ?? 5;

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

    // Create embedding port
    const embedUri = options.embedModel ?? preset.embed;
    const embedResult = await llm.createEmbeddingPort(embedUri);
    if (embedResult.ok) {
      embedPort = embedResult.value;
    }

    // Create generation port (for expansion and/or answer)
    // Need genPort if: expansion enabled (!noExpand) OR answer requested
    const needsGen = !options.noExpand || options.answer;
    if (needsGen) {
      const genUri = options.genModel ?? preset.gen;
      const genResult = await llm.createGenerationPort(genUri);
      if (genResult.ok) {
        genPort = genResult.value;
      }
    }

    // Create rerank port (unless --fast or --no-rerank)
    if (!options.noRerank) {
      const rerankUri = options.rerankModel ?? preset.rerank;
      const rerankResult = await llm.createRerankPort(rerankUri);
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      }
    }

    // Create vector index
    let vectorIndex: VectorIndexPort | null = null;
    if (embedPort) {
      const embedInitResult = await embedPort.init();
      if (embedInitResult.ok) {
        const dimensions = embedPort.dimensions();
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

    // Check if answer generation is explicitly requested
    const answerRequested = options.answer && !options.noAnswer;

    // Fail early if --answer is requested but no generation model available
    if (answerRequested && genPort === null) {
      return {
        success: false,
        error:
          'Answer generation requested but no generation model available. ' +
          'Run `gno models pull --gen` to download a model, or configure a preset.',
      };
    }

    // Run hybrid search
    const searchResult = await searchHybrid(deps, query, {
      limit,
      collection: options.collection,
      lang: options.lang,
      noExpand: options.noExpand,
      noRerank: options.noRerank,
    });

    if (!searchResult.ok) {
      return { success: false, error: searchResult.error.message };
    }

    const results = searchResult.value.results;

    // Generate grounded answer if requested
    let answer: string | undefined;
    let citations: Citation[] | undefined;
    let answerGenerated = false;

    // Only generate answer if:
    // 1. --answer was explicitly requested (not just default behavior)
    // 2. --no-answer was not set
    // 3. We have results to ground on (no point generating from nothing)
    const shouldGenerateAnswer =
      answerRequested && genPort !== null && results.length > 0;

    if (shouldGenerateAnswer && genPort) {
      const maxTokens = options.maxAnswerTokens ?? 512;
      const rawResult = await generateGroundedAnswer(
        { genPort, store },
        query,
        results,
        maxTokens
      );

      // Fail loudly if generation was requested but failed
      if (!rawResult) {
        return {
          success: false,
          error:
            'Answer generation failed. The generation model may have encountered an error.',
        };
      }

      // Process answer: extract valid citations, filter, renumber
      const processed = processAnswerResult(rawResult);
      answer = processed.answer;
      citations = processed.citations;
      answerGenerated = true;
    }

    const askResult: AskResult = {
      query,
      mode: searchResult.value.meta.vectorsUsed ? 'hybrid' : 'bm25_only',
      queryLanguage: searchResult.value.meta.queryLanguage ?? 'und',
      answer,
      citations,
      results,
      meta: {
        expanded: searchResult.value.meta.expanded ?? false,
        reranked: searchResult.value.meta.reranked ?? false,
        vectorsUsed: searchResult.value.meta.vectorsUsed ?? false,
        answerGenerated,
        totalResults: results.length,
      },
    };

    return { success: true, data: askResult };
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

interface FormatOptions {
  showSources?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: terminal formatting with conditional sections
function formatTerminal(data: AskResult, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const hasAnswer = Boolean(data.answer);

  // Show answer if present
  if (data.answer) {
    lines.push('Answer:');
    lines.push(data.answer);
    lines.push('');
  }

  // Show cited sources (only sources actually referenced in answer)
  if (data.citations && data.citations.length > 0) {
    lines.push('Cited Sources:');
    for (let i = 0; i < data.citations.length; i++) {
      const c = data.citations[i];
      if (c) {
        lines.push(`  [${i + 1}] ${c.uri}`);
      }
    }
    lines.push('');
  }

  // Show all retrieved sources if:
  // - No answer was generated (retrieval-only mode)
  // - User explicitly requested with --show-sources
  const showAllSources = !hasAnswer || opts.showSources;
  if (showAllSources && data.results.length > 0) {
    lines.push(hasAnswer ? 'All Retrieved Sources:' : 'Sources:');
    for (const r of data.results) {
      lines.push(`  [${r.docid}] ${r.uri}`);
      if (r.title) {
        lines.push(`    ${r.title}`);
      }
    }
  } else if (hasAnswer && data.results.length > 0) {
    // Hint about --show-sources when we have more sources
    const citedCount = data.citations?.length ?? 0;
    if (data.results.length > citedCount) {
      lines.push(
        `(${data.results.length} sources retrieved, use --show-sources to list all)`
      );
    }
  }

  if (!data.answer && data.results.length === 0) {
    lines.push('No relevant sources found.');
  }

  return lines.join('\n');
}

function formatMarkdown(data: AskResult, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const hasAnswer = Boolean(data.answer);

  lines.push(`# Question: ${data.query}`);
  lines.push('');

  if (data.answer) {
    lines.push('## Answer');
    lines.push('');
    lines.push(data.answer);
    lines.push('');
  }

  // Show cited sources (only sources actually referenced in answer)
  if (data.citations && data.citations.length > 0) {
    lines.push('## Cited Sources');
    lines.push('');
    for (let i = 0; i < data.citations.length; i++) {
      const c = data.citations[i];
      if (c) {
        lines.push(`**[${i + 1}]** \`${c.uri}\``);
      }
    }
    lines.push('');
  }

  // Show all retrieved sources if no answer or --show-sources
  const showAllSources = !hasAnswer || opts.showSources;
  if (showAllSources) {
    lines.push(hasAnswer ? '## All Retrieved Sources' : '## Sources');
    lines.push('');

    for (let i = 0; i < data.results.length; i++) {
      const r = data.results[i];
      if (!r) {
        continue;
      }
      lines.push(`${i + 1}. **${r.title || r.source.relPath}**`);
      lines.push(`   - URI: \`${r.uri}\``);
      lines.push(`   - Score: ${r.score.toFixed(2)}`);
    }

    if (data.results.length === 0) {
      lines.push('*No relevant sources found.*');
    }
  }

  lines.push('');
  lines.push('---');
  lines.push(
    `*Mode: ${data.mode} | Expanded: ${data.meta.expanded} | Reranked: ${data.meta.reranked}*`
  );

  return lines.join('\n');
}

/**
 * Format ask result for output.
 */
export function formatAsk(
  result: AskCommandResult,
  options: AskCommandOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: 'ASK_FAILED', message: result.error },
        })
      : `Error: ${result.error}`;
  }

  const formatOpts: FormatOptions = { showSources: options.showSources };

  if (options.json) {
    return JSON.stringify(result.data, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result.data, formatOpts);
  }

  return formatTerminal(result.data, formatOpts);
}
