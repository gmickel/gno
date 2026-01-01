/**
 * Tests for progress rendering utilities.
 */

import { describe, expect, test } from 'bun:test';
import {
  createNonTtyProgressRenderer,
  createThrottledProgressRenderer,
} from '../../src/cli/progress';
import type { DownloadProgress, ModelType } from '../../src/llm/types';

function makeProgress(
  percent: number,
  totalBytes = 1_000_000
): DownloadProgress {
  return {
    percent,
    downloadedBytes: Math.floor((percent / 100) * totalBytes),
    totalBytes,
  };
}

describe('createThrottledProgressRenderer', () => {
  test('emits immediately on first call', () => {
    const calls: { type: ModelType; progress: DownloadProgress }[] = [];
    const renderer = (type: ModelType, progress: DownloadProgress) => {
      calls.push({ type, progress });
    };

    const throttled = createThrottledProgressRenderer(renderer, 100);
    throttled('embed', makeProgress(10));

    expect(calls.length).toBe(1);
    expect(calls[0]?.type).toBe('embed');
  });

  test('suppresses calls within interval', () => {
    const calls: { type: ModelType; progress: DownloadProgress }[] = [];
    const renderer = (type: ModelType, progress: DownloadProgress) => {
      calls.push({ type, progress });
    };

    const throttled = createThrottledProgressRenderer(renderer, 1000);

    throttled('embed', makeProgress(10));
    throttled('embed', makeProgress(20));
    throttled('embed', makeProgress(30));

    // Only first call should go through (within 1000ms)
    expect(calls.length).toBe(1);
  });

  test('always emits on 100% completion', () => {
    const calls: { type: ModelType; progress: DownloadProgress }[] = [];
    const renderer = (type: ModelType, progress: DownloadProgress) => {
      calls.push({ type, progress });
    };

    const throttled = createThrottledProgressRenderer(renderer, 1000);

    throttled('embed', makeProgress(10));
    throttled('embed', makeProgress(100)); // completion

    // Both should emit: first call + completion
    expect(calls.length).toBe(2);
    expect(calls[1]?.progress.percent).toBe(100);
  });

  test('emits after interval elapses', async () => {
    const calls: { type: ModelType; progress: DownloadProgress }[] = [];
    const renderer = (type: ModelType, progress: DownloadProgress) => {
      calls.push({ type, progress });
    };

    const throttled = createThrottledProgressRenderer(renderer, 50);

    throttled('embed', makeProgress(10));
    await new Promise((resolve) => setTimeout(resolve, 60));
    throttled('embed', makeProgress(50));

    expect(calls.length).toBe(2);
  });
});

describe('createNonTtyProgressRenderer', () => {
  test('emits immediately on first call', () => {
    let output = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      output += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };

    try {
      const renderer = createNonTtyProgressRenderer(5000);
      renderer('embed', makeProgress(10));

      expect(output).toContain('embed');
      expect(output).toContain('10.0%');
      expect(output).toContain('\n'); // newline not carriage return
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test('always emits on 100% completion', () => {
    let callCount = 0;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => {
      callCount++;
      return true;
    };

    try {
      const renderer = createNonTtyProgressRenderer(10_000);
      renderer('embed', makeProgress(10));
      renderer('embed', makeProgress(100));

      expect(callCount).toBe(2);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test('suppresses intermediate calls within interval', () => {
    let callCount = 0;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => {
      callCount++;
      return true;
    };

    try {
      const renderer = createNonTtyProgressRenderer(10_000);
      renderer('embed', makeProgress(10));
      renderer('embed', makeProgress(20));
      renderer('embed', makeProgress(30));

      expect(callCount).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
