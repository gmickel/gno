import { describe, expect, test } from "bun:test";

import packageMetadata from "../../package.json";
import { validateDoctorExit } from "../../scripts/docs-doctor-contract";
import {
  formatPublicTruthMismatch,
  PUBLIC_TRUTH,
  validatePublicTruthEvidence,
  verifyAnchoredPublicTruth,
  verifyRequiredAnchorCoverage,
} from "../../scripts/public-truth";

const anchored = (claimClass: string, content: string): string =>
  `<!-- public-truth:${claimClass} -->\n${content}\n<!-- /public-truth -->`;

describe("documentation doctor exit validation", () => {
  test("accepts exit 2 when a non-activation doctor check errors", () => {
    const result = {
      healthy: false,
      activation: { healthy: true },
      checks: [
        { name: "retrieval-activation", status: "ok" },
        { name: "sqlite-fts5", status: "error" },
      ],
    };

    expect(validateDoctorExit(2, result)).toBeNull();
    expect(validateDoctorExit(0, result)).toBe(
      "error checks expected exit 2, received 0"
    );
  });

  test("keeps warning-only doctor results exit-safe", () => {
    const result = {
      healthy: false,
      checks: [
        { name: "retrieval-activation", status: "ok" },
        { name: "connector-activation", status: "warn" },
      ],
    };

    expect(validateDoctorExit(0, result)).toBeNull();
    expect(validateDoctorExit(2, result)).toBe(
      "error checks expected exit 0, received 2"
    );
  });

  test("rejects doctor output without valid emitted checks", () => {
    expect(validateDoctorExit(0, { healthy: true })).toBe(
      "missing checks field"
    );
    expect(
      validateDoctorExit(0, {
        healthy: true,
        checks: [{ name: "config", status: "unknown" }],
      })
    ).toBe("invalid check status");
  });
});

