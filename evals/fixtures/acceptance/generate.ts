/** Synthetic audit generators. No paths, text, or measurements from a private corpus. */
import type { ChunkInput } from "../../../src/store/types";

import { sha256Bytes } from "../../agentic/canonical";

export interface AcceptanceDocument {
  collection: string;
  relPath: string;
  title: string;
  language: string;
  content: string;
  sourceHash: string;
  mirrorHash: string;
  sourceMtime: string;
  active: boolean;
  chunks: ChunkInput[];
}

export interface AcceptanceFixtureCase {
  caseId: string;
  query: string;
  collection: string;
  since?: string;
  language?: string;
  limit: number;
  scenario:
    | "eligible-top-k"
    | "hydration"
    | "reranking"
    | "expiry"
    | "restoration"
    | "title-variants";
  /** Lifecycle steps are instructions for the running adapter, not simulated passes. */
  steps: string[];
}

function document(
  collection: string,
  relPath: string,
  title: string,
  language: string,
  texts: string[],
  sourceMtime = "2026-09-01T00:00:00Z"
): AcceptanceDocument {
  const content = texts.join("\n");
  let pos = 0;
  const chunks = texts.map((text, seq) => {
    const chunk = {
      seq,
      pos,
      text,
      startLine: seq + 1,
      endLine: seq + 1,
      language,
    };
    pos += text.length + 1;
    return chunk;
  });
  const hash = sha256Bytes(content);
  return {
    collection,
    relPath,
    title,
    language,
    content,
    sourceHash: hash,
    mirrorHash: hash,
    sourceMtime,
    active: true,
    chunks,
  };
}

const LANGUAGES = [
  {
    language: "en",
    query: "What is the verified launch code for project Orion?",
    yes: "The verified launch code for project Orion is BLUE SEVEN.",
    no: "The verified launch code for project Orion is unknown.",
    filler: "Archive entry containing ordinary background information. ",
  },
  {
    language: "de",
    query: "Wie lautet der bestätigte Startcode für Projekt Orion?",
    yes: "Der bestätigte Startcode für Projekt Orion lautet BLAU SIEBEN.",
    no: "Der bestätigte Startcode für Projekt Orion ist unbekannt.",
    filler: "Archivmaterial mit allgemeinen Angaben zur Dokumentation. ",
  },
  {
    language: "zh",
    query: "猎户项目已确认的启动代码是什么？",
    yes: "猎户项目已确认的启动代码是蓝色七号。",
    no: "猎户项目的启动代码尚未确认。",
    filler: "档案记录描述普通背景材料并保存历史信息。",
  },
] as const;
const fill = (text: string, length: number): string =>
  text.repeat(Math.ceil(length / text.length)).slice(0, length);

export function generateSyntheticAcceptanceCorpus(): {
  documents: AcceptanceDocument[];
  cases: AcceptanceFixtureCase[];
} {
  const documents: AcceptanceDocument[] = [];
  const cases: AcceptanceFixtureCase[] = [];
  for (let i = 0; i < 201; i++) {
    const eligible = i === 200;
    documents.push(
      document(
        "eligible",
        `${i}.md`,
        eligible ? "target" : "needle",
        "en",
        [`needle ${eligible ? "filler ".repeat(50) : `archive ${i}`}`],
        eligible ? "2026-09-01T00:00:00Z" : "2025-01-01T00:00:00Z"
      )
    );
  }
  cases.push({
    caseId: "eligible-top-k",
    query: "needle",
    collection: "eligible",
    since: "2026-01-01",
    limit: 1,
    scenario: "eligible-top-k",
    steps: [],
  });
  documents.push(
    document(
      "hydration",
      "1000.md",
      "hydrationprobe",
      "en",
      Array.from(
        { length: 1000 },
        () => `hydrationprobe ${"payload ".repeat(250)}`
      )
    )
  );
  cases.push({
    caseId: "hydration-1000",
    query: "hydrationprobe",
    collection: "hydration",
    limit: 1,
    scenario: "hydration",
    steps: [],
  });
  for (const lang of LANGUAGES) {
    for (const size of [1000, 4000, 4001, 8000, 16000]) {
      for (const position of ["start", "boundary", "end"] as const) {
        const collection = `rerank-${lang.language}-${size}-${position}`;
        for (const [label, claim] of [
          ["confirmed", lang.yes],
          ["unknown", lang.no],
        ] as const) {
          const at =
            position === "start"
              ? 0
              : position === "end"
                ? size - claim.length
                : Math.min(size - claim.length, 3980);
          documents.push(
            document(collection, `${label}.md`, label, lang.language, [
              fill(lang.filler, at) +
                claim +
                fill(lang.filler, size - at - claim.length),
            ])
          );
        }
        cases.push({
          caseId: collection,
          query: lang.query,
          collection,
          language: lang.language,
          limit: 2,
          scenario: "reranking",
          steps: [],
        });
      }
    }
  }
  cases.push({
    caseId: "rerank-long-query-zh",
    query: fill(LANGUAGES[2].query, 6000),
    collection: "rerank-zh-16000-end",
    language: "zh",
    limit: 2,
    scenario: "reranking",
    steps: [],
  });
  for (const scenario of ["expiry", "restoration"] as const) {
    documents.push(
      document(scenario, "stable.md", "Stable", "en", [
        "sentinel stable synthetic evidence",
      ])
    );
    cases.push({
      caseId: scenario,
      query: "sentinel",
      collection: scenario,
      limit: 1,
      scenario,
      steps:
        scenario === "expiry"
          ? [
              "query",
              "release-lease",
              "expire-models",
              "query-identical",
              "query-novel",
            ]
          : [
              "index",
              "remove-source",
              "sync",
              "restore-identical-source",
              "sync",
              "query",
            ],
    });
  }
  for (const title of ["Alpha", "Beta"])
    documents.push(
      document("titles", `${title}.md`, title, "en", [
        "sentinel unchanged body",
      ])
    );
  cases.push({
    caseId: "title-variants",
    query: "sentinel",
    collection: "titles",
    limit: 2,
    scenario: "title-variants",
    steps: [
      "ingest-forward",
      "ingest-reverse",
      "compare-title-conditioned-inputs",
    ],
  });
  return { documents, cases };
}
