import { describe, expect, test } from 'bun:test';

import { rerankCandidates } from '../../src/pipeline/rerank';
import type { FusionCandidate } from '../../src/pipeline/types';

// Mock store with minimal implementation for tests
// Uses getChunksBatch; getChunks throws to verify N+1 elimination
const mockStore = {
  getChunks: () => {
    throw new Error('N+1 detected: getChunks should not be called');
  },
  getChunksBatch: async () => ({ ok: true as const, value: new Map() }),
};

// Helper to create test candidates
function createCandidates(
  count: number,
  fusionScoreGenerator: (i: number) => number
): FusionCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    mirrorHash: `hash${i}`,
    seq: i,
    bm25Rank: i,
    vecRank: count - i,
    fusionScore: fusionScoreGenerator(i),
    sources: ['bm25'] as const,
  }));
}

describe('rerank normalization', () => {
  describe('no reranker available (fallback)', () => {
    test('scores are normalized to [0,1] range', async () => {
      // Create candidates with raw RRF-like scores (~1/(60+rank))
      const candidates = createCandidates(10, (i) => 1 / (60 + i));

      const result = await rerankCandidates(
        { rerankPort: null, store: mockStore as never },
        'test query',
        candidates
      );

      expect(result.reranked).toBe(false);

      // All blendedScores should be in [0,1]
      for (const c of result.candidates) {
        expect(c.blendedScore).toBeGreaterThanOrEqual(0);
        expect(c.blendedScore).toBeLessThanOrEqual(1);
      }

      // Best candidate should have score 1
      const first = result.candidates[0];
      expect(first).toBeDefined();
      expect(first?.blendedScore).toBe(1);

      // Worst should have score close to 0
      // (or exactly 0 if normalization is perfect)
      const worstScore = result.candidates.at(-1);
      expect(worstScore?.blendedScore).toBeGreaterThanOrEqual(0);
      expect(worstScore?.blendedScore).toBeLessThan(0.5);
    });

    test('all equal scores normalize to 1.0', async () => {
      // All candidates have same fusion score
      const candidates = createCandidates(5, () => 0.016);

      const result = await rerankCandidates(
        { rerankPort: null, store: mockStore as never },
        'test query',
        candidates
      );

      // With no range (all equal), all should be 1.0
      for (const c of result.candidates) {
        expect(c.blendedScore).toBe(1);
      }
    });

    test('single candidate gets score 1.0', async () => {
      const candidates = createCandidates(1, () => 0.016);

      const result = await rerankCandidates(
        { rerankPort: null, store: mockStore as never },
        'test query',
        candidates
      );

      expect(result.candidates.length).toBe(1);
      const only = result.candidates[0];
      expect(only).toBeDefined();
      expect(only?.blendedScore).toBe(1);
    });

    test('rerankScore is null when no reranker', async () => {
      const candidates = createCandidates(3, (i) => 0.016 - i * 0.001);

      const result = await rerankCandidates(
        { rerankPort: null, store: mockStore as never },
        'test query',
        candidates
      );

      for (const c of result.candidates) {
        expect(c.rerankScore).toBeNull();
      }
    });
  });

  describe('reranker failure (graceful degradation)', () => {
    test('scores are normalized to [0,1] on rerank failure', async () => {
      // Mock reranker that always fails
      const failingReranker = {
        rerank: async () => ({ ok: false as const, error: 'test error' }),
        dispose: async () => {
          // no-op for test
        },
      };

      const candidates = createCandidates(10, (i) => 1 / (60 + i));

      const result = await rerankCandidates(
        { rerankPort: failingReranker as never, store: mockStore as never },
        'test query',
        candidates
      );

      expect(result.reranked).toBe(false);

      // All blendedScores should be in [0,1]
      for (const c of result.candidates) {
        expect(c.blendedScore).toBeGreaterThanOrEqual(0);
        expect(c.blendedScore).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('remaining candidates (beyond rerank limit)', () => {
    test('remaining candidates have scores clamped to [0,1]', async () => {
      // Mock reranker that succeeds
      const successReranker = {
        rerank: async (_query: string, texts: string[]) => ({
          ok: true as const,
          value: texts.map((_, i) => ({ index: i, score: 0.9 - i * 0.05 })),
        }),
        dispose: async () => {
          // no-op for test
        },
      };

      // Create more candidates than maxCandidates (default 20)
      const candidates = createCandidates(25, (i) => 1 / (60 + i));

      const result = await rerankCandidates(
        { rerankPort: successReranker as never, store: mockStore as never },
        'test query',
        candidates,
        { maxCandidates: 5 } // Only rerank top 5
      );

      expect(result.reranked).toBe(true);

      // All candidates (including remaining) should have scores in [0,1]
      for (const c of result.candidates) {
        expect(c.blendedScore).toBeGreaterThanOrEqual(0);
        expect(c.blendedScore).toBeLessThanOrEqual(1);
      }

      // Remaining candidates should have null rerankScore
      const remainingCandidates = result.candidates.slice(5);
      for (const c of remainingCandidates) {
        expect(c.rerankScore).toBeNull();
      }
    });
  });

  describe('chunk batch fetch failure', () => {
    test('degrades to fusion-only when getChunksBatch fails', async () => {
      // Mock reranker that should not be called
      const successReranker = {
        rerank: () => {
          throw new Error('rerank should not be called on chunk fetch failure');
        },
        dispose: async () => {
          // no-op for test
        },
      };

      // Mock store where getChunksBatch fails
      const failingStore = {
        getChunks: () => {
          throw new Error('N+1 detected: getChunks should not be called');
        },
        getChunksBatch: async () => ({
          ok: false as const,
          error: { code: 'QUERY_FAILED', message: 'DB error' },
        }),
      };

      const candidates = createCandidates(10, (i) => 1 / (60 + i));

      const result = await rerankCandidates(
        {
          rerankPort: successReranker as never,
          store: failingStore as never,
        },
        'test query',
        candidates
      );

      // Should degrade gracefully, not call reranker
      expect(result.reranked).toBe(false);

      // All blendedScores should be in [0,1]
      for (const c of result.candidates) {
        expect(c.blendedScore).toBeGreaterThanOrEqual(0);
        expect(c.blendedScore).toBeLessThanOrEqual(1);
        expect(c.rerankScore).toBeNull();
      }
    });
  });
});
