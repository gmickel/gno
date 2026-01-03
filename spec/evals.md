# Evals Specification (Evalite v1)

This document specifies the evaluation harness for GNO using Evalite v1.

## Why Evals?

**Evals test stochastic LLM behavior, not deterministic code.**

Unit tests verify "given X, always return Y". Evals verify "given X, return something good enough" - because LLM outputs vary. We're measuring:

- Does retrieval find relevant docs most of the time?
- Does answer generation stay grounded in sources?
- Does quality improve with more compute (fast → thorough)?
- Does expansion produce valid structure despite LLM variance?

**Key insight**: Don't chase 100% determinism. Set thresholds (70%+), measure variance with `trialCount`, and accept that LLM-based features have inherent randomness. The goal is regression detection, not perfect reproducibility.

## Overview

GNO uses Evalite for:

- **Ranking quality gates**: Validate `vsearch` and `query` return relevant results
- **Stability checks**: Ensure structured expansion outputs are schema-valid
- **Multilingual sanity**: Cross-language retrieval works (DE query → EN doc)

## Dependencies

```json
{
  "devDependencies": {
    "evalite": "^1.0.0-beta.15",
    "vitest": "^4.0.0",
    "@ai-sdk/openai": "^3.0.0"
  }
}
```

Note: `@ai-sdk/openai` is optional - only needed if using LLM-as-judge scorer.

## File Structure

```
evals/                          # Top-level (not test/eval/)
  vsearch.eval.ts               # BM25 search ranking
  query.eval.ts                 # Query pipeline + latency
  expansion.eval.ts             # Expansion schema validity
  multilingual.eval.ts          # Cross-language (BM25 baseline)
  thoroughness.eval.ts          # Fast/balanced/thorough comparison
  ask.eval.ts                   # Answer quality by preset
  scorers/
    ir-metrics.ts               # recall@k, nDCG@k, latency scorers
    expansion-validity.ts       # AJV schema validation
    answer-quality.ts           # LLM-as-judge (requires OPENAI_API_KEY)
  helpers/
    setup-db.ts                 # Temp DB setup for eval corpus
  fixtures/
    corpus/
      de/                       # German test docs
      en/                       # English test docs
      fr/                       # French test docs
      it/                       # Italian test docs
    queries.json                # Query-judgment pairs (29 queries)
    ask-cases.json              # Ask questions with expected topics
evalite.config.ts               # Global configuration
```

**Note**: Evals are local-only (part of DoD/release process, not CI). Uses temp SQLite DB per run, isolated from global gno install.

## Configuration

### `evalite.config.ts`

```ts
import { defineConfig } from "evalite/config";

export default defineConfig({
  // In-memory storage (default, fast, ephemeral)
  // For persistent history, see evalite docs

  // Test execution
  testTimeout: 120_000,   // 2 min for embedding + rerank
  maxConcurrency: 5,      // Conservative for LLM calls

  // Quality gate (MVP: 70%)
  scoreThreshold: 70,

  // Variance measurement (can override per-eval)
  trialCount: 1,

  // Cache LLM responses for fast iteration
  cache: true,

  // UI server port
  server: { port: 3006 },
});
```

### `package.json` Scripts

```json
{
  "scripts": {
    "eval": "bun --bun evalite",
    "eval:watch": "bun --bun evalite watch"
  }
}
```

**Note**: `--bun` flag required because evals use `bun:sqlite` via SqliteAdapter.

**CLI Modes:**

- `bun run eval` - Run once, exit
- `bun run eval:watch` - Auto-rerun on file changes

## Custom Scorers

Evalite doesn't include IR-specific scorers. Create them in `evals/scorers/ir-metrics.ts`:

### Recall@K

```ts
import { createScorer } from "evalite";

type RecallInput = { query: string; collection?: string };
type RecallOutput = string[];  // docids
type RecallExpected = string[];  // relevant docids

export const recallAtK = (k: number) => createScorer<
  RecallInput,
  RecallOutput,
  RecallExpected
>({
  name: `Recall@${k}`,
  description: `Fraction of relevant docs retrieved in top ${k} results`,
  scorer: ({ output, expected }) => {
    if (!expected || expected.length === 0) {
      return { score: 1, metadata: { k, hits: 0, total: 0, note: "no relevants" } };
    }
    const topK = output.slice(0, k);
    const hits = expected.filter(docid => topK.includes(docid)).length;
    return {
      score: hits / expected.length,
      metadata: { k, hits, total: expected.length },
    };
  },
});
```

