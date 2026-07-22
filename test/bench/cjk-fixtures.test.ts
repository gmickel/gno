import { describe, expect, test } from "bun:test";

const FIXTURE_ROOT = "evals/fixtures/cjk-lexical-benchmark";
const CORPUS_ROOT = `${FIXTURE_ROOT}/corpus`;
const LANGUAGES = ["zh", "ja", "ko"] as const;

type Language = (typeof LANGUAGES)[number];
type Category =
  | "exact-term"
  | "filename"
  | "identifier"
  | "mixed-script"
  | "normalization"
  | "punctuation"
  | "ranking"
  | "token-boundary";

interface Manifest {
  version: number;
  languages: Language[];
  requiredCategories: Category[];
  minimums: {
    documentsPerLanguage: number;
    queriesPerLanguage: number;
  };
  license: {
    spdx: string;
    path: string;
    scope: string;
  };
  provenanceReview: {
    reviewedAt: string;
    redistributable: boolean;
    externalTextIncluded: boolean;
    method: string;
  };
  unicodePolicy: {
    encoding: string;
    corpusNormalization: string;
    intentionalQueryVariants: string[];
  };
}

interface Source {
  id: string;
  language: Language;
  license: string;
  provenance: string;
  authoredAt: string;
  normalization: string;
  contentSha256: string;
}

interface NormalizationVariant {
  form: "NFC" | "NFKC";
  source: string;
  target: string;
}

interface Query {
  id: string;
  language: Language;
  query: string;
  category: Category;
  notes: string;
  normalizationVariant?: NormalizationVariant;
  rankingVariant?: {
    relevantDiscriminator: string;
    sharedTerms: string[];
  };
}

interface Qrels {
  version: number;
  scale: Record<string, string>;
  judgments: Array<{
    queryId: string;
    docid: string;
    relevance: number;
  }>;
}

interface Fixtures {
  manifest: Manifest;
  sources: Source[];
  queries: Query[];
  qrels: Qrels;
}

const loadJson = async <T>(path: string): Promise<T> =>
  (await Bun.file(path).json()) as T;

const loadFixtures = async (): Promise<Fixtures> => ({
  manifest: await loadJson<Manifest>(`${FIXTURE_ROOT}/manifest.json`),
  sources: await loadJson<Source[]>(`${FIXTURE_ROOT}/sources.json`),
  queries: await loadJson<Query[]>(`${FIXTURE_ROOT}/queries.json`),
  qrels: await loadJson<Qrels>(`${FIXTURE_ROOT}/qrels.json`),
});

const sha256 = async (file: Bun.BunFile): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await file.arrayBuffer());
  return hasher.digest("hex");
};

