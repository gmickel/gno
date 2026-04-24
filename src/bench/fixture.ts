import { z } from "zod";

import type { BenchFixture, BenchMode, BenchOptions } from "./types";

const MODE_ALIASES = [
  "bm25",
  "vector",
  "hybrid",
  "fast",
  "no-rerank",
  "thorough",
] as const;

type BenchModeAlias = (typeof MODE_ALIASES)[number];

const queryModeInputSchema = z.object({
  mode: z.enum(["term", "intent", "hyde"]),
  text: z.string().trim().min(1),
});

const modeObjectSchema = z.object({
  name: z.string().trim().min(1).optional(),
  type: z.enum(["bm25", "vector", "hybrid"]).optional(),
  mode: z.enum(MODE_ALIASES).optional(),
  noExpand: z.boolean().optional(),
  noRerank: z.boolean().optional(),
  candidateLimit: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  queryModes: z.array(queryModeInputSchema).optional(),
});

const fixtureSchema = z.object({
  version: z.literal(1),
  metadata: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  collection: z.string().trim().min(1).optional(),
  topK: z.number().int().positive().optional(),
  candidateLimit: z.number().int().positive().optional(),
  modes: z.array(z.union([z.enum(MODE_ALIASES), modeObjectSchema])).optional(),
  queries: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        query: z.string().trim().min(1),
        expected: z.array(z.string().trim().min(1)).optional(),
        expectedDocuments: z.array(z.string().trim().min(1)).optional(),
        expectedUris: z.array(z.string().trim().min(1)).optional(),
        judgments: z
          .array(
            z.object({
              docid: z.string().trim().min(1).optional(),
              doc: z.string().trim().min(1).optional(),
              uri: z.string().trim().min(1).optional(),
              relevance: z.number().min(0),
            })
          )
          .optional(),
        collection: z.string().trim().min(1).optional(),
        topK: z.number().int().positive().optional(),
        queryModes: z.array(queryModeInputSchema).optional(),
      })
    )
    .min(1),
});

type FixtureModeInput = NonNullable<
  z.infer<typeof fixtureSchema>["modes"]
>[number];

export function normalizeBenchRef(value: string): string {
  const trimmed = value.trim();
  const queryIndex = trimmed.indexOf("?");
  return queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
}

function normalizeMode(alias: BenchModeAlias): BenchMode {
  switch (alias) {
    case "bm25":
      return { name: "bm25", type: "bm25" };
    case "vector":
      return { name: "vector", type: "vector" };
    case "fast":
      return {
        name: "fast",
        type: "hybrid",
        noExpand: true,
        noRerank: true,
      };
    case "no-rerank":
      return { name: "no-rerank", type: "hybrid", noRerank: true };
    case "thorough":
      return { name: "thorough", type: "hybrid", depth: "thorough" };
    case "hybrid":
      return { name: "hybrid", type: "hybrid" };
  }
}

function normalizeModeInput(input: FixtureModeInput): BenchMode {
  if (typeof input === "string") {
    return normalizeMode(input as BenchModeAlias);
  }

  const base = input.mode ? normalizeMode(input.mode) : undefined;
  const type = input.type ?? base?.type ?? "hybrid";
  const name = input.name ?? input.mode ?? type;
  return {
    ...base,
    name,
    type,
    depth: base?.depth,
    noExpand: input.noExpand ?? base?.noExpand,
    noRerank: input.noRerank ?? base?.noRerank,
    candidateLimit: input.candidateLimit,
    limit: input.limit,
    queryModes: input.queryModes,
  };
}

function parseModeFlag(
  mode: string
): { ok: true; value: BenchMode } | { ok: false; error: string } {
  const normalized = mode.trim() as BenchModeAlias;
  if (!MODE_ALIASES.includes(normalized)) {
    return {
      ok: false,
      error: `Unsupported bench mode: ${mode}. Supported: ${MODE_ALIASES.join(", ")}`,
    };
  }
  return { ok: true, value: normalizeMode(normalized) };
}

function normalizeModes(
  fixtureModes: z.infer<typeof fixtureSchema>["modes"],
  optionModes?: string[]
): BenchMode[] {
  if (optionModes?.length) {
    return optionModes.map((mode) => {
      const parsed = parseModeFlag(mode);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      return parsed.value;
    });
  }

  return (fixtureModes ?? ["bm25"]).map(normalizeModeInput);
}

function normalizeFixture(
  parsed: z.infer<typeof fixtureSchema>,
  options: BenchOptions
): BenchFixture {
  const modes = normalizeModes(parsed.modes, options.modes);
  const topK = options.topK ?? parsed.topK ?? 10;
  const candidateLimit = options.candidateLimit ?? parsed.candidateLimit;

  return {
    version: parsed.version,
    metadata: parsed.metadata,
    collection: options.collection ?? parsed.collection,
    topK,
    candidateLimit,
    modes,
    queries: parsed.queries.map((entry) => {
      const explicitExpected = [
        ...(entry.expected ?? []),
        ...(entry.expectedDocuments ?? []),
        ...(entry.expectedUris ?? []),
      ].map(normalizeBenchRef);
      const judgments =
        entry.judgments?.flatMap((judgment) => {
          const docid = judgment.docid ?? judgment.doc ?? judgment.uri;
          return docid
            ? [
                {
                  docid: normalizeBenchRef(docid),
                  relevance: judgment.relevance,
                },
              ]
            : [];
        }) ?? [];
      const expected =
        explicitExpected.length > 0
          ? explicitExpected
          : judgments.map((judgment) => judgment.docid);

      return {
        id: entry.id,
        query: entry.query,
        expected,
        judgments,
        collection: options.collection ?? entry.collection ?? parsed.collection,
        topK: entry.topK,
        queryModes: entry.queryModes,
      };
    }),
  };
}

export async function loadBenchFixture(
  fixturePath: string,
  options: BenchOptions
): Promise<{ ok: true; fixture: BenchFixture } | { ok: false; error: string }> {
  const file = Bun.file(fixturePath);
  if (!(await file.exists())) {
    return { ok: false, error: `Fixture not found: ${fixturePath}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON fixture: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }

  try {
    const fixture = normalizeFixture(parsed.data, options);
    const missingExpected = fixture.queries.find(
      (entry) => entry.expected.length === 0
    );
    if (missingExpected) {
      return {
        ok: false,
        error: `Bench query "${missingExpected.id}" must define expected documents, expected URIs, or judgments`,
      };
    }
    return { ok: true, fixture };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