### nDCG@K

```ts
type NdcgInput = { query: string; collection?: string };
type NdcgOutput = string[];
type NdcgExpected = Array<{ docid: string; relevance: number }>;

export const ndcgAtK = (k: number) => createScorer<
  NdcgInput,
  NdcgOutput,
  NdcgExpected
>({
  name: `nDCG@${k}`,
  description: `Normalized Discounted Cumulative Gain at rank ${k}`,
  scorer: ({ output, expected }) => {
    if (!expected || expected.length === 0) {
      return { score: 1, metadata: { k, dcg: 0, idcg: 0, note: "no judgments" } };
    }

    const relevanceMap = new Map(expected.map(e => [e.docid, e.relevance]));

    // DCG for actual ranking
    const dcg = output.slice(0, k).reduce((sum, docid, i) => {
      const rel = relevanceMap.get(docid) ?? 0;
      return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);

    // Ideal DCG (sorted by relevance)
    const idcg = [...expected]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, k)
      .reduce((sum, e, i) => {
        return sum + (Math.pow(2, e.relevance) - 1) / Math.log2(i + 2);
      }, 0);

    return {
      score: idcg > 0 ? dcg / idcg : 1,
      metadata: { k, dcg: dcg.toFixed(4), idcg: idcg.toFixed(4) },
    };
  },
});
```

### Expansion Schema Validity

```ts
import { createScorer } from "evalite";
import Ajv from "ajv";
import expansionSchema from "../../spec/output-schemas/expansion.schema.json";

const ajv = new Ajv();
const validate = ajv.compile(expansionSchema);

export const expansionSchemaValid = createScorer<
  string,
  unknown,
  undefined
>({
  name: "Expansion Schema Valid",
  description: "Checks if expansion output matches JSON schema",
  scorer: ({ output }) => {
    const valid = validate(output);
    return {
      score: valid ? 1 : 0,
      metadata: valid ? { valid: true } : { valid: false, errors: validate.errors },
    };
  },
});
```

### Latency Budget (Soft Gate)

```ts
export const latencyBudget = (maxMs: number) => createScorer<
  unknown,
  { result: unknown; durationMs: number },
  undefined
>({
  name: `Latency < ${maxMs}ms`,
  description: `Checks if task completed within ${maxMs}ms budget`,
  scorer: ({ output }) => {
    const withinBudget = output.durationMs <= maxMs;
    return {
      score: withinBudget ? 1 : Math.max(0, 1 - (output.durationMs - maxMs) / maxMs),
      metadata: { durationMs: output.durationMs, maxMs, withinBudget },
    };
  },
});
```

## Test Data Format

### `evals/fixtures/queries.json`

```json
[
  {
    "id": "q1",
    "query": "termination clause",
    "collection": "contracts",
    "language": "en",
    "relevantDocs": ["#a1b2c3", "#d4e5f6"],
    "judgments": [
      { "docid": "#a1b2c3", "relevance": 3 },
      { "docid": "#d4e5f6", "relevance": 2 },
      { "docid": "#g7h8i9", "relevance": 1 }
    ]
  },
  {
    "id": "q2",
    "query": "Kündigungsklausel",
    "collection": "contracts",
    "language": "de",
    "note": "German query over mixed DE/EN corpus",
    "relevantDocs": ["#a1b2c3"],
    "judgments": [
      { "docid": "#a1b2c3", "relevance": 3 }
    ]
  }
]
```

## Eval Dimensions

GNO has two configurable axes that affect search/answer quality:

### Search Thoroughness

Controls the search pipeline depth via `--fast` / `--thorough` flags:

| Mode     | Pipeline                      | Expected Latency | Quality  |
| -------- | ----------------------------- | ---------------- | -------- |
| fast     | BM25 only, no rerank          | < 1s             | Baseline |
| balanced | Hybrid + rerank, no expansion | < 3s             | Better   |
| thorough | Full pipeline + expansion     | < 8s             | Best     |

**Eval strategy**: Run identical queries at all 3 levels, measure Recall@K and nDCG@K. Verify:

- `thorough` >= `balanced` >= `fast` for ranking quality
- Latency stays within budget per mode

### Model Presets

Controls AI model quality for generation (answers) via `gno models use <preset>`:

