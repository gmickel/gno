/**
 * RRF fusion tests.
 *
 * @module test/pipeline/fusion
 */

import { describe, expect, test } from 'bun:test';
import { rrfFuse, toRankedInput } from '../../src/pipeline/fusion';
import { DEFAULT_RRF_CONFIG } from '../../src/pipeline/types';

describe('rrfFuse', () => {
  test('original query gets 2x weight vs variants', () => {
    // Same doc appears in both original and variant BM25 results
    const inputs = [
      toRankedInput('bm25', [{ mirrorHash: 'docA', seq: 0 }]), // rank 1, weight 2.0
      toRankedInput('bm25_variant', [{ mirrorHash: 'docA', seq: 0 }]), // rank 1, weight 0.5
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(1);
    const candidate = result[0];

    // RRF contribution: weight / (k + rank)
    // Original: 2.0 / (60 + 1) = 0.0328
    // Variant: 0.5 / (60 + 1) = 0.0082
    // Plus tiered bonus: rank 1 in bm25 → 0.1
    const expectedScore = 2.0 / 61 + 0.5 / 61 + 0.1;
    expect(candidate?.fusionScore).toBeCloseTo(expectedScore, 6);
  });

  test('original vector gets 2x weight', () => {
    const inputs = [
      toRankedInput('vector', [{ mirrorHash: 'docA', seq: 0 }]), // rank 1, weight 2.0
      toRankedInput('vector_variant', [{ mirrorHash: 'docA', seq: 0 }]), // rank 1, weight 0.5
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(1);
    // Plus tiered bonus: rank 1 in vector → 0.1
    const expectedScore = 2.0 / 61 + 0.5 / 61 + 0.1;
    expect(result[0]?.fusionScore).toBeCloseTo(expectedScore, 6);
  });

  test('HyDE gets 0.7x weight', () => {
    const inputs = [
      toRankedInput('hyde', [{ mirrorHash: 'docA', seq: 0 }]), // rank 1, weight 0.7
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(1);
    // Plus tiered bonus: rank 1 in vector → 0.1
    const expectedScore = 0.7 / 61 + 0.1;
    expect(result[0]?.fusionScore).toBeCloseTo(expectedScore, 6);
  });

  test('original queries rank higher than variants for same position', () => {
    // DocA only in original, DocB only in variant, both at rank 1
    const inputs = [
      toRankedInput('bm25', [{ mirrorHash: 'docA', seq: 0 }]),
      toRankedInput('bm25_variant', [{ mirrorHash: 'docB', seq: 0 }]),
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(2);
    // DocA (original, 2x) should rank higher than DocB (variant, 0.5x)
    expect(result[0]?.mirrorHash).toBe('docA');
    expect(result[1]?.mirrorHash).toBe('docB');
  });

  test('combines BM25 and vector with respective weights', () => {
    const inputs = [
      toRankedInput('bm25', [{ mirrorHash: 'docA', seq: 0 }]), // 2.0 weight
      toRankedInput('vector', [{ mirrorHash: 'docA', seq: 0 }]), // 2.0 weight
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(1);
    // Both originals at rank 1 with 2x weight
    // Plus top-rank bonus (both in top 5)
    const baseScore = 2.0 / 61 + 2.0 / 61;
    const withBonus = baseScore + DEFAULT_RRF_CONFIG.topRankBonus;
    expect(result[0]?.fusionScore).toBeCloseTo(withBonus, 6);
  });

  test('tiered top-rank bonus: #1 gets full, top-3 gets 40%', () => {
    const inputs = [
      toRankedInput('bm25', [
        { mirrorHash: 'docA', seq: 0 },
        { mirrorHash: 'docB', seq: 0 },
      ]),
      toRankedInput('vector', [
        { mirrorHash: 'docA', seq: 0 },
        { mirrorHash: 'docB', seq: 0 },
      ]),
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    // DocA: rank 1 in both -> tier 1 bonus (full)
    // DocB: rank 2 in both -> tier 2 bonus (40%)
    const docA = result.find((r) => r.mirrorHash === 'docA');
    const docB = result.find((r) => r.mirrorHash === 'docB');

    expect(docA?.fusionScore).toBeGreaterThan(docB?.fusionScore ?? 0);
    // DocA gets full bonus, DocB gets 40% bonus
    expect(docA?.fusionScore).toBeCloseTo(2.0 / 61 + 2.0 / 61 + 0.1, 6);
    expect(docB?.fusionScore).toBeCloseTo(2.0 / 62 + 2.0 / 62 + 0.04, 6);
  });

  test('tracks sources correctly', () => {
    const inputs = [
      toRankedInput('bm25', [{ mirrorHash: 'docA', seq: 0 }]),
      toRankedInput('vector', [{ mirrorHash: 'docA', seq: 0 }]),
      toRankedInput('hyde', [{ mirrorHash: 'docA', seq: 0 }]),
    ];

    const result = rrfFuse(inputs, DEFAULT_RRF_CONFIG);

    expect(result).toHaveLength(1);
    expect(result[0]?.sources).toContain('bm25');
    expect(result[0]?.sources).toContain('vector');
    expect(result[0]?.sources).toContain('hyde');
  });

  test('deterministic ordering for same scores', () => {
    // All docs with same score should sort by key
    const inputs = [
      toRankedInput('bm25', [
        { mirrorHash: 'docC', seq: 0 },
        { mirrorHash: 'docA', seq: 0 },
        { mirrorHash: 'docB', seq: 0 },
      ]),
    ];

    const result = rrfFuse(inputs, {
      ...DEFAULT_RRF_CONFIG,
      topRankBonus: 0, // Disable bonus to get same scores
    });

    // Should be sorted by fusionScore desc, then by key asc for ties
    // docC rank 1, docA rank 2, docB rank 3
    expect(result[0]?.mirrorHash).toBe('docC');
    expect(result[1]?.mirrorHash).toBe('docA');
    expect(result[2]?.mirrorHash).toBe('docB');
  });
});