describe("CJK lexical benchmark fixture contract", () => {
  test("records a redistributable, self-authored provenance review", async () => {
    const { manifest } = await loadFixtures();

    expect(manifest.version).toBe(1);
    expect(new Set(manifest.languages)).toEqual(new Set(LANGUAGES));
    expect(manifest.license.spdx).toBe("MIT");
    expect(manifest.license.scope).toContain("corpus documents");
    expect(
      await Bun.file(`${FIXTURE_ROOT}/${manifest.license.path}`).exists()
    ).toBe(true);
    expect(manifest.provenanceReview).toMatchObject({
      reviewedAt: "2026-07-22",
      redistributable: true,
      externalTextIncluded: false,
    });
    expect(manifest.provenanceReview.method).toContain("no upstream");
    expect(manifest.unicodePolicy).toEqual({
      encoding: "UTF-8",
      corpusNormalization: "NFC",
      intentionalQueryVariants: ["NFD", "NFKC"],
    });
  });

  test("freezes every opaque corpus document with license and digest", async () => {
    const { manifest, sources } = await loadFixtures();
    const sourceIds = sources.map((source) => source.id).sort();
    const actualIds: string[] = [];
    const glob = new Bun.Glob("**/*.md");
    for await (const path of glob.scan(CORPUS_ROOT)) {
      actualIds.push(path);
    }

    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(sourceIds).toEqual(actualIds.sort());

    for (const language of LANGUAGES) {
      expect(
        sources.filter((source) => source.language === language).length
      ).toBeGreaterThanOrEqual(manifest.minimums.documentsPerLanguage);
    }

    for (const source of sources) {
      expect(source.id).toMatch(/^(?:zh|ja|ko)\/d\d{3}\.md$/);
      expect(source.id.startsWith(`${source.language}/`)).toBe(true);
      expect(source).toMatchObject({
        license: "MIT",
        provenance: "original-synthetic",
        authoredAt: "2026-07-22",
        normalization: "NFC",
      });
      expect(source.contentSha256).toMatch(/^[a-f0-9]{64}$/);

      const file = Bun.file(`${CORPUS_ROOT}/${source.id}`);
      expect(await file.exists()).toBe(true);
      const text = await file.text();
      expect(text).toBe(text.normalize("NFC"));
      expect(text.length).toBeGreaterThan(100);
      expect(await sha256(file)).toBe(source.contentSha256);
    }
  });

  test("covers every diagnostic category independently per language", async () => {
    const { manifest, queries } = await loadFixtures();

    expect(new Set(queries.map((query) => query.id)).size).toBe(queries.length);
    for (const language of LANGUAGES) {
      const languageQueries = queries.filter(
        (query) => query.language === language
      );
      expect(languageQueries.length).toBeGreaterThanOrEqual(
        manifest.minimums.queriesPerLanguage
      );
      expect(
        manifest.requiredCategories.every((category) =>
          languageQueries.some((query) => query.category === category)
        )
      ).toBe(true);
      expect(
        languageQueries.every((query) => query.id.startsWith(`${language}-q`))
      ).toBe(true);
    }

    expect(queries.some((query) => /[\u4e00-\u9fff]/u.test(query.query))).toBe(
      true
    );
    expect(queries.some((query) => /[\u3040-\u30ff]/u.test(query.query))).toBe(
      true
    );
    expect(queries.some((query) => /[\uac00-\ud7af]/u.test(query.query))).toBe(
      true
    );
    expect(queries.some((query) => /[A-Z]+[_-]\d+/u.test(query.query))).toBe(
      true
    );
    expect(queries.some((query) => query.category === "ranking")).toBe(true);
  });

  test("keeps qrels complete, graded, and language-local", async () => {
    const { qrels, queries, sources } = await loadFixtures();
    const queriesById = new Map(queries.map((query) => [query.id, query]));
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const judgedQueries = new Set<string>();
    const judgedSources = new Set<string>();
    const judgmentKeys = new Set<string>();

    expect(qrels.version).toBe(1);
    expect(qrels.scale).toEqual({
      "0": "not relevant",
      "1": "related context",
      "2": "useful answer context",
      "3": "direct answer",
    });

    for (const judgment of qrels.judgments) {
      const query = queriesById.get(judgment.queryId);
      const source = sourcesById.get(judgment.docid);
      expect(query).toBeDefined();
      expect(source).toBeDefined();
      expect(source?.language).toBe(query?.language);
      expect(Number.isInteger(judgment.relevance)).toBe(true);
      expect(judgment.relevance).toBeGreaterThanOrEqual(0);
      expect(judgment.relevance).toBeLessThanOrEqual(3);

      const key = `${judgment.queryId}:${judgment.docid}`;
      expect(judgmentKeys.has(key)).toBe(false);
      judgmentKeys.add(key);
      judgedQueries.add(judgment.queryId);
      judgedSources.add(judgment.docid);
    }

    expect(judgedQueries).toEqual(new Set(queriesById.keys()));
    expect(judgedSources).toEqual(new Set(sourcesById.keys()));
    for (const query of queries) {
      expect(
        qrels.judgments.some(
          (judgment) =>
            judgment.queryId === query.id && judgment.relevance === 3
        )
      ).toBe(true);
    }
  });

  test("rejects answer-bearing fixture paths and query metadata leakage", async () => {
    const { qrels, queries, sources } = await loadFixtures();

    for (const query of queries) {
      const normalizedQuery = query.query.toLowerCase();
      expect(normalizedQuery).not.toMatch(/(?:zh|ja|ko)\/d\d{3}\.md/u);
      for (const source of sources) {
        const basename = source.id.slice(3, -3);
        expect(normalizedQuery).not.toContain(basename);
      }

      const relevantDocs = qrels.judgments.filter(
        (judgment) => judgment.queryId === query.id
      );
      for (const judgment of relevantDocs) {
        const text = await Bun.file(`${CORPUS_ROOT}/${judgment.docid}`).text();
        const heading = text.split("\n", 1)[0]?.replace(/^#\s+/u, "") ?? "";
        expect(query.query).not.toBe(heading);
      }
    }
  });

  test("defines valid normalization failures with canonical relevant text", async () => {
    const { qrels, queries } = await loadFixtures();
    const cases = queries.filter((query) => query.category === "normalization");

    expect(new Set(cases.map((query) => query.language))).toEqual(
      new Set(LANGUAGES)
    );
    for (const query of cases) {
      const variant = query.normalizationVariant;
      expect(variant).toBeDefined();
      if (!variant) {
        throw new Error(`Missing normalization variant for ${query.id}`);
      }
      expect(variant.source).not.toBe(variant.target);
      expect(variant.source.normalize(variant.form)).toBe(variant.target);
      expect(query.query).toContain(variant.source);

      const directDoc = qrels.judgments.find(
        (judgment) => judgment.queryId === query.id && judgment.relevance === 3
      )?.docid;
      expect(directDoc).toBeDefined();
      if (!directDoc) {
        throw new Error(`Missing direct qrel for ${query.id}`);
      }
      const text = await Bun.file(`${CORPUS_ROOT}/${directDoc}`).text();
      expect(text).toContain(variant.target);
      expect(text).not.toContain(variant.source);
    }
  });

  test("makes ranking relevance unique while decoys match the shared terms out of phrase", async () => {
    const { qrels, queries, sources } = await loadFixtures();
    const rankingCases = queries.filter(
      (query) => query.category === "ranking"
    );

    expect(rankingCases).toHaveLength(1);
    for (const query of rankingCases) {
      const variant = query.rankingVariant;
      expect(variant).toBeDefined();
      if (!variant) {
        throw new Error(`Missing ranking variant for ${query.id}`);
      }
      expect(variant.relevantDiscriminator).toMatch(/\p{Script=Han}/u);
      expect(variant.sharedTerms.length).toBeGreaterThanOrEqual(2);
      expect(query.query).toContain(variant.relevantDiscriminator);
      for (const sharedTerm of variant.sharedTerms) {
        expect(query.query).toContain(sharedTerm);
      }

      const relevantDoc = qrels.judgments.find(
        (judgment) => judgment.queryId === query.id && judgment.relevance === 3
      )?.docid;
      expect(relevantDoc).toBeDefined();
      if (!relevantDoc) {
        throw new Error(`Missing direct qrel for ${query.id}`);
      }

      const languageSources = sources.filter(
        (source) => source.language === query.language
      );
      let sharedOnlyDecoys = 0;
      for (const source of languageSources) {
        const text = await Bun.file(`${CORPUS_ROOT}/${source.id}`).text();
        for (const sharedTerm of variant.sharedTerms) {
          expect(text).toContain(sharedTerm);
        }
        if (source.id === relevantDoc) {
          expect(text).toContain(variant.relevantDiscriminator);
        } else {
          expect(text).not.toContain(variant.relevantDiscriminator);
          sharedOnlyDecoys += 1;
        }
      }
      expect(sharedOnlyDecoys).toBeGreaterThanOrEqual(5);
    }
  });
});
