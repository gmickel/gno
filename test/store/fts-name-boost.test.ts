import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FtsTokenizer } from "../../src/config/types";

import { recallFacts } from "../../src/core/memory-recall";
import { rememberFact } from "../../src/core/memory-remember";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import {
  computeDocumentNameMultiplier,
  computeNameMatchMultiplier,
  extractFilenameStem,
  FTS5_NAME_BOOST,
  SqliteAdapter,
} from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("name-match coverage and multiplier", () => {
  test("constants match agreed design", () => {
    expect(FTS5_NAME_BOOST.candidateLimit).toBe(50);
    expect(FTS5_NAME_BOOST.fullMatchBonus).toBe(2);
    expect(FTS5_NAME_BOOST.minPrefixLength).toBe(3);
  });

  test("full match returns 3x multiplier", () => {
    expect(
      computeNameMatchMultiplier(["acme", "overview"], "Acme Overview")
    ).toBe(3);
    expect(computeNameMatchMultiplier(["acme", "over"], "Acme Overview")).toBe(
      3
    );
  });

  test("one-letter query word does not prefix-match name words", () => {
    // "ratchet, not a gate" against a name whose words start with "a"
    const m = computeNameMatchMultiplier(
      ["ratchet", "not", "a", "gate"],
      "Ratchet Not Another Gate"
    );
    expect(m).toBe(1);

    // Exact match on short word still succeeds
    expect(
      computeNameMatchMultiplier(
        ["ratchet", "not", "a", "gate"],
        "Ratchet, Not a Gate"
      )
    ).toBe(3);

    // Two-character term also requires exact equality, not prefix
    expect(computeNameMatchMultiplier(["go", "api"], "Google API")).toBe(1);
    expect(computeNameMatchMultiplier(["go", "api"], "Go API")).toBe(3);
  });

  test("one-word title against six-word query is capped at 1 + (1/6)^2", () => {
    const m = computeNameMatchMultiplier(
      ["deploy", "pipeline", "rollback", "staging", "cluster", "metrics"],
      "Deploy"
    );
    expect(m).toBeCloseTo(1 + (1 / 6) ** 2, 12);
    expect(m).toBeLessThanOrEqual(1 + (1 / 6) ** 2 + 1e-12);
  });

  test("repeated word in title does not out-cover cleaner title", () => {
    const repeated = computeNameMatchMultiplier(
      ["agent", "harness"],
      "Agent Harnesses - Minimal Agents"
    );
    const cleaner = computeNameMatchMultiplier(
      ["agent", "harness"],
      "Agent Harnesses - Overview"
    );
    // repeated: q=1, n=min(3,2)/4=0.5 -> 1.25
    // cleaner:  q=1, n=min(2,2)/3=2/3 -> 1.444...
    expect(repeated).toBeCloseTo(1 + 0.5 ** 2, 12);
    expect(cleaner).toBeCloseTo(1 + (2 / 3) ** 2, 12);
    expect(repeated).toBeLessThan(cleaner);
  });

  test("partial overlap with neither q==1 nor n==1 returns 1", () => {
    expect(
      computeNameMatchMultiplier(["acme", "pricing"], "Acme Overview")
    ).toBe(1);
  });

  test("extractFilenameStem ignores directories and file extension", () => {
    expect(extractFilenameStem("acme/overview/report.md")).toBe("report");
    expect(extractFilenameStem("sub/dir/Acme_Overview.md")).toBe(
      "Acme_Overview"
    );
    expect(extractFilenameStem("README")).toBe("README");
    expect(extractFilenameStem(".env")).toBe(".env");
    expect(extractFilenameStem("a\\b\\Acme_Overview.docx")).toBe(
      "Acme_Overview"
    );
  });

  test("computeDocumentNameMultiplier takes max of title and filename and ignores dirs", () => {
    expect(
      computeDocumentNameMultiplier(
        ["acme", "overview"],
        "Weekly Sync",
        "acme/overview/report.md"
      )
    ).toBe(1);
    expect(
      computeDocumentNameMultiplier(
        ["acme", "overview"],
        "Weekly Sync",
        "docs/Acme_Overview.md"
      )
    ).toBe(3);
    expect(
      computeDocumentNameMultiplier(
        ["acme", "overview"],
        "Acme Overview",
        "docs/notes.md"
      )
    ).toBe(3);
  });
});