describe("public truth verification", () => {
  test("derives canonical facts and immutable evidence", async () => {
    expect(PUBLIC_TRUTH.release.version).toBe(packageMetadata.version);
    expect(PUBLIC_TRUTH.models.defaultEmbed.id).toBe(
      "Qwen3-Embedding-0.6B-GGUF"
    );
    expect(await validatePublicTruthEvidence()).toEqual([]);
    expect(
      PUBLIC_TRUTH.benchmarks.generalEmbedding.qwen.evidencePath
    ).toContain("2026-04-06-qwen3-embedding-0-6b.md");
    expect(
      PUBLIC_TRUTH.benchmarks.generalEmbedding.qwen.evidencePath
    ).not.toContain("latest");
  });

  test("rejects a stale current release while ignoring historical prose", () => {
    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "fixture.md",
        content: [
          "## History",
          "Version 0.42.0 introduced the original command.",
          anchored("current-version", "Current release: v0.0.0"),
        ].join("\n\n"),
      },
    ]);

    expect(mismatches).toHaveLength(1);
    expect(formatPublicTruthMismatch(mismatches[0]!)).toBe(
      `fixture.md:5 [current-version] expected current release ${packageMetadata.version}; found version(s): 0.0.0`
    );
  });

  test("rejects a stale default model with an actionable claim class", () => {
    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "README.md",
        content: anchored("default-embed-model", "Default: bge-m3"),
      },
    ]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      path: "README.md",
      line: 1,
      claimClass: "default-embed-model",
    });
    expect(mismatches[0]?.message).toContain("Qwen3-Embedding-0.6B-GGUF");
  });

  test("rejects a stale default assertion even when the canonical model is present", () => {
    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "README.md",
        content: anchored(
          "default-embed-model",
          `Default: ${PUBLIC_TRUTH.models.defaultEmbed.id}. bge-m3 remains the default.`
        ),
      },
    ]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain("stale model assertion");
    expect(mismatches[0]?.message).toContain("bge-m3");
  });

  test("rejects stale benchmark metrics and unsupported superlatives", () => {
    const { incumbent, qwen } = PUBLIC_TRUTH.benchmarks.generalEmbedding;
    const summary = [
      `[${incumbent.label}](${incumbent.evidencePath}): vector nDCG@10 0.3503, hybrid nDCG@10 0.642`,
      `[${qwen.label}](${qwen.evidencePath}): vector nDCG@10 0.9999, hybrid nDCG@10 0.947`,
      "The strongest model everywhere.",
    ].join("\n");
    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "docs/benchmark.md",
        content: anchored("general-embedding-benchmark", summary),
      },
    ]);

    expect(mismatches).toHaveLength(3);
    expect(mismatches.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("0.8594"),
        expect.stringContaining("unsupported superlative"),
        expect.stringContaining("non-canonical metric(s): 0.9999"),
      ])
    );
  });

  test("rejects incomplete CJK lexical evidence and promotion caveats", () => {
    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "docs/benchmark.md",
        content: anchored(
          "cjk-lexical-benchmark",
          "The lexical benchmark is complete."
        ),
      },
    ]);

    expect(mismatches).toHaveLength(2);
    expect(mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claimClass: "cjk-lexical-benchmark",
          message: expect.stringContaining("2026-07-22.md"),
        }),
        expect.objectContaining({
          claimClass: "cjk-lexical-benchmark",
          message: expect.stringContaining(
            "does not bind canonical metrics to each language"
          ),
        }),
      ])
    );
  });

  test("rejects contradictory CJK metrics and unsupported superlatives", () => {
    const benchmark = PUBLIC_TRUTH.benchmarks.cjkLexical;
    const labels = ["Chinese", "Japanese", "Korean"];
    const canonical = [
      `[${benchmark.evidencePath}](${benchmark.evidencePath})`,
      `[${benchmark.gatesPath}](${benchmark.gatesPath})`,
      "Production BM25 lexical fallback is separate from semantic evidence.",
      "All positive qrels use relevance `3`.",
      ...Object.values(benchmark.languages).map(
        ({ baseline, minimumCandidate }, index) =>
          `${labels[index]}: baseline Recall@10 ${baseline.recallAt10}, nDCG@10 ${baseline.ndcgAt10}, zero-result ${baseline.zeroResultRate}; promotion Recall@10 ${minimumCandidate.recallAt10}, nDCG@10 ${minimumCandidate.ndcgAt10}, maximum zero-result ${minimumCandidate.zeroResultRate}`
      ),
      "The best result also scored 0.9999.",
    ].join("\n");

    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "docs/benchmark.md",
        content: anchored("cjk-lexical-benchmark", canonical),
      },
    ]);

    expect(mismatches).toHaveLength(2);
    expect(mismatches.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unsupported superlative"),
        expect.stringContaining("non-canonical metric(s): 0.9999"),
      ])
    );
  });

  test("rejects canonical CJK values assigned to the wrong language", () => {
    const benchmark = PUBLIC_TRUTH.benchmarks.cjkLexical;
    const { zh, ja, ko } = benchmark.languages;
    const tuple = (label: string, values: typeof zh): string =>
      `${label}: baseline Recall@10 ${values.baseline.recallAt10}, nDCG@10 ${values.baseline.ndcgAt10}, zero-result ${values.baseline.zeroResultRate}; promotion Recall@10 ${values.minimumCandidate.recallAt10}, nDCG@10 ${values.minimumCandidate.ndcgAt10}, maximum zero-result ${values.minimumCandidate.zeroResultRate}`;
    const swapped = [
      `[${benchmark.evidencePath}](${benchmark.evidencePath})`,
      `[${benchmark.gatesPath}](${benchmark.gatesPath})`,
      "Production BM25 lexical fallback is separate from semantic evidence.",
      "All positive qrels use relevance `3`.",
      tuple("Chinese", ja),
      tuple("Japanese", zh),
      tuple("Korean", ko),
    ].join("\n");

    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "docs/benchmark.md",
        content: anchored("cjk-lexical-benchmark", swapped),
      },
    ]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain(
      "does not bind canonical metrics to each language"
    );
    expect(mismatches[0]?.message).toContain(
      "Chinese: baseline Recall@10 0.2222"
    );
  });

  test("validates every CJK JSON Markdown and gate evidence path", async () => {
    const benchmark = PUBLIC_TRUTH.benchmarks.cjkLexical;
    expect(await validatePublicTruthEvidence()).toEqual([]);

    const missing = await validatePublicTruthEvidence(
      "/tmp/gno-public-truth-evidence-does-not-exist"
    );
    for (const path of [
      benchmark.dataPath,
      benchmark.evidencePath,
      benchmark.gatesDataPath,
      benchmark.gatesPath,
    ]) {
      expect(missing).toContainEqual(
        expect.objectContaining({
          path,
          claimClass: "manifest-evidence",
          message: "manifest evidence does not exist",
        })
      );
    }
  });

  test("rejects stale extra metrics when every canonical benchmark token remains", () => {
    const { incumbent, qwen } = PUBLIC_TRUTH.benchmarks.generalEmbedding;
    const summary = [
      `[${incumbent.label}](${incumbent.evidencePath}): vector nDCG@10 0.3503, hybrid nDCG@10 0.642`,
      `[${qwen.label}](${qwen.evidencePath}): vector nDCG@10 0.8594, hybrid nDCG@10 0.947`,
      "A stale table also reports vector nDCG@10 0.9999.",
    ].join("\n");

    const mismatches = verifyAnchoredPublicTruth([
      {
        path: "docs/benchmark.md",
        content: anchored("general-embedding-benchmark", summary),
      },
    ]);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.message).toContain("non-canonical metric(s): 0.9999");
  });

  test("rejects deletion of a required claim anchor", () => {
    const mismatches = verifyRequiredAnchorCoverage(
      [{ path: "README.md", content: "Current release is documented here." }],
      [{ path: "README.md", claimClass: "current-version" }]
    );

    expect(mismatches).toEqual([
      expect.objectContaining({
        path: "README.md",
        claimClass: "anchor",
        message: "required public-truth anchor is missing: current-version",
      }),
    ]);
  });

  test("rejects deletion of a required public claim surface", () => {
    const mismatches = verifyRequiredAnchorCoverage(
      [],
      [{ path: "README.md", claimClass: "current-version" }]
    );

    expect(mismatches).toEqual([
      expect.objectContaining({
        path: "README.md",
        claimClass: "anchor",
        message: "required public-truth surface is missing (current-version)",
      }),
    ]);
  });

  test("accepts canonical anchored claims alongside historical versions", () => {
    const { incumbent, qwen } = PUBLIC_TRUTH.benchmarks.generalEmbedding;
    const benchmark = [
      `[${incumbent.label}](${incumbent.evidencePath}): 0.3503 vector nDCG@10, 0.642 hybrid nDCG@10`,
      `[${qwen.label}](${qwen.evidencePath}): 0.8594 vector nDCG@10, 0.947 hybrid nDCG@10`,
    ].join("\n");
    const content = [
      "Version 0.42.0 remains part of the historical record.",
      anchored(
        "current-version",
        `Current release: ${PUBLIC_TRUTH.release.version}`
      ),
      anchored(
        "default-embed-model",
        `Default: ${PUBLIC_TRUTH.models.defaultEmbed.id}`
      ),
      anchored("general-embedding-benchmark", benchmark),
    ].join("\n\n");

    expect(verifyAnchoredPublicTruth([{ path: "README.md", content }])).toEqual(
      []
    );
  });
});
