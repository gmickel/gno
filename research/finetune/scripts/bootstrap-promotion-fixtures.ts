#!/usr/bin/env bun
// node:path: Bun has no path join helpers.
import { join } from "node:path";

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
  queryModes?: Array<{ mode: "term" | "intent" | "hyde"; text: string }>;
}

interface AskFixture {
  id: string;
  question: string;
  mockSources: string[];
}

interface PromotionCase {
  id: string;
  split: "train" | "validation" | "heldout";
  caseSet: "baseline" | "adversarial" | "multilingual" | "ask";
  category: string;
  query: string;
  lang?: string;
  queryModes?: Array<{ mode: "term" | "intent" | "hyde"; text: string }>;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
  smokeTags: string[];
  sourceFixture: string;
}

type PromotionCaseInput = Omit<PromotionCase, "split" | "smokeTags">;

const repoRoot = join(import.meta.dir, "../../..");
const fixturesDir = join(repoRoot, "evals/fixtures");
const outDir = join(repoRoot, "research/finetune/data");

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function pickSplit(item: PromotionCaseInput): PromotionCase["split"] {
  if (item.caseSet === "ask" || item.caseSet === "multilingual") {
    return "heldout";
  }
  if (
    item.caseSet === "adversarial" &&
    (item.category === "entity" || item.category === "negation")
  ) {
    return "heldout";
  }
  if (item.caseSet === "adversarial") {
    return "validation";
  }

  const digits = Number.parseInt(item.id.replace(/\D/g, ""), 10);
  if (Number.isFinite(digits) && digits % 5 === 0) {
    return "validation";
  }
  return "train";
}

function buildSmokeTags(item: PromotionCaseInput): string[] {
  const tags = [item.caseSet, item.category];
  if (item.caseSet === "ask") {
    tags.push("ask-style");
  }
  if (item.caseSet === "multilingual") {
    tags.push("multilingual");
  }
  if (item.queryModes?.some((mode) => mode.mode === "intent")) {
    tags.push("intent");
  }
  if (item.query.includes("-")) {
    tags.push("negation");
  }
  if (/[A-Z]/.test(item.query)) {
    tags.push("entity");
  }
  return unique(tags);
}

async function main(): Promise<void> {
  const queries = (await Bun.file(
    join(fixturesDir, "queries.json")
  ).json()) as QueryFixture[];
  const adversarial = (await Bun.file(
    join(fixturesDir, "hybrid-adversarial.json")
  ).json()) as AdversarialFixture[];
  const askCases = (await Bun.file(
    join(fixturesDir, "ask-cases.json")
  ).json()) as AskFixture[];

  const cases: PromotionCase[] = [];

  for (const item of queries) {
    const caseSet = item.id.startsWith("ml") ? "multilingual" : "baseline";
    const baseCase = {
      id: item.id,
      caseSet,
      category: caseSet === "multilingual" ? "multilingual" : "baseline",
      query: item.query,
      lang: item.language,
      relevantDocs: item.relevantDocs,
      judgments: item.judgments,
      sourceFixture:
        caseSet === "multilingual" ? "queries.json#ml" : "queries.json",
    } satisfies Omit<PromotionCase, "split" | "smokeTags">;
    cases.push({
      ...baseCase,
      split: pickSplit(baseCase),
      smokeTags: buildSmokeTags(baseCase),
    });
  }

  for (const item of adversarial) {
    const baseCase = {
      id: item.id,
      caseSet: "adversarial" as const,
      category: item.category,
      query: item.query,
      lang: item.language,
      queryModes: item.queryModes,
      relevantDocs: item.relevantDocs,
      judgments: item.judgments,
      sourceFixture: "hybrid-adversarial.json",
    };
    cases.push({
      ...baseCase,
      split: pickSplit(baseCase),
      smokeTags: buildSmokeTags(baseCase),
    });
  }

  for (const item of askCases) {
    const baseCase = {
      id: item.id,
      caseSet: "ask" as const,
      category: "ask",
      query: item.question,
      relevantDocs: item.mockSources,
      judgments: item.mockSources.map((docid) => ({ docid, relevance: 3 })),
      sourceFixture: "ask-cases.json",
    };
    cases.push({
      ...baseCase,
      split: pickSplit(baseCase),
      smokeTags: buildSmokeTags(baseCase),
    });
  }

  const promotionJsonl = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  await Bun.write(
    join(outDir, "promotion/promotion-cases.jsonl"),
    promotionJsonl
  );

  for (const split of ["train", "validation", "heldout"] as const) {
    const splitCases = cases.filter((item) => item.split === split);
    const manifest = {
      split,
      caseCount: splitCases.length,
      caseIds: splitCases.map((item) => item.id),
      caseSets: unique(splitCases.map((item) => item.caseSet)),
      categories: unique(splitCases.map((item) => item.category)),
      sources: unique(splitCases.map((item) => item.sourceFixture)),
    };
    await Bun.write(
      join(outDir, `splits/${split}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  console.log(`Wrote ${cases.length} promotion cases`);
}

await main();