| Preset   | Gen Model  | Size   | Answer Quality  |
| -------- | ---------- | ------ | --------------- |
| slim     | Qwen3-1.7B | ~1GB   | Default, fast   |
| balanced | Qwen2.5-3B | ~2GB   | Slightly larger |
| quality  | Qwen3-4B   | ~2.5GB | Best answers    |

Note: Embedding and reranking models are identical across presets.

**Eval strategy**: Run identical questions through `gno ask` at each preset, use LLM-as-judge to score answer quality. Verify:

- `quality` >= `balanced` >= `slim` for answer relevance
- All presets produce factually grounded answers (no hallucination)

## Eval Files

### Vector Search Eval

```ts
// evals/vsearch.eval.ts
import { evalite } from "evalite";
import { recallAtK, ndcgAtK } from "./scorers/ir-metrics";
import { vsearch } from "../../src/pipeline/vsearch";

interface QueryData {
  id: string;
  query: string;
  collection?: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

evalite("Vector Search Ranking", {
  data: async () => {
    const queries: QueryData[] = await Bun.file("evals/fixtures/queries.json").json();
    return queries.map((q) => ({
      input: { query: q.query, collection: q.collection },
      expected: {
        relevantDocs: q.relevantDocs,
        judgments: q.judgments,
      },
    }));
  },

  task: async (input) => {
    const results = await vsearch(input.query, {
      collection: input.collection,
      limit: 10,
    });
    return results.map(r => r.docid);
  },

  scorers: [
    {
      name: "Recall@5",
      scorer: ({ output, expected }) =>
        recallAtK(5).scorer({ input: {}, output, expected: expected.relevantDocs }),
    },
    {
      name: "Recall@10",
      scorer: ({ output, expected }) =>
        recallAtK(10).scorer({ input: {}, output, expected: expected.relevantDocs }),
    },
    {
      name: "nDCG@10",
      scorer: ({ output, expected }) =>
        ndcgAtK(10).scorer({ input: {}, output, expected: expected.judgments }),
    },
  ],

  columns: ({ input, output }) => [
    { label: "Query", value: input.query },
    { label: "Top 3", value: output.slice(0, 3).join(", ") },
  ],
});
```

### Hybrid Query Eval

```ts
// evals/query.eval.ts
import { evalite } from "evalite";
import { recallAtK, ndcgAtK, latencyBudget } from "./scorers/ir-metrics";
import { query } from "../../src/pipeline/query";

evalite("Hybrid Query Pipeline", {
  data: async () => {
    const queries = await Bun.file("evals/fixtures/queries.json").json();
    return queries.map((q) => ({
      input: { query: q.query, collection: q.collection },
      expected: {
        relevantDocs: q.relevantDocs,
        judgments: q.judgments,
      },
    }));
  },

  task: async (input) => {
    const start = performance.now();
    const results = await query(input.query, {
      collection: input.collection,
      limit: 10,
    });
    const durationMs = performance.now() - start;

    return {
      docids: results.map(r => r.docid),
      durationMs,
    };
  },

  scorers: [
    {
      name: "Recall@5",
      scorer: ({ output, expected }) =>
        recallAtK(5).scorer({ input: {}, output: output.docids, expected: expected.relevantDocs }),
    },
    {
      name: "nDCG@10",
      scorer: ({ output, expected }) =>
        ndcgAtK(10).scorer({ input: {}, output: output.docids, expected: expected.judgments }),
    },
    {
      name: "Latency < 2s",
      scorer: ({ output }) =>
        latencyBudget(2000).scorer({ input: {}, output, expected: undefined }),
    },
  ],

  trialCount: 1,  // deterministic for same model weights
});
```

### Expansion Stability Eval

```ts
// evals/expansion.eval.ts
import { evalite } from "evalite";
import { expansionSchemaValid } from "./scorers/expansion-validity";
import { expandQuery } from "../../src/pipeline/expansion";

evalite("Structured Expansion Stability", {
  data: async () => {
    const queries = await Bun.file("evals/fixtures/queries.json").json();
    return queries.map((q) => ({
      input: q.query,
    }));
  },

  task: async (input) => {
    return await expandQuery(input);
  },

  scorers: [
    {
      name: "Schema Valid",
      scorer: ({ output }) => expansionSchemaValid.scorer({ input: "", output, expected: undefined }),
    },
    {
      name: "Has Lexical Variants",
      scorer: ({ output }) => {
        const hasLexical = Array.isArray(output?.lexicalQueries) && output.lexicalQueries.length > 0;
        return { score: hasLexical ? 1 : 0, metadata: { count: output?.lexicalQueries?.length ?? 0 } };
      },
    },
    {
      name: "Has Vector Variants",
      scorer: ({ output }) => {
        const hasVector = Array.isArray(output?.vectorQueries) && output.vectorQueries.length > 0;
        return { score: hasVector ? 1 : 0, metadata: { count: output?.vectorQueries?.length ?? 0 } };
      },
    },
  ],

  // Run 3 times to detect variance in LLM expansion
  trialCount: 3,
});
```

