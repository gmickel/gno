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

async function generateGroundedAnswer(
  genPort: GenerationPort,
  query: string,
  results: SearchResult[],
  maxTokens: number
): Promise<{ answer: string; citations: Citation[] } | null> {
  // Build context from top results
  const contextParts: string[] = [];
  const citations: Citation[] = [];

  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i];
    if (!r) {
      continue;
    }
    contextParts.push(`[${i + 1}] ${r.snippet}`);
    citations.push({
      docid: r.docid,
      uri: r.uri,
      startLine: r.snippetRange?.startLine,
      endLine: r.snippetRange?.endLine,
    });
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

    const shouldGenerateAnswer =
      options.answer &&
      !options.noAnswer &&
      genPort !== null &&
      results.length > 0;

    if (shouldGenerateAnswer && genPort) {
      const maxTokens = options.maxAnswerTokens ?? 512;
      const answerResult = await generateGroundedAnswer(
        genPort,
        query,
        results,
        maxTokens
      );
      if (answerResult) {
        answer = answerResult.answer;
        citations = answerResult.citations;
        answerGenerated = true;
      }
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

  // Show citations
  lines.push('Sources:');
  for (const r of data.results) {
    lines.push(`  [${r.docid}] ${r.uri}`);
    if (r.title) {
      lines.push(`    ${r.title}`);
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

  return formatTerminal(result.data);
}
