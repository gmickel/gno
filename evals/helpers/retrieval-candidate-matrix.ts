import type { QueryModeInput } from "../../src/pipeline/types";

import { DEFAULT_MODEL_PRESETS } from "../../src/config/types";
import askCasesJson from "../fixtures/ask-cases.json";
import adversarialJson from "../fixtures/hybrid-adversarial.json";
import queriesJson from "../fixtures/queries.json";

interface QueryFixture {
  id: string;
  query: string;
  language?: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

interface AdversarialFixture extends QueryFixture {
  category:
    | "entity"
    | "phrase"
    | "negation"
    | "ambiguous"
    | "acronym"
    | "near-miss";
  queryModes?: QueryModeInput[];
}

interface AskFixture {
  id: string;
  question: string;
  expectedTopics: string[];
  mockSources: string[];
}

export interface CandidateMatrixEntry {
  id: string;
  label: string;
  family: string;
  uri: string;
  quantization: string;
  sourceModelUrl: string;
  ggufUrl: string;
  roleTests: Array<"expand" | "answer">;
  expectedRamGiB: number;
  expectedVramGiB: number;
  notes?: string;
}

export interface RetrievalBenchmarkCase {
  id: string;
  caseSet: "baseline" | "adversarial" | "multilingual" | "ask";
  category: string;
  query: string;
  lang?: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
  queryModes?: QueryModeInput[];
}

export interface AnswerSmokeCase {
  id: string;
  question: string;
  expectedTopics: string[];
  mockSources: string[];
}

export interface ExpansionSmokeCase {
  id: string;
  label: string;
  query: string;
  lang?: string;
  intent?: string;
}

const slimPreset = DEFAULT_MODEL_PRESETS.find((preset) => preset.id === "slim");
const balancedPreset = DEFAULT_MODEL_PRESETS.find(
  (preset) => preset.id === "balanced"
);
const qualityPreset = DEFAULT_MODEL_PRESETS.find(
  (preset) => preset.id === "quality"
);

if (!(slimPreset && balancedPreset && qualityPreset)) {
  throw new Error(
    "Default model presets missing required slim/balanced/quality"
  );
}

export const RETRIEVAL_CANDIDATES: CandidateMatrixEntry[] = [
  {
    id: "current-qwen3-1.7b-q4",
    label: "Current shipped slim baseline",
    family: "Qwen3-1.7B",
    uri: slimPreset.gen,
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen3-1.7B",
    ggufUrl: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 2.2,
    expectedVramGiB: 1.6,
    notes: "Current expansion baseline in slim preset.",
  },
  {
    id: "current-qwen2.5-3b-q4",
    label: "Current shipped balanced baseline",
    family: "Qwen2.5-3B-Instruct",
    uri: balancedPreset.gen,
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct",
    ggufUrl: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 3.6,
    expectedVramGiB: 2.7,
    notes: "Current balanced preset baseline for answer-side comparison.",
  },
  {
    id: "current-qwen3-4b-q4",
    label: "Current shipped quality baseline",
    family: "Qwen3-4B-Instruct-2507",
    uri: qualityPreset.gen,
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen3-4B-2507",
    ggufUrl: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 4.8,
    expectedVramGiB: 3.8,
    notes: "Current quality preset baseline for answer-side comparison.",
  },
  {
    id: "qwen3.5-0.8b-q4",
    label: "Qwen3.5 0.8B",
    family: "Qwen3.5-0.8B",
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q4_K_M.gguf",
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen3.5-0.8B",
    ggufUrl: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 1.4,
    expectedVramGiB: 1.1,
    notes:
      "Smallest Qwen3.5 candidate. Tests whether newer base beats current 1.7B.",
  },
  {
    id: "qwen3.5-4b-q4",
    label: "Qwen3.5 4B",
    family: "Qwen3.5-4B",
    uri: "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf",
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen3.5-4B",
    ggufUrl: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 6.1,
    expectedVramGiB: 4.9,
    notes: "Primary medium-size Qwen3.5 candidate.",
  },
  {
    id: "qwen3.5-9b-q4",
    label: "Qwen3.5 9B",
    family: "Qwen3.5-9B",
    uri: "hf:unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf",
    quantization: "Q4_K_M",
    sourceModelUrl: "https://huggingface.co/Qwen/Qwen3.5-9B",
    ggufUrl: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF",
    roleTests: ["expand", "answer"],
    expectedRamGiB: 12.8,
    expectedVramGiB: 10.2,
    notes:
      "High-capability local candidate; only promote if latency stays practical.",
  },
];

const baselineQueries = (queriesJson as QueryFixture[])
  .filter((fixture) => !fixture.id.startsWith("ml"))
  .map<RetrievalBenchmarkCase>((fixture) => ({
    id: fixture.id,
    caseSet: "baseline",
    category: "baseline",
    query: fixture.query,
    lang: fixture.language,
    relevantDocs: fixture.relevantDocs,
    judgments: fixture.judgments,
  }));

const multilingualQueries = (queriesJson as QueryFixture[])
  .filter((fixture) => fixture.id.startsWith("ml"))
  .map<RetrievalBenchmarkCase>((fixture) => ({
    id: fixture.id,
    caseSet: "multilingual",
    category: "multilingual",
    query: fixture.query,
    lang: fixture.language,
    relevantDocs: fixture.relevantDocs,
    judgments: fixture.judgments,
  }));

const adversarialQueries = (
  adversarialJson as AdversarialFixture[]
).map<RetrievalBenchmarkCase>((fixture) => ({
  id: fixture.id,
  caseSet: "adversarial",
  category: fixture.category,
  query: fixture.query,
  lang: fixture.language,
  relevantDocs: fixture.relevantDocs,
  judgments: fixture.judgments,
  queryModes: fixture.queryModes,
}));

const askRetrievalQueries = (
  askCasesJson as AskFixture[]
).map<RetrievalBenchmarkCase>((fixture) => ({
  id: fixture.id,
  caseSet: "ask",
  category: "ask",
  query: fixture.question,
  relevantDocs: fixture.mockSources,
  judgments: fixture.mockSources.map((docid) => ({ docid, relevance: 3 })),
}));

export const RETRIEVAL_BENCHMARK_CASES: RetrievalBenchmarkCase[] = [
  ...baselineQueries,
  ...multilingualQueries,
  ...adversarialQueries,
  ...askRetrievalQueries,
];

export const ANSWER_SMOKE_CASES: AnswerSmokeCase[] = (
  askCasesJson as AskFixture[]
).filter((fixture) =>
  new Set(["ask1", "ask3", "ask6", "ask8"]).has(fixture.id)
);

export const EXPANSION_SMOKE_CASES: ExpansionSmokeCase[] = [
  {
    id: "smoke-entity",
    label: "entity-heavy",
    query: "ECONNREFUSED 127.0.0.1:5432",
    intent: "database connection refused troubleshooting",
  },
  {
    id: "smoke-negation",
    label: "negation-sensitive",
    query: 'connection timeout -"ECONNREFUSED"',
    intent: "exclude connection refused cases",
  },
  {
    id: "smoke-phrase",
    label: "quoted phrase",
    query: '"Authorization: Bearer" token endpoint',
  },
  {
    id: "smoke-ask",
    label: "ask-style retrieval",
    query: "How do I authenticate API requests?",
  },
  {
    id: "smoke-fr",
    label: "multilingual-fr",
    query: "sécurité authentification JWT",
    lang: "fr",
  },
  {
    id: "smoke-de",
    label: "multilingual-de",
    query: "helm rollback app -upgrade",
    lang: "de",
  },
];