describe("FTS name-match boost store and pipeline behavior (#372)", () => {
  let adapter: SqliteAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-name-boost-"));
    adapter = new SqliteAdapter();
    const opened = await adapter.open(
      join(testDir, "test.sqlite"),
      "unicode61"
    );
    expect(opened.ok).toBe(true);
    await adapter.syncCollections([
      {
        name: "docs",
        path: join(testDir, "docs"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "other",
        path: join(testDir, "other"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function addDoc(input: {
    collection?: string;
    relPath: string;
    title?: string;
    markdown: string;
    tags?: string[];
  }) {
    const collection = input.collection ?? "docs";
    const key = `${collection}_${input.relPath}`.replace(/\W/g, "_");
    const mirrorHash = `mirror_${key}`;
    const up = await adapter.upsertDocument({
      collection,
      relPath: input.relPath,
      sourceHash: `source_${key}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: input.markdown.length,
      sourceMtime: "2026-01-01T00:00:00Z",
      mirrorHash,
      title: input.title,
    });
    expect(up.ok).toBe(true);
    await adapter.upsertContent(mirrorHash, input.markdown);
    await adapter.upsertChunks(mirrorHash, [
      {
        seq: 0,
        pos: 0,
        text: input.markdown,
        startLine: 1,
        endLine: 1,
      },
    ]);
    if (up.ok && input.tags?.length) {
      await adapter.setDocTags(up.value.id, input.tags, "frontmatter");
    }
    await adapter.rebuildFtsForHash(mirrorHash);
  }

  async function seedIssue372Noise(count = 100) {
    for (let i = 1; i <= count; i += 1) {
      const reps = 3 + (i % 13);
      const body = Array.from(
        { length: reps },
        (_, idx) => `Acme overview note ${idx + 1}: Acme overview status.`
      ).join("\n");
      await addDoc({
        relPath: `report-${String(i).padStart(3, "0")}.md`,
        title: `Weekly Sync ${i}`,
        markdown: `# Weekly Sync ${i}\n\n${body}`,
      });
    }
  }

  const longFiller =
    "Quarterly milestones, platform architecture, deployment topology, regional availability, incident response contacts, and onboarding checklists for engineering teams. ".repeat(
      12
    );

  test("ranks named document first at limit 4 with an H1 heading (#372)", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nOrientation note.\n\n${longFiller}`,
    });
    await seedIssue372Noise(100);

    const res = await searchBm25(adapter, "Acme Overview", { limit: 4 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.results).toHaveLength(4);
    expect(res.value.results[0]?.source.relPath).toBe("Acme_Overview.md");
  });

  test("ranks named document first at limit 4 without an H1 heading (#372)", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: undefined,
      markdown: `Orientation note covering the platform.\n\n${longFiller}`,
    });
    await seedIssue372Noise(100);

    const res = await searchBm25(adapter, "Acme Overview", { limit: 4 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.results).toHaveLength(4);
    expect(res.value.results[0]?.source.relPath).toBe("Acme_Overview.md");
  });

  test("filename-only match ranks first while directory-only match is not boosted", async () => {
    await addDoc({
      relPath: "notes/Acme_Overview.md",
      title: "Platform Summary",
      markdown: `Brief orientation.\n\n${longFiller}`,
    });
    await addDoc({
      relPath: "acme_overview/general.md",
      title: "General Notes",
      markdown: `Brief orientation.\n\n${longFiller}`,
    });
    await seedIssue372Noise(80);

    const res = await adapter.searchFts("Acme Overview", {
      limit: 5,
      nameBoost: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value[0]?.relPath).toBe("notes/Acme_Overview.md");
    expect(
      res.value.some((r) => r.relPath === "acme_overview/general.md")
    ).toBe(false);
  });

  test("title plus an extra body word boosts and ranks first", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nIncludes onboarding checklist details.\n\n${longFiller}`,
    });
    for (let i = 1; i <= 60; i += 1) {
      await addDoc({
        relPath: `report-${i}.md`,
        title: `Weekly Sync ${i}`,
        markdown:
          `# Weekly Sync ${i}\n\n` +
          "Acme overview onboarding notes. ".repeat(3 + (i % 4)) +
          longFiller,
      });
    }

    const off = await adapter.searchFts("Acme Overview onboarding", {
      limit: 4,
      nameBoost: false,
    });
    const on = await adapter.searchFts("Acme Overview onboarding", {
      limit: 4,
      nameBoost: true,
    });
    expect(off.ok && on.ok).toBe(true);
    if (!(off.ok && on.ok)) return;

    expect(on.value[0]?.relPath).toBe("Acme_Overview.md");
    const unboostedAcme = off.value.find(
      (r) => r.relPath === "Acme_Overview.md"
    );
    if (unboostedAcme) {
      expect(on.value[0]!.score).toBeCloseTo(
        unboostedAcme.score * (1 + (2 / 3) ** 2),
        10
      );
    }
  });

  test("body-only queries keep identical order and scores to unboosted search", async () => {
    for (let i = 1; i <= 15; i += 1) {
      await addDoc({
        relPath: `entry-${i}.md`,
        title: `Journal Entry ${i}`,
        markdown:
          "Telemetry ingestion latency measurements. ".repeat(1 + (i % 6)) +
          "Additional body text.".repeat(i % 4),
      });
    }

    const off = await adapter.searchFts("telemetry latency", {
      limit: 10,
      nameBoost: false,
    });
    const on = await adapter.searchFts("telemetry latency", {
      limit: 10,
      nameBoost: true,
    });
    expect(off.ok && on.ok).toBe(true);
    if (!(off.ok && on.ok)) return;

    expect(
      on.value.map((r) => ({ relPath: r.relPath, score: r.score }))
    ).toEqual(off.value.map((r) => ({ relPath: r.relPath, score: r.score })));
  });

  test("flag off matches unboosted order and leaves Acme_Overview out of top 4", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nOrientation note.\n\n${longFiller}`,
    });
    await seedIssue372Noise(100);

    const omitted = await adapter.searchFts("Acme Overview", { limit: 4 });
    const explicitOff = await adapter.searchFts("Acme Overview", {
      limit: 4,
      nameBoost: false,
    });
    expect(omitted.ok && explicitOff.ok).toBe(true);
    if (!(omitted.ok && explicitOff.ok)) return;

    expect(omitted.value).toEqual(explicitOff.value);
    expect(omitted.value.some((r) => r.relPath === "Acme_Overview.md")).toBe(
      false
    );
  });

  test("minRelativeScore floor uses best unboosted score so boosted top row does not drop ordinary rows", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: "# Acme Overview\n\nSummary of Acme overview.",
    });
    await addDoc({
      relPath: "ordinary-a.md",
      title: "Weekly Sync A",
      markdown: "Acme overview status. Acme overview notes. Acme overview.",
    });
    await addDoc({
      relPath: "ordinary-b.md",
      title: "Weekly Sync B",
      markdown: "Acme overview status. Acme overview notes.",
    });

    const unboosted = await adapter.searchFts("Acme Overview", {
      limit: 10,
      minRelativeScore: 0.5,
      nameBoost: false,
    });
    const boosted = await adapter.searchFts("Acme Overview", {
      limit: 10,
      minRelativeScore: 0.5,
      nameBoost: true,
    });
    expect(unboosted.ok && boosted.ok).toBe(true);
    if (!(unboosted.ok && boosted.ok)) return;

    // Every ordinary row surviving unboosted must also survive boosted.
    const boostedPaths = new Set(boosted.value.map((r) => r.relPath));
    for (const row of unboosted.value) {
      expect(boostedPaths.has(row.relPath)).toBe(true);
    }
    expect(boosted.value[0]?.relPath).toBe("Acme_Overview.md");

    // A weak raw match below a strict raw cutoff must not survive via boost.
    await addDoc({
      relPath: "Weak_Only.md",
      title: "Acme",
      markdown: `# Acme\n\n${longFiller}`,
    });
    const strictUnboosted = await adapter.searchFts("Acme Overview", {
      limit: 10,
      anyTerm: true,
      minRelativeScore: 0.9,
      nameBoost: false,
    });
    const strictBoosted = await adapter.searchFts("Acme Overview", {
      limit: 10,
      anyTerm: true,
      minRelativeScore: 0.9,
      nameBoost: true,
    });
    expect(strictUnboosted.ok && strictBoosted.ok).toBe(true);
    if (strictUnboosted.ok && strictBoosted.ok) {
      expect(
        strictUnboosted.value.some((r) => r.relPath === "Weak_Only.md")
      ).toBe(false);
      expect(
        strictBoosted.value.some((r) => r.relPath === "Weak_Only.md")
      ).toBe(false);
    }
  });

  test("supports anyTerm, quoted phrases, and negation with nameBoost", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nActive architecture summary.\n\n${longFiller}`,
    });
    await addDoc({
      relPath: "Acme_Overview_Legacy.md",
      title: "Acme Overview Legacy",
      markdown: "# Acme Overview Legacy\n\nLegacy deprecated summary.",
    });
    await seedIssue372Noise(60);

    // Quoted phrase
    const phrase = await adapter.searchFts('"Acme Overview"', {
      limit: 4,
      nameBoost: true,
    });
    expect(phrase.ok).toBe(true);
    if (phrase.ok) {
      expect(phrase.value[0]?.relPath).toMatch(/^Acme_Overview/);
    }

    // Negation excludes legacy doc and does not include "legacy" in coverage terms
    const negated = await adapter.searchFts("Acme Overview -legacy", {
      limit: 4,
      nameBoost: true,
    });
    expect(negated.ok).toBe(true);
    if (negated.ok) {
      expect(negated.value[0]?.relPath).toBe("Acme_Overview.md");
      expect(
        negated.value.some((r) => r.relPath === "Acme_Overview_Legacy.md")
      ).toBe(false);
    }

    // anyTerm matches when an extra term is absent from the doc
    const anyRes = await adapter.searchFts("Acme Overview nonexistenttoken", {
      limit: 4,
      anyTerm: true,
      nameBoost: true,
    });
    expect(anyRes.ok).toBe(true);
    if (anyRes.ok) {
      expect(anyRes.value[0]?.relPath).toBe("Acme_Overview.md");
    }
  });

  test("applies collection, tag, and relPathPrefix eligibility filters to name candidates too", async () => {
    await addDoc({
      collection: "other",
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: "# Acme Overview\n\nIn other collection.",
      tags: ["internal"],
    });
    await addDoc({
      collection: "docs",
      relPath: "archive/Acme_Overview.md",
      title: "Acme Overview",
      markdown: "# Acme Overview\n\nArchived version.",
      tags: ["archived"],
    });
    await addDoc({
      collection: "docs",
      relPath: "active/Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nActive version.\n\n${longFiller}`,
      tags: ["current"],
    });
    await seedIssue372Noise(60);

    const byCollection = await adapter.searchFts("Acme Overview", {
      collection: "docs",
      limit: 4,
      nameBoost: true,
    });
    expect(byCollection.ok).toBe(true);
    if (byCollection.ok) {
      expect(byCollection.value.every((r) => r.collection === "docs")).toBe(
        true
      );
    }

    const byTag = await adapter.searchFts("Acme Overview", {
      collection: "docs",
      tagsAll: ["current"],
      limit: 4,
      nameBoost: true,
    });
    expect(byTag.ok).toBe(true);
    if (byTag.ok) {
      expect(byTag.value).toHaveLength(1);
      expect(byTag.value[0]?.relPath).toBe("active/Acme_Overview.md");
    }

    const byPrefix = await adapter.searchFts("Acme Overview", {
      collection: "docs",
      relPathPrefix: "active",
      limit: 4,
      nameBoost: true,
    });
    expect(byPrefix.ok).toBe(true);
    if (byPrefix.ok) {
      expect(byPrefix.value).toHaveLength(1);
      expect(byPrefix.value[0]?.relPath).toBe("active/Acme_Overview.md");
    }
  });

  test("hybrid search BM25 leg ranks named document first", async () => {
    await addDoc({
      relPath: "Acme_Overview.md",
      title: "Acme Overview",
      markdown: `# Acme Overview\n\nOrientation note.\n\n${longFiller}`,
    });
    await seedIssue372Noise(100);

    const hybrid = await searchHybrid(
      {
        store: adapter,
        config: {
          version: "1.0",
          ftsTokenizer: "unicode61",
          collections: [
            {
              name: "docs",
              path: join(testDir, "docs"),
              pattern: "**/*",
              include: [],
              exclude: [],
            },
          ],
          contexts: [],
        },
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "Acme Overview",
      { limit: 4, noExpand: true, noRerank: true, noGraph: true }
    );
    expect(hybrid.ok).toBe(true);
    if (!hybrid.ok) return;

    expect(hybrid.value.results[0]?.source.relPath).toBe("Acme_Overview.md");
  });

  test("memory recall stays unboosted", async () => {
    const memRoot = join(testDir, "memory");
    await Bun.write(join(memRoot, ".keep"), "");
    await adapter.syncCollections([
      {
        name: "memory",
        path: memRoot,
        pattern: "**/*",
        include: [],
        exclude: [],
        memoryManaged: true,
      },
    ]);

    const collections = [
      {
        name: "memory",
        path: memRoot,
        pattern: "**/*",
        include: [],
        exclude: [],
        memoryManaged: true,
      },
    ];
    const config = {
      version: "1.0" as const,
      ftsTokenizer: "unicode61" as const,
      collections,
      contexts: [],
    };
    const deps = {
      store: adapter,
      collections,
      config,
      lockPath: join(testDir, "memory.lock"),
    };

    await rememberFact(deps, {
      collection: "memory",
      scopes: ["project:acme"],
      text: "Acme deployment freeze begins every Friday at 16:00 UTC.",
      decision: "add",
      caller: "test",
      session: "s1",
    });
    await rememberFact(deps, {
      collection: "memory",
      scopes: ["project:acme"],
      text: "Acme release owner is Alice.",
      decision: "add",
      caller: "test",
      session: "s1",
    });

    // Spy on store.searchFts to assert memory recall never enables nameBoost
    const calls: Array<{ query: string; nameBoost: boolean | undefined }> = [];
    const origSearchFts = adapter.searchFts.bind(adapter);
    adapter.searchFts = async (q, opts) => {
      calls.push({ query: q, nameBoost: opts?.nameBoost });
      return origSearchFts(q, opts);
    };

    const recalled = await recallFacts(deps, {
      collection: "memory",
      scopes: ["project:acme"],
      query: "Acme deployment freeze",
      caller: "test",
      session: "s1",
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.nameBoost)).toBe(true);
    expect(recalled.facts.length).toBeGreaterThan(0);
    expect(recalled.facts[0]?.text).toContain("deployment freeze");
  });
});