### Multilingual Eval

```ts
// evals/multilingual.eval.ts
import { evalite } from "evalite";
import { recallAtK } from "./scorers/ir-metrics";
import { query } from "../../src/pipeline/query";

// Cross-language test cases: query in one language, relevant docs in another
const multilingualCases = [
  {
    query: "Kündigungsklausel",  // German
    expectedLang: "de",
    relevantDocs: ["#en-termination-1"],  // English doc
    note: "DE query should find EN termination clause doc via embeddings",
  },
  {
    query: "termination clause",  // English
    expectedLang: "en",
    relevantDocs: ["#de-kuendigung-1"],  // German doc
    note: "EN query should find DE Kündigung doc via embeddings",
  },
];

evalite("Multilingual Cross-Language Retrieval", {
  data: () => multilingualCases.map(c => ({
    input: { query: c.query },
    expected: c.relevantDocs,
  })),

  task: async (input) => {
    const results = await query(input.query, { limit: 10 });
    return results.map(r => r.docid);
  },

  scorers: [
    {
      name: "Recall@5",
      scorer: ({ output, expected }) =>
        recallAtK(5).scorer({ input: {}, output, expected }),
    },
  ],

  columns: ({ input, output }) => [
    { label: "Query", value: input.query },
    { label: "Found", value: output.slice(0, 3).join(", ") },
  ],
});
```

### Thoroughness Comparison Eval

Tests the same queries at all thoroughness levels to verify quality ordering.

```ts
// evals/thoroughness.eval.ts
import { evalite } from "evalite";
import { recallAtK, ndcgAtK, latencyBudget } from "./scorers/ir-metrics";
import { searchBm25 } from "../../src/pipeline/search";
import { searchHybrid } from "../../src/pipeline/query";

type ThoroughnessLevel = "fast" | "balanced" | "thorough";

const LATENCY_BUDGETS: Record<ThoroughnessLevel, number> = {
  fast: 1000,      // 1s
  balanced: 3000,  // 3s
  thorough: 8000,  // 8s
};

interface QueryCase {
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

// Run each query at each thoroughness level
async function runAtThoroughness(
  query: string,
  level: ThoroughnessLevel
): Promise<{ docids: string[]; durationMs: number }> {
  const start = performance.now();
  let results: Array<{ docid: string }>;

  if (level === "fast") {
    // BM25 only
    results = await searchBm25(query, { limit: 10 });
  } else {
    // Hybrid with different options
    results = await searchHybrid(query, {
      limit: 10,
      noExpand: level === "balanced",  // balanced skips expansion
      noRerank: false,
    });
  }

  return {
    docids: results.map(r => r.docid),
    durationMs: performance.now() - start,
  };
}

evalite("Thoroughness Comparison", {
  data: async () => {
    const queries: QueryCase[] = await Bun.file("evals/fixtures/queries.json").json();

    // Create test cases for each query x thoroughness combination
    const cases: Array<{
      input: { query: string; level: ThoroughnessLevel };
      expected: { relevantDocs: string[]; judgments: QueryCase["judgments"] };
    }> = [];

    for (const q of queries) {
      for (const level of ["fast", "balanced", "thorough"] as ThoroughnessLevel[]) {
        cases.push({
          input: { query: q.query, level },
          expected: { relevantDocs: q.relevantDocs, judgments: q.judgments },
        });
      }
    }
    return cases;
  },

  task: async (input) => runAtThoroughness(input.query, input.level),

  scorers: [
    {
      name: "Recall@5",
      scorer: ({ output, expected }) =>
        recallAtK(5).scorer({ input: {}, output: output.docids, expected: expected.relevantDocs }),
    },
    {
      name: "nDCG@10",
      scorer: ({ output, expected }) =>
        ndcgAtK(10).scorer({ input: {}, output: output.docids, expected: expected.judgments }),
    },
    {
      name: "Latency Budget",
      scorer: ({ input, output }) => {
        const budget = LATENCY_BUDGETS[input.level];
        const withinBudget = output.durationMs <= budget;
        return {
          score: withinBudget ? 1 : Math.max(0, 1 - (output.durationMs - budget) / budget),
          metadata: { level: input.level, durationMs: output.durationMs, budget, withinBudget },
        };
      },
    },
  ],

  columns: ({ input, output }) => [
    { label: "Query", value: input.query.slice(0, 30) },
    { label: "Level", value: input.level },
    { label: "Time", value: `${output.durationMs.toFixed(0)}ms` },
  ],
});
```

