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

  // Quality gate (MVP: 70%)
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