describe("FTS name-match boost tokenizer safety", () => {
  const tokenizers: FtsTokenizer[] = [
    "unicode61",
    "porter",
    "trigram",
    "snowball english",
  ];

  for (const tokenizer of tokenizers) {
    test(`runs cleanly under ${tokenizer} tokenizer with ASCII and CJK`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "gno-nb-tok-"));
      const store = new SqliteAdapter();
      try {
        const opened = await store.open(join(dir, "tok.sqlite"), tokenizer);
        expect(opened.ok).toBe(true);
        await store.syncCollections([
          {
            name: "docs",
            path: dir,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ]);

        const docs = [
          {
            relPath: "Acme_Overview.md",
            title: "Acme Overview",
            markdown: "# Acme Overview\n\nShort summary of the platform.",
          },
          {
            relPath: "body-mentions.md",
            title: "Weekly Log",
            markdown:
              "Acme overview notes. ".repeat(15) + "More weekly updates.",
          },
          {
            relPath: "東京ガイド.md",
            title: "東京ガイド",
            markdown: "# 東京ガイド\n\n東京の観光案内と交通情報。",
          },
          {
            relPath: "diary.md",
            title: "旅行メモ",
            markdown:
              "東京ガイドについて何度も書かれたメモ。東京ガイド、東京ガイド、東京ガイド。",
          },
        ];

        for (const doc of docs) {
          const key = Buffer.from(doc.relPath).toString("hex");
          const mirrorHash = `m_${key}`;
          await store.upsertDocument({
            collection: "docs",
            relPath: doc.relPath,
            sourceHash: `s_${key}`,
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: doc.markdown.length,
            sourceMtime: "2026-01-01T00:00:00Z",
            mirrorHash,
            title: doc.title,
          });
          await store.upsertContent(mirrorHash, doc.markdown);
          await store.upsertChunks(mirrorHash, [
            { seq: 0, pos: 0, text: doc.markdown, startLine: 1, endLine: 1 },
          ]);
          await store.rebuildFtsForHash(mirrorHash);
        }

        const ascii = await store.searchFts("Acme Overview", {
          limit: 4,
          nameBoost: true,
        });
        expect(ascii.ok).toBe(true);
        if (ascii.ok) {
          expect(ascii.value.length).toBeGreaterThanOrEqual(1);
          expect(ascii.value[0]?.relPath).toBe("Acme_Overview.md");
        }

        const cjk = await store.searchFts("東京ガイド", {
          limit: 4,
          nameBoost: true,
        });
        expect(cjk.ok).toBe(true);
        if (cjk.ok && cjk.value.length > 0) {
          expect(cjk.value[0]?.relPath).toBe("東京ガイド.md");
        }
      } finally {
        await store.close();
        await safeRm(dir);
      }
    });
  }
});