### Answer Quality Eval

Tests `gno ask` across model presets using LLM-as-judge for answer quality.

```ts
// evals/scorers/answer-quality.ts
import { createScorer } from "evalite";
import { generateText } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { openai } from "@ai-sdk/openai";

// Use GPT-5-mini as judge (fast, cheap, good enough for eval)
const judge = wrapAISDKModel(openai("gpt-5-mini"));

interface AnswerJudgment {
  relevance: number;      // 0-1: Does answer address the question?
  groundedness: number;   // 0-1: Is answer supported by sources?
  completeness: number;   // 0-1: Does answer cover key points?
}

export const answerQuality = createScorer<
  { question: string; sources: string[] },
  { answer: string; citations: string[] },
  { expectedTopics: string[] }
>({
  name: "Answer Quality (LLM Judge)",
  description: "Uses LLM to judge answer relevance, groundedness, and completeness",
  scorer: async ({ input, output, expected }) => {
    const prompt = `You are evaluating an AI-generated answer for quality.

Question: ${input.question}

Sources provided:
${input.sources.map((s, i) => `[${i + 1}] ${s.slice(0, 500)}...`).join("\n\n")}

Answer generated:
${output.answer}

Expected topics to cover: ${expected?.expectedTopics?.join(", ") || "N/A"}

Rate the answer on three dimensions (0.0 to 1.0):
1. RELEVANCE: Does the answer directly address the question?
2. GROUNDEDNESS: Is the answer supported by the provided sources? (no hallucination)
3. COMPLETENESS: Does the answer cover the key points?

Respond in JSON format:
{"relevance": 0.X, "groundedness": 0.X, "completeness": 0.X, "reasoning": "..."}`;

    const result = await generateText({
      model: judge,
      prompt,
      temperature: 0,
    });

    try {
      const judgment: AnswerJudgment & { reasoning: string } = JSON.parse(result.text);
      const avgScore = (judgment.relevance + judgment.groundedness + judgment.completeness) / 3;

      return {
        score: avgScore,
        metadata: {
          relevance: judgment.relevance,
          groundedness: judgment.groundedness,
          completeness: judgment.completeness,
          reasoning: judgment.reasoning,
        },
      };
    } catch {
      return { score: 0, metadata: { error: "Failed to parse judge response" } };
    }
  },
});
```

```ts
// evals/ask.eval.ts
import { evalite } from "evalite";
import { answerQuality } from "./scorers/answer-quality";
import { ask } from "../../src/pipeline/ask";
import { setActivePreset } from "../../src/config/models";

type PresetId = "slim" | "balanced" | "quality";

interface AskCase {
  question: string;
  expectedTopics: string[];  // Key topics the answer should mention
}

const ASK_CASES: AskCase[] = [
  {
    question: "What is the authentication strategy?",
    expectedTopics: ["OAuth", "JWT", "session", "tokens"],
  },
  {
    question: "How do I deploy to production?",
    expectedTopics: ["build", "deploy", "environment", "CI/CD"],
  },
  // Add more cases from fixtures...
];

evalite("Answer Quality by Preset", {
  data: () => {
    // Create test cases for each question x preset combination
    const cases: Array<{
      input: { question: string; preset: PresetId };
      expected: { expectedTopics: string[] };
    }> = [];

    for (const c of ASK_CASES) {
      for (const preset of ["slim", "balanced", "quality"] as PresetId[]) {
        cases.push({
          input: { question: c.question, preset },
          expected: { expectedTopics: c.expectedTopics },
        });
      }
    }
    return cases;
  },

  task: async (input) => {
    // Switch to the target preset
    await setActivePreset(input.preset);

    // Run ask pipeline
    const result = await ask(input.question, { limit: 5 });

    return {
      answer: result.answer,
      citations: result.citations.map(c => c.docid),
      sources: result.sources.map(s => s.content),
    };
  },

  scorers: [
    {
      name: "Answer Quality",
      scorer: async ({ input, output, expected }) =>
        answerQuality.scorer({
          input: { question: input.question, sources: output.sources },
          output: { answer: output.answer, citations: output.citations },
          expected,
        }),
    },
    {
      name: "Has Citations",
      scorer: ({ output }) => ({
        score: output.citations.length > 0 ? 1 : 0,
        metadata: { citationCount: output.citations.length },
      }),
    },
  ],

  columns: ({ input, output }) => [
    { label: "Question", value: input.question.slice(0, 40) },
    { label: "Preset", value: input.preset },
    { label: "Citations", value: output.citations.length.toString() },
  ],

  // Run once per case (LLM judge is deterministic at temp=0)
  trialCount: 1,
});
```

