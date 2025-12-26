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
import { type HybridSearchDeps, searchHybrid } from '../../pipeline/hybrid';
import type {
  AskOptions,
  AskResult,
  Citation,
  SearchResult,
} from '../../pipeline/types';
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
};

export type AskCommandResult =
  | { success: true; data: AskResult }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Grounded Answer Generation
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_PROMPT = `You are a helpful assistant. Answer the user's question based ONLY on the provided context. If the context doesn't contain enough information to answer, say so.

Question: {query}

Context:
{context}

Provide a concise answer (1-3 paragraphs). Include inline citations like [1], [2] when referencing specific documents.`;

// Max characters per snippet to avoid blowing up prompt size
const MAX_SNIPPET_CHARS = 1500;
// Max number of sources to include in context
const MAX_CONTEXT_SOURCES = 5;

async function generateGroundedAnswer(
  genPort: GenerationPort,
  query: string,
  results: SearchResult[],
  maxTokens: number
): Promise<{ answer: string; citations: Citation[] } | null> {
  // Build context from top results with bounded snippet sizes
  const contextParts: string[] = [];
  const citations: Citation[] = [];

  // Track citation index separately to ensure it matches context blocks exactly
  let citationIndex = 0;

  for (const r of results.slice(0, MAX_CONTEXT_SOURCES)) {
    // Skip results with empty snippets
    if (!r.snippet || r.snippet.trim().length === 0) {
      continue;
    }

    // Cap snippet length to avoid prompt blowup
    const snippet =
      r.snippet.length > MAX_SNIPPET_CHARS
        ? `${r.snippet.slice(0, MAX_SNIPPET_CHARS)}...`
        : r.snippet;

    citationIndex += 1;
    contextParts.push(`[${citationIndex}] ${snippet}`);
    citations.push({
      docid: r.docid,
      uri: r.uri,
      startLine: r.snippetRange?.startLine,
      endLine: r.snippetRange?.endLine,
    });
  }

  // If no valid context, can't generate answer
  if (contextParts.length === 0) {
    return null;
  }

  const prompt = ANSWER_PROMPT.replace('{query}', query).replace(
    '{context}',
    contextParts.join('\n\n')
  );

  const result = await genPort.generate(prompt, {
    temperature: 0,
    maxTokens,
  });

  if (!result.ok) {
    return null;
  }

  return { answer: result.value, citations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno ask command.
 */
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

    // Create generation port (for expansion and answer)
    const genUri = options.genModel ?? preset.gen;
    const genResult = await llm.createGenerationPort(genUri);
    if (genResult.ok) {
      genPort = genResult.value;
    }

    // Create rerank port
    const rerankUri = options.rerankModel ?? preset.rerank;
    const rerankResult = await llm.createRerankPort(rerankUri);
    if (rerankResult.ok) {
      rerankPort = rerankResult.value;
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
      const answerResult = await generateGroundedAnswer(
        genPort,
        query,
        results,
        maxTokens
      );

      // Fail loudly if generation was requested but failed
      if (!answerResult) {
        return {
          success: false,
          error:
            'Answer generation failed. The generation model may have encountered an error.',
        };
      }

      answer = answerResult.answer;
      citations = answerResult.citations;
      answerGenerated = true;
    }

    const askResult: AskResult = {
      query,
      mode: searchResult.value.meta.vectorsUsed ? 'hybrid' : 'bm25_only',
      queryLanguage: options.lang ?? 'auto',
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

function formatTerminal(data: AskResult): string {
  const lines: string[] = [];

  // Show answer if present
  if (data.answer) {
    lines.push('Answer:');
    lines.push(data.answer);
    lines.push('');
  }

  // Show citations keyed by [1], [2] if answer was generated
  // This matches the [1], [2] references in the answer text
  if (data.citations && data.citations.length > 0) {
    lines.push('Citations:');
    for (let i = 0; i < data.citations.length; i++) {
      const c = data.citations[i];
      if (c) {
        lines.push(`  [${i + 1}] ${c.docid} ${c.uri}`);
      }
    }
    lines.push('');
  }

  // Show all sources (may include more than citations)
  if (data.results.length > 0) {
    lines.push('Sources:');
    for (const r of data.results) {
      lines.push(`  [${r.docid}] ${r.uri}`);
      if (r.title) {
        lines.push(`    ${r.title}`);
      }
    }
  }

  if (!data.answer && data.results.length === 0) {
    lines.push('No relevant sources found.');
  }

  return lines.join('\n');
}

function formatMarkdown(data: AskResult): string {
  const lines: string[] = [];

  lines.push(`# Question: ${data.query}`);
  lines.push('');

  if (data.answer) {
    lines.push('## Answer');
    lines.push('');
    lines.push(data.answer);
    lines.push('');
  }

  // Show citations keyed by [1], [2] if answer was generated
  // This matches the [1], [2] references in the answer text
  if (data.citations && data.citations.length > 0) {
    lines.push('## Citations');
    lines.push('');
    for (let i = 0; i < data.citations.length; i++) {
      const c = data.citations[i];
      if (c) {
        lines.push(`**[${i + 1}]** \`${c.docid}\` — \`${c.uri}\``);
      }
    }
    lines.push('');
  }

  lines.push('## Sources');
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

  if (options.json) {
    return JSON.stringify(result.data, null, 2);
  }

  if (options.md) {
    return formatMarkdown(result.data);
  }

  return formatTerminal(result.data);
}
