import { describe, expect, test } from "bun:test";

import packageMetadata from "../../package.json";
import { validateDoctorExit } from "../../scripts/docs-doctor-contract";
import {
  formatPublicTruthMismatch,
  PUBLIC_TRUTH,
  validatePublicTruthEvidence,
  verifyAnchoredPublicTruth,
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

    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]?.message).toContain("0.8594");
    expect(mismatches[1]?.message).toContain("unsupported superlative");
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
