/**
 * Contextual embedding formatting.
 * Prepends document context to chunks for better retrieval.
 *
 * Based on Anthropic Contextual Retrieval research:
 * - Query relevance jumps from 0.1 to 0.92 for context-dependent queries
 * - 49% reduction in retrieval failure with contextual embeddings + BM25
 * - 67% reduction with reranking added
 *
 * @module src/pipeline/contextual
 */

// Top-level regex for performance
const HEADING_REGEX = /^##?\s+(.+)$/m;
const SUBHEADING_REGEX = /^##\s+(.+)$/m;
const EXT_REGEX = /\.\w+$/;

/**
 * Format document text for embedding.
 * Prepends title for contextual retrieval.
 */
export function formatDocForEmbedding(text: string, title?: string): string {
  const safeTitle = title?.trim() || 'none';
  return `title: ${safeTitle} | text: ${text}`;
}

/**
 * Format query for embedding.
 * Uses task-prefixed format for asymmetric retrieval.
 */
export function formatQueryForEmbedding(query: string): string {
  return `task: search result | query: ${query}`;
}

/**
 * Extract title from markdown content or filename.
 * Prefers first heading, falls back to filename without extension.
 */
export function extractTitle(content: string, filename: string): string {
  // Try to find first heading (# or ##)
  const match = content.match(HEADING_REGEX);
  if (match?.[1]) {
    const title = match[1].trim();
    // Skip generic titles like "Notes" and try next heading
    if (title.toLowerCase() === 'notes') {
      const nextMatch = content.match(SUBHEADING_REGEX);
      if (nextMatch?.[1]) {
        return nextMatch[1].trim();
      }
    }
    return title;
  }

  // Fall back to filename without extension
  const basename = filename.split('/').pop() ?? filename;
  return basename.replace(EXT_REGEX, '');
}