## Local Execution

Evals are run locally as part of the Definition of Done (DoD) and release process—not in CI. This keeps CI fast and avoids needing local LLM models on CI runners.

### Running Evals

```bash
# Run all evals once
bun run eval

# Watch mode (re-runs on file changes)
bun run eval:watch
```

### Threshold Strategy

| Phase | Threshold | Rationale                            |
| ----- | --------- | ------------------------------------ |
| MVP   | 70%       | Baseline, allow room for improvement |
| Beta  | 80%       | Tighten as quality stabilizes        |
| GA    | 90%       | Production quality gate              |

The default threshold is configured in `evalite.config.ts`.

## Tracing

### AI SDK (Automatic)

When using the AI SDK for LLM calls, wrap models for automatic tracing:

```ts
import { openai } from "@ai-sdk/openai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { generateObject } from "ai";

const model = wrapAISDKModel(openai("gpt-5-mini"));

evalite("LLM Expansion", {
  data: [{ input: "termination clause" }],
  task: async (input) => {
    const result = await generateObject({
      model,
      schema: expansionSchema,
      prompt: `Expand this search query: ${input}`,
    });
    return result.object;
  },
  // ...
});
```

Benefits:

- Automatic trace capture (prompts, responses, tokens)
- Automatic caching of identical requests
- Zero overhead in production (no-op outside Evalite)

### Custom Steps (Manual)

For non-LLM pipeline steps (BM25 search, reranking), use `reportTrace()`:

````ts
import { reportTrace } from "evalite/traces";

task: async (input) => {
  // BM25 search step
  const start = performance.now();
  const bm25Results = await searchBm25(input.query, { limit: 50 });
  reportTrace({
    input: { query: input.query, limit: 50 },
    output: { count: bm25Results.length, topScore: bm25Results[0]?.score },
    start,
    end: performance.now(),
  });

  // Reranking step
  const rerankStart = performance.now();
  const reranked = await rerank(input.query, bm25Results);
  reportTrace({
    input: { query: input.query, candidates: bm25Results.length },
    output: { reranked: reranked.length },
    start: rerankStart,
    end: performance.now(),
  });

  return reranked.map(r => r.docid);
}
```

## Storage

### Development (In-Memory)

Default behavior—no configuration needed:

- Fast iteration
- Data lost on process exit
- Good for quick experiments

### Persistent (SQLite)

For tracking scores over time, see Evalite docs: https://evalite.dev

SQLite file would be gitignored; each developer has local history.

### JSON Export

Export results for analysis:

```bash
bun --bun evalite --outputPath=./eval-results.json
```

JSON contains:

- Run metadata
- All eval results with scores
- Traces for debugging

## Acceptance Criteria

### EPIC 11 Complete When:

1. **T11.1 Corpus**: `evals/fixtures/` contains:
   - At least 20 queries with relevance judgments
   - At least 2 docs each in DE, EN, FR, IT
   - At least 3 cross-language query-doc pairs
   - At least 5 ask questions with expected topics

2. **T11.2 Harness**: All eval files pass:
   - `vsearch.eval.ts` with Recall@5, Recall@10, nDCG@10
   - `query.eval.ts` with ranking + latency metrics
   - `expansion.eval.ts` with schema validity
   - `multilingual.eval.ts` with cross-language recall
   - `thoroughness.eval.ts` with fast/balanced/thorough comparison
   - `ask.eval.ts` with answer quality across presets (requires OPENAI_API_KEY)

3. **T11.3 Documentation**:
   - CLAUDE.md updated with eval commands
   - CONTRIBUTING.md updated with DoD eval requirements
   - This spec (spec/evals.md) matches implementation
````
