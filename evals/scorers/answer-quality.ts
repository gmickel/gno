/**
 * Answer quality scorer using LLM-as-judge.
 * Requires OPENAI_API_KEY for GPT-5-mini judge.
 *
 * @module evals/scorers/answer-quality
 */

import { createScorer } from "evalite";

// Check if OpenAI API key is available
const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

interface AnswerInput {
  question: string;
  sources: string[];
}

interface AnswerOutput {
  answer: string;
  citations: string[];
}

interface AnswerExpected {
  expectedTopics: string[];
}

interface JudgeResponse {
  relevance: number;
  groundedness: number;
  completeness: number;
  reasoning: string;
}

/**
 * LLM-as-judge scorer for answer quality.
 * Evaluates relevance, groundedness, and completeness.
 * Skips (returns 1.0) if OPENAI_API_KEY not set.
 */
export const answerQuality = createScorer<
  AnswerInput,
  AnswerOutput,
  AnswerExpected
>({
  name: "Answer Quality",
  description: "LLM judge for relevance, groundedness, and completeness",
  scorer: async ({ input, output, expected }) => {
    // Skip if no API key - return passing score
    if (!hasOpenAIKey) {
      return {
        score: 1,
        metadata: { skipped: true, reason: "OPENAI_API_KEY not set" },
      };
    }

    try {
      // Dynamic import to avoid loading if not needed
      const { generateText } = await import("ai");
      const { openai } = await import("@ai-sdk/openai");

      const prompt = `You are evaluating an AI-generated answer for quality.

Question: ${input.question}

Sources provided:
${input.sources.map((s, i) => `[${i + 1}] ${s.slice(0, 500)}${s.length > 500 ? "..." : ""}`).join("\n\n")}

Answer generated:
${output.answer}

Expected topics to cover: ${expected?.expectedTopics?.join(", ") || "N/A"}

Rate the answer on three dimensions (0.0 to 1.0):
1. RELEVANCE: Does the answer directly address the question?
2. GROUNDEDNESS: Is the answer supported by the provided sources? (no hallucination)
3. COMPLETENESS: Does the answer cover the key points?

Respond in JSON format only:
{"relevance": 0.X, "groundedness": 0.X, "completeness": 0.X, "reasoning": "..."}`;

      const result = await generateText({
        model: openai("gpt-5-mini"),
        prompt,
        temperature: 0,
      });

      const judgment: JudgeResponse = JSON.parse(result.text);
      const avgScore =
        (judgment.relevance + judgment.groundedness + judgment.completeness) /
        3;

      return {
        score: avgScore,
        metadata: {
          relevance: judgment.relevance,
          groundedness: judgment.groundedness,
          completeness: judgment.completeness,
          reasoning: judgment.reasoning,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        score: 0,
        metadata: { error: `Judge failed: ${message}` },
      };
    }
  },
});

/**
 * Simple scorer: checks if answer has citations.
 */
export const hasCitations = createScorer<
  AnswerInput,
  AnswerOutput,
  AnswerExpected
>({
  name: "Has Citations",
  description: "Checks if answer includes source citations",
  scorer: ({ output }) => {
    const count = output.citations?.length ?? 0;
    return {
      score: count > 0 ? 1 : 0,
      metadata: { citationCount: count },
    };
  },
});

/**
 * Checks if answer mentions expected topics.
 */
export const coversTopics = createScorer<
  AnswerInput,
  AnswerOutput,
  AnswerExpected
>({
  name: "Covers Topics",
  description: "Checks if answer mentions expected topics",
  scorer: ({ output, expected }) => {
    if (!expected?.expectedTopics?.length) {
      return { score: 1, metadata: { note: "no expected topics" } };
    }

    const answerLower = output.answer.toLowerCase();
    const found = expected.expectedTopics.filter((topic) =>
      answerLower.includes(topic.toLowerCase())
    );

    return {
      score: found.length / expected.expectedTopics.length,
      metadata: {
        found,
        missing: expected.expectedTopics.filter((t) => !found.includes(t)),
        total: expected.expectedTopics.length,
      },
    };
  },
});
