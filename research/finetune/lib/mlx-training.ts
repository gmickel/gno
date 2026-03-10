import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { join } from "node:path";

export interface RetrievalJudgment {
  docid: string;
  relevance: number;
}

export interface TrainingExample {
  id: string;
  query: string;
  lang?: string;
  intent?: string;
  tags?: string[];
  source: {
    kind: "handcrafted" | "synthetic" | "distilled" | "imported";
    name: string;
    provenance?: string;
  };
  constraints?: {
    quotedPhrases?: string[];
    negations?: string[];
    criticalEntities?: string[];
  };
  retrievalTargets?: {
    relevantDocs: string[];
    judgments: RetrievalJudgment[];
  };
  target: {
    lexicalQueries: string[];
    vectorQueries: string[];
    hyde?: string;
  };
}

export interface DatasetMixEntry {
  name: string;
  path: string;
  repeat?: number;
  maxExamples?: number;
}

export interface DatasetMixConfig {
  id: string;
  seed: number;
  entries: DatasetMixEntry[];
}

export interface PromptProfile {
  id: string;
  systemPrefix: string;
  requiredKeys: string[];
  optionalKeys: string[];
  rules: string[];
  formatReminder: string;
}

export interface MlxChatExample {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  metadata: {
    id: string;
    source: string;
    tags: string[];
  };
}

const QMD_OUTPUT_TYPES = new Set(["lex", "vec", "hyde"]);
const QUOTED_PHRASE_PATTERN = /"([^"]+)"/g;
const NEGATION_PATTERN = /-(?:"([^"]+)"|([^\s]+))/g;
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9.+#:_/-]*/g;
const OUTPUT_SCHEMA_PATH = join(
  import.meta.dir,
  "../schemas/expansion-training-example.schema.json"
);
const PROMPT_PROFILE_PATH = join(import.meta.dir, "../configs/prompt-profile.json");

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function extractQueryConstraints(query: string): NonNullable<
  TrainingExample["constraints"]
> {
  const quotedPhrases = unique(
    [...query.matchAll(QUOTED_PHRASE_PATTERN)].map((match) => match[1] ?? "")
  );
  const negations = unique(
    [...query.matchAll(NEGATION_PATTERN)].map((match) => {
      const phrase = match[1]?.trim();
      if (phrase) {
        return `-"${phrase}"`;
      }
      return match[2]?.trim() ? `-${match[2]?.trim()}` : "";
    })
  );
  const criticalEntities = unique(
    (query.match(TOKEN_PATTERN) ?? []).filter((token) => {
      return (
        /[A-Z]/.test(token) ||
        /[+#.:/]/.test(token) ||
        /[A-Za-z]\d|\d[A-Za-z]/.test(token)
      );
    })
  );

  return {
    quotedPhrases,
    negations,
    criticalEntities,
  };
}

export function qmdPairsToTarget(
  output: unknown
): TrainingExample["target"] | null {
  if (!Array.isArray(output)) {
    return null;
  }

  const lexicalQueries: string[] = [];
  const vectorQueries: string[] = [];
  let hyde: string | undefined;

  for (const item of output) {
    if (!Array.isArray(item) || item.length < 2) {
      continue;
    }
    const kind = item[0];
    const text = item[1];
    if (typeof kind !== "string" || typeof text !== "string") {
      continue;
    }
    if (!QMD_OUTPUT_TYPES.has(kind)) {
      continue;
    }

    if (kind === "lex") {
      lexicalQueries.push(text);
    } else if (kind === "vec") {
      vectorQueries.push(text);
    } else if (!hyde) {
      hyde = text;
    }
  }

  const dedupedLex = unique(lexicalQueries).slice(0, 5);
  const dedupedVec = unique(vectorQueries).slice(0, 5);
  if (dedupedLex.length === 0 || dedupedVec.length === 0) {
    return null;
  }

  return {
    lexicalQueries: dedupedLex,
    vectorQueries: dedupedVec,
    hyde: hyde?.trim() || undefined,
  };
}

const RECENCY_DRIFT_PATTERN =
  /\b(?:latest|recent|news|release|version|2025|2026)\b/i;

export function shouldFilterImportedExample(
  query: string,
  target: TrainingExample["target"]
): boolean {
  const joined = [...target.lexicalQueries, ...target.vectorQueries, target.hyde ?? ""]
    .join("\n")
    .toLowerCase();

  if (RECENCY_DRIFT_PATTERN.test(query) || RECENCY_DRIFT_PATTERN.test(joined)) {
    return true;
  }

  return false;
}

export function buildMlxUserPrompt(
  example: TrainingExample,
  profile: PromptProfile
): string {
  const lines = [
    profile.systemPrefix,
    `Query: "${example.query}"`,
  ];

  if (example.intent?.trim()) {
    lines.push(`Query intent: "${example.intent.trim()}"`);
  }

  lines.push(
    profile.formatReminder,
    `Required keys: ${profile.requiredKeys.map((value) => `"${value}"`).join(", ")}.`,
    `Optional keys: ${profile.optionalKeys.map((value) => `"${value}"`).join(", ")}.`,
    "Rules:",
    ...profile.rules.map((rule) => `- ${rule}`)
  );

  return lines.join("\n");
}

export function buildMlxAssistantResponse(example: TrainingExample): string {
  return `${JSON.stringify(example.target)}\n`;
}

export function toMlxChatExample(
  example: TrainingExample,
  profile: PromptProfile
): MlxChatExample {
  return {
    messages: [
      { role: "user", content: buildMlxUserPrompt(example, profile) },
      {
        role: "assistant",
        content: buildMlxAssistantResponse(example),
      },
    ],
    metadata: {
      id: example.id,
      source: example.source.name,
      tags: example.tags ?? [],
    },
  };
}

export async function loadDatasetMixConfig(path: string): Promise<DatasetMixConfig> {
  return (await Bun.file(path).json()) as DatasetMixConfig;
}

export async function loadPromptProfile(path = PROMPT_PROFILE_PATH): Promise<PromptProfile> {
  return (await Bun.file(path).json()) as PromptProfile;
}

export async function validateTrainingExample(
  example: TrainingExample
): Promise<void> {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const schema = (await Bun.file(OUTPUT_SCHEMA_PATH).json()) as object;
  const validate = ajv.compile(schema);
  if (!validate(example)) {
    throw new Error(ajv.errorsText(validate.errors));
  }
}
