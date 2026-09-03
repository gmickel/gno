/**
 * Evalite configuration for GNO evals.
 * Uses in-memory storage by default for fast iteration.
 *
 * @see https://evalite.dev
 */

import { defineConfig } from "evalite/config";

export default defineConfig({
  // In-memory storage (default, fast, ephemeral)
  // For persistent history, see evalite docs: https://evalite.dev

  // Test execution
  testTimeout: 120_000, // 2 min for embedding + rerank
  maxConcurrency: 5, // Conservative for LLM calls

  // Quality gate (MVP: 70%). Evalite applies one threshold per run and has no
  // per-file override; stricter gates (memory.eval.ts at 100) live in
  // EVAL_THRESHOLDS in scripts/update-eval-scores.ts and as `--threshold` on
  // their dedicated package scripts (`eval:memory`).
  scoreThreshold: 70,

  // Variance measurement (can override per-eval)
  trialCount: 1,

  // Cache LLM responses for fast iteration
  cache: true,

  // UI server port
  server: { port: 3006 },

  // Vite config pass-through to fix Zod SSR issues in vitest workers
  viteConfig: {
    ssr: {
      // Don't externalize zod - bundle it to avoid SSR import issues
      noExternal: ["zod"],
    },
    optimizeDeps: {
      // Pre-bundle zod for faster resolution
      include: ["zod"],
    },
  },
});
