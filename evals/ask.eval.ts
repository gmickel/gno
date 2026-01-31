/**
 * Answer quality evaluation with MOCKED retrieval.
 * Tests answer generation quality, not retrieval (tested separately in vsearch.eval).
 *
 * Uses LLM-as-judge (requires OPENAI_API_KEY) or skips gracefully.
 * Model downloads happen on first run (may take minutes).
 *
 * @module evals/ask.eval
 */

import { evalite } from "evalite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SearchResult } from "../src/pipeline/types";

import { createDefaultConfig } from "../src/config";
import { LlmAdapter } from "../src/llm/nodeLlamaCpp/adapter";
import { getPreset } from "../src/llm/registry";
import {
  generateGroundedAnswer,
  processAnswerResult,
} from "../src/pipeline/answer";
import askCasesJson from "./fixtures/ask-cases.json";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "fixtures/corpus");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AskCase {
  id: string;
  question: string;
  expectedTopics: string[];
  mockSources: string[];
}

const askCases = askCasesJson as AskCase[];

type PresetId = "slim" | "balanced" | "quality";

interface AskOutput {
  answer: string;
  hasCitations: boolean;
  citedSources: string[]; // Which sources were actually cited
  providedSources: string[]; // Sources we gave it
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Port Cache (per preset)
// Uses promise caching to prevent race conditions with concurrent evalite tasks.
// ─────────────────────────────────────────────────────────────────────────────

type GenPort = Extract<
  Awaited<ReturnType<LlmAdapter["createGenerationPort"]>>,
  { ok: true }
>["value"];

// Cache promises, not resolved values - prevents duplicate model loads under concurrency
const cachedGenPortPromises = new Map<PresetId, Promise<GenPort>>();
let cachedLlm: LlmAdapter | null = null;
let cachedConfig: ReturnType<typeof createDefaultConfig> | null = null;

/**
 * Create generation port for a specific preset.
 * Internal - called once per preset via promise caching.
 */
async function createGenPort(presetId: PresetId): Promise<GenPort> {
  // Initialize shared config and adapter
  if (!cachedConfig) {
    cachedConfig = createDefaultConfig();
  }
  if (!cachedLlm) {
    cachedLlm = new LlmAdapter(cachedConfig);
  }

  // Get the specific preset
  const preset = getPreset(cachedConfig, presetId);
  if (!preset) {
    throw new Error(`Preset "${presetId}" not found in config`);
  }

  // Allow downloads - this is intentional for evals
  const policy = { offline: false, allowDownload: true };

  console.log(`[ask.eval] Loading generation model for preset: ${presetId}...`);

  const genResult = await cachedLlm.createGenerationPort(preset.gen, {
    policy,
  });
  if (!genResult.ok) {
    throw new Error(
      `Failed to create gen port for ${presetId}: ${genResult.error}`
    );
  }

  console.log(`[ask.eval] Generation port ready for ${presetId}`);
  return genResult.value;
}

/**
 * Get generation port for a specific preset.
 * Uses promise caching - concurrent calls share the same loading promise.
 */
function getGenPort(presetId: PresetId): Promise<GenPort> {
  let promise = cachedGenPortPromises.get(presetId);
  if (!promise) {
    promise = createGenPort(presetId);
    cachedGenPortPromises.set(presetId, promise);
  }
  return promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load mock sources from fixture corpus and create fake SearchResults.
 * This tests answer generation in isolation from retrieval.
 */
async function loadMockSources(mockPaths: string[]): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (const relPath of mockPaths) {
    const fullPath = join(CORPUS_DIR, relPath);
    try {
      const content = await Bun.file(fullPath).text();
      results.push({
        docid: relPath,
        score: 1.0,
        uri: `file://${fullPath}`,
        title: relPath.split("/").pop()?.replace(".md", "") ?? relPath,
        snippet: content,
        source: {
          relPath,
          mime: "text/markdown",
          ext: ".md",
        },
      });
    } catch {
      console.warn(`[ask.eval] Could not load mock source: ${relPath}`);
    }
  }

  return results;
}

/**
 * Generate answer using MOCKED retrieval (real answer generation).
 * Uses the specified preset's generation model.
 */
async function mockAsk(
  question: string,
  mockSources: string[],
  preset: PresetId
): Promise<AskOutput> {
  const genPort = await getGenPort(preset);
  const sources = await loadMockSources(mockSources);

  if (sources.length === 0) {
    return {
      answer: "No sources available.",
      hasCitations: false,
      citedSources: [],
      providedSources: [],
    };
  }

  // Generate grounded answer (real LLM, mocked sources)
  const rawResult = await generateGroundedAnswer(
    { genPort, store: null }, // No store needed - using snippets directly
    question,
    sources,
    512 // maxTokens
  );

  if (!rawResult) {
    return {
      answer: "Answer generation failed.",
      hasCitations: false,
      citedSources: [],
      providedSources: mockSources,
    };
  }

  const processed = processAnswerResult(rawResult);

  // Extract which sources were actually cited (by docid)
  const citedSources = processed.citations.map((c) => c.docid);

  console.log(
    `[ask.eval] Answer for "${question.slice(0, 30)}..." - ${citedSources.length} citations`
  );

  return {
    answer: processed.answer,
    hasCitations: citedSources.length > 0,
    citedSources,
    providedSources: mockSources,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Eval Definition
// ─────────────────────────────────────────────────────────────────────────────

evalite("Answer Quality", {
  data: () => {
    // Test each question with each preset
    const cases: Array<{
      input: {
        id: string;
        question: string;
        mockSources: string[];
        preset: PresetId;
      };
      expected: {
        expectedTopics: string[];
        validSources: string[];
      };
    }> = [];

    for (const c of askCases) {
      for (const preset of ["slim", "balanced", "quality"] as PresetId[]) {
        cases.push({
          input: {
            id: `${c.id}-${preset}`,
            question: c.question,
            mockSources: c.mockSources,
            preset,
          },
          expected: {
            expectedTopics: c.expectedTopics,
            validSources: c.mockSources,
          },
        });
      }
    }

    return cases;
  },

  task: async (input) =>
    mockAsk(input.question, input.mockSources, input.preset),

  scorers: [
    {
      name: "Good Answer",
      description:
        "LLM judge: Is this helpful and grounded? (skips if no OPENAI_API_KEY)",
      scorer: async ({ input, output }) => {
        // Skip if no API key - graceful degradation
        if (!process.env.OPENAI_API_KEY) {
          return {
            score: 1,
            metadata: { skipped: true, reason: "OPENAI_API_KEY not set" },
          };
        }

        try {
          const { generateText } = await import("ai");
          const { openai } = await import("@ai-sdk/openai");

          const prompt = `You are evaluating an AI assistant's answer.

Question: ${input.question}
Answer: ${output.answer}

Rate this answer from 0.0 to 1.0:
- 1.0: Helpful, addresses the question, appears factual
- 0.7: Mostly helpful with minor issues
- 0.5: Partially helpful, missing key information
- 0.3: Barely relevant or mostly unhelpful
- 0.0: Wrong, off-topic, or harmful

Respond with ONLY a JSON object: {"score": 0.X, "reason": "brief explanation"}`;

          const result = await generateText({
            model: openai("gpt-5-mini"),
            prompt,
          });

          const judgment = JSON.parse(result.text);
          return {
            score: judgment.score,
            metadata: { reason: judgment.reason },
          };
        } catch (error) {
          return { score: 0, metadata: { error: String(error) } };
        }
      },
    },
    {
      name: "Has Citations",
      description: "Answer includes source citations",
      scorer: ({ output }) => ({
        score: output.hasCitations ? 1 : 0,
        metadata: { citedCount: output.citedSources.length },
      }),
    },
    {
      name: "Valid Citations",
      description: "Citations reference provided sources",
      scorer: ({ output, expected }) => {
        if (output.citedSources.length === 0) {
          // No citations = can't evaluate validity, neutral score
          return { score: 0.5, metadata: { note: "no citations to validate" } };
        }

        const validSet = new Set(expected.validSources);
        const validCitations = output.citedSources.filter((s) =>
          validSet.has(s)
        );
        const score = validCitations.length / output.citedSources.length;

        return {
          score,
          metadata: {
            valid: validCitations.length,
            total: output.citedSources.length,
            invalidCitations: output.citedSources.filter(
              (s) => !validSet.has(s)
            ),
          },
        };
      },
    },
  ],

  columns: ({ input, output }) => [
    { label: "Question", value: input.question.slice(0, 30) },
    { label: "Preset", value: input.preset },
    { label: "Citations", value: output.citedSources.length.toString() },
  ],

  trialCount: 1,
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

process.on("beforeExit", async () => {
  // Dispose all cached generation ports
  for (const promise of cachedGenPortPromises.values()) {
    const port = await promise;
    await port.dispose();
  }
  cachedGenPortPromises.clear();
  cachedLlm = null;
  cachedConfig = null;
});
