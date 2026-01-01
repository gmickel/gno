/**
 * Progress rendering utilities for CLI.
 * Kept in CLI layer to avoid layer violations.
 *
 * @module src/cli/progress
 */

import type { DownloadProgress, ModelType } from '../llm/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressCallback<T = ModelType> = (
  type: T,
  progress: DownloadProgress
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Progress Renderers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a terminal progress renderer for model downloads.
 * Writes progress to stderr with carriage return for in-place updates.
 */
export function createProgressRenderer(): ProgressCallback {
  return (type, progress) => {
    const percent = progress.percent.toFixed(1);
    const downloaded = (progress.downloadedBytes / 1024 / 1024).toFixed(1);
    const total = (progress.totalBytes / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `\r${type}: ${percent}% (${downloaded}/${total} MB)    `
    );
  };
}

/**
 * Create a throttled progress renderer.
 * Emits at most once per interval, plus always on completion.
 *
 * @param renderer - Underlying renderer to throttle
 * @param intervalMs - Minimum interval between emissions (default: 100ms)
 */
export function createThrottledProgressRenderer(
  renderer: ProgressCallback,
  intervalMs = 100
): ProgressCallback {
  let lastEmit = 0;

  return (type, progress) => {
    const now = Date.now();

    // Always emit on completion (100%) or error
    const isComplete = progress.percent >= 100;

    // Emit if enough time passed or completing
    if (isComplete || now - lastEmit >= intervalMs) {
      renderer(type, progress);
      lastEmit = now;
    }
  };
}

/**
 * Create a non-TTY progress renderer (periodic line output).
 * For non-interactive contexts like CI or logs.
 */
export function createNonTtyProgressRenderer(
  intervalMs = 5000
): ProgressCallback {
  let lastEmit = 0;

  return (type, progress) => {
    const now = Date.now();
    const isComplete = progress.percent >= 100;

    if (isComplete || now - lastEmit >= intervalMs) {
      const percent = progress.percent.toFixed(1);
      const downloaded = (progress.downloadedBytes / 1024 / 1024).toFixed(1);
      const total = (progress.totalBytes / 1024 / 1024).toFixed(1);
      process.stderr.write(
        `${type}: ${percent}% (${downloaded}/${total} MB)\n`
      );
      lastEmit = now;
    }
  };
}
