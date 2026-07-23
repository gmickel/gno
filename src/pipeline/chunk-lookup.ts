/**
 * Chunk lookup optimization.
 * Provides O(1) chunk lookup by (hash, seq) instead of O(n) linear scan.
 *
 * Performance tradeoff: Pays O(k) Map build cost per hash on first access
 * to guarantee O(1) lookups thereafter. For one-off lookups, .find() might
 * be marginally faster, but we prefer consistent O(1) access across
 * pipelines where multiple lookups per hash are common.
 *
 * @module src/pipeline/chunk-lookup
 */

import type { ChunkRow } from "../store/types";

/**
 * Create O(1) chunk lookup function from batch-fetched chunks.
 * Lazily indexes chunks by seq on first access per hash.
 * First-wins semantics preserves original .find() behavior for duplicate seq.
 *
 * @param chunksMap - Map from getChunksBatch()
 * @returns Lookup function (hash, seq) => ChunkRow | undefined
 */
export function createChunkLookup(
  chunksMap: Map<string, ChunkRow[]>
): (hash: string, seq: number) => ChunkRow | undefined {
  // Lazy cache: hash -> (seq -> chunk)
  const indexCache = new Map<string, Map<number, ChunkRow>>();

  return (hash: string, seq: number): ChunkRow | undefined => {
    let bySeq = indexCache.get(hash);
    if (!bySeq) {
      const chunks = chunksMap.get(hash) ?? [];
      bySeq = new Map<number, ChunkRow>();
      // First-wins: preserve .find() behavior for degenerate duplicate seq
      for (const ch of chunks) {
        if (!bySeq.has(ch.seq)) {
          bySeq.set(ch.seq, ch);
        }
      }
      indexCache.set(hash, bySeq);
    }
    return bySeq.get(seq);
  };
}

/**
 * Prove that persisted chunk coordinates still address the exact stored
 * canonical mirror bytes. Chunk text may begin or end mid-line; callers that
 * need citation spans must expand it to full lines separately.
 */
export function chunkMatchesCanonicalContent(
  chunk: ChunkRow,
  content: string
): boolean {
  if (
    content.includes("\r") ||
    chunk.pos < 0 ||
    chunk.startLine < 1 ||
    chunk.endLine < chunk.startLine ||
    chunk.text.length === 0 ||
    chunk.pos + chunk.text.length > content.length
  ) {
    return false;
  }
  if (content.slice(chunk.pos, chunk.pos + chunk.text.length) !== chunk.text) {
    return false;
  }
  let startLine = 1;
  let endLine = 1;
  const endOffset = chunk.pos + chunk.text.length - 1;
  for (let offset = 0; offset < endOffset; offset += 1) {
    if (content[offset] !== "\n") continue;
    if (offset < chunk.pos) startLine += 1;
    endLine += 1;
  }
  return startLine === chunk.startLine && endLine === chunk.endLine;
}
