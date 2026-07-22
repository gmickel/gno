#!/usr/bin/env bun

// node:path is used for portable path normalization; Bun has no path utilities.
import { basename, isAbsolute, join, relative } from "node:path";

import incumbentBenchmark from "../evals/fixtures/general-embedding-benchmark/2026-04-06-bge-m3-incumbent.json";
import qwenBenchmark from "../evals/fixtures/general-embedding-benchmark/2026-04-06-qwen3-embedding-0-6b.json";
import packageMetadata from "../package.json";
import { DEFAULT_MODEL_PRESETS } from "../src/config/types";
import {
  type PublicTruthClaimClass,
  type PublicTruthDocument,
  type PublicTruthMismatch,
  verifyRequiredAnchorCoverage,
} from "./public-truth-coverage";

export {
  REQUIRED_PUBLIC_TRUTH_ANCHORS,
  verifyRequiredAnchorCoverage,
} from "./public-truth-coverage";
export type {
  PublicTruthClaimClass,
  PublicTruthDocument,
  PublicTruthMismatch,
  RequiredPublicTruthAnchor,
} from "./public-truth-coverage";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const CURRENT_VERSION_REGEX = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;
const DATED_EVIDENCE_REGEX = /(?:^|\/)\d{4}-\d{2}-\d{2}-[^/]+\.md$/;
const START_ANCHOR_REGEX = /<!--\s*public-truth:([a-z-]+)\s*-->/g;
const END_ANCHOR_REGEX = /<!--\s*\/public-truth\s*-->/g;
const UNSUPPORTED_SUPERLATIVE_REGEX =
  /\b(best|strongest|superior|unbeatable|state[- ]of[- ]the[- ]art)\b/i;
const BENCHMARK_DECIMAL_REGEX = /\b(?:0|1)\.\d+\b/g;

const DEFAULT_SURFACE_GLOBS = [
  "README.md",
  "docs/**/*.md",
  "website/**/*.md",
  "website/**/*.html",
  "website/**/*.yml",
] as const;

const defaultEmbedUris = [
  ...new Set(DEFAULT_MODEL_PRESETS.map((preset) => preset.embed)),
];
const defaultEmbedUri = defaultEmbedUris[0] ?? "";
const defaultEmbedModel = defaultEmbedUri.split("/").at(-2) ?? defaultEmbedUri;

const benchmarkEntry = (
  dataPath: string,
  evidencePath: string,
  artifact: typeof qwenBenchmark
) => ({
  dataPath,
  evidencePath,
  generatedAt: artifact.generatedAt,
  label: artifact.label,
  modelUri: artifact.runtime.embedModel,
  queryCount: artifact.runtime.queryCount,
  corpus: {
    documentCount: artifact.corpus.docCount,
    languages: artifact.corpus.languages,
    topics: artifact.corpus.topics,
  },
  metrics: {
    vectorNdcgAt10: artifact.vector.metrics.ndcgAt10,
    hybridNdcgAt10: artifact.hybrid.metrics.ndcgAt10,
  },
});

export const PUBLIC_TRUTH = {
  release: {
    version: packageMetadata.version,
    bun: packageMetadata.engines.bun,
  },
  platforms: ["macOS", "Linux", "Windows"] as const,
  models: {
    defaultEmbed: {
      id: defaultEmbedModel,
      uri: defaultEmbedUri,
      presetCount: DEFAULT_MODEL_PRESETS.length,
    },
  },
  benchmarks: {
    generalEmbedding: {
      incumbent: benchmarkEntry(
        "evals/fixtures/general-embedding-benchmark/2026-04-06-bge-m3-incumbent.json",
        "evals/fixtures/general-embedding-benchmark/2026-04-06-bge-m3-incumbent.md",
        incumbentBenchmark
      ),
      qwen: benchmarkEntry(
        "evals/fixtures/general-embedding-benchmark/2026-04-06-qwen3-embedding-0-6b.json",
        "evals/fixtures/general-embedding-benchmark/2026-04-06-qwen3-embedding-0-6b.md",
        qwenBenchmark
      ),
    },
  },
} as const;

interface AnchoredClaim {
  claimClass: string;
  content: string;
  line: number;
}

const metricText = (value: number): string =>
  value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

const missingTokens = (content: string, tokens: readonly string[]): string[] =>
  tokens.filter((token) => !content.includes(token));

const lineAt = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

const parseAnchors = (
  document: PublicTruthDocument
): { claims: AnchoredClaim[]; mismatches: PublicTruthMismatch[] } => {
  const claims: AnchoredClaim[] = [];
  const mismatches: PublicTruthMismatch[] = [];
  START_ANCHOR_REGEX.lastIndex = 0;

  let start = START_ANCHOR_REGEX.exec(document.content);
  while (start) {
    const contentStart = START_ANCHOR_REGEX.lastIndex;
    END_ANCHOR_REGEX.lastIndex = contentStart;
    const end = END_ANCHOR_REGEX.exec(document.content);
    const claimClass = start[1] ?? "";
    const line = lineAt(document.content, start.index);

    if (!end) {
      mismatches.push({
        path: document.path,
        line,
        claimClass: "anchor",
        message: `unclosed public-truth anchor for ${claimClass}`,
      });
      break;
    }

    claims.push({
      claimClass,
      content: document.content.slice(contentStart, end.index),
      line,
    });
    START_ANCHOR_REGEX.lastIndex = END_ANCHOR_REGEX.lastIndex;
    start = START_ANCHOR_REGEX.exec(document.content);
  }

  return { claims, mismatches };
};

const mismatch = (
  document: PublicTruthDocument,
  claim: AnchoredClaim,
  claimClass: PublicTruthClaimClass,
  message: string
): PublicTruthMismatch => ({
  path: document.path,
  line: claim.line,
  claimClass,
  message,
});

const validateCurrentVersion = (
  document: PublicTruthDocument,
  claim: AnchoredClaim
): PublicTruthMismatch[] => {
  const versions = [...claim.content.matchAll(CURRENT_VERSION_REGEX)].map(
    (match) => match[1] ?? ""
  );
  const staleVersions = [
    ...new Set(
      versions.filter((version) => version !== PUBLIC_TRUTH.release.version)
    ),
  ];
  if (
    versions.includes(PUBLIC_TRUTH.release.version) &&
    staleVersions.length === 0
  ) {
    return [];
  }

  const found = versions.length > 0 ? versions.join(", ") : "none";
  return [
    mismatch(
      document,
      claim,
      "current-version",
      `expected current release ${PUBLIC_TRUTH.release.version}; found version(s): ${found}`
    ),
  ];
};

const validateDefaultModel = (
  document: PublicTruthDocument,
  claim: AnchoredClaim
): PublicTruthMismatch[] => {
  const { id, uri } = PUBLIC_TRUTH.models.defaultEmbed;
  const mismatches: PublicTruthMismatch[] = [];
  const hasCanonicalModel =
    claim.content.includes(id) || claim.content.includes(uri);
  if (!hasCanonicalModel) {
    mismatches.push(
      mismatch(
        document,
        claim,
        "default-embed-model",
        `expected default embed model ${id} (${uri})`
      )
    );
  }

  const incumbent = PUBLIC_TRUTH.benchmarks.generalEmbedding.incumbent;
  const staleTokens = [
    incumbent.label.replace(/\s+incumbent$/i, ""),
    incumbent.label,
    incumbent.modelUri,
    incumbent.modelUri.split("/").at(-2) ?? "",
    incumbent.modelUri.split("/").at(-1) ?? "",
  ].filter((token) => token.length > 0);
  const normalizedContent = claim.content.toLowerCase();
  const contradictory = [
    ...new Set(
      staleTokens.filter((token) =>
        normalizedContent.includes(token.toLowerCase())
      )
    ),
  ];
  if (hasCanonicalModel && contradictory.length > 0) {
    mismatches.push(
      mismatch(
        document,
        claim,
        "default-embed-model",
        `default model claim contains stale model assertion(s): ${contradictory.join(", ")}`
      )
    );
  }
  return mismatches;
};

const validateGeneralBenchmark = (
  document: PublicTruthDocument,
  claim: AnchoredClaim
): PublicTruthMismatch[] => {
  const benchmark = PUBLIC_TRUTH.benchmarks.generalEmbedding;
  const requiredTokens = [
    basename(benchmark.incumbent.evidencePath),
    benchmark.incumbent.label,
    metricText(benchmark.incumbent.metrics.vectorNdcgAt10),
    metricText(benchmark.incumbent.metrics.hybridNdcgAt10),
    basename(benchmark.qwen.evidencePath),
    benchmark.qwen.label,
    metricText(benchmark.qwen.metrics.vectorNdcgAt10),
    metricText(benchmark.qwen.metrics.hybridNdcgAt10),
  ];
  const missing = missingTokens(claim.content, requiredTokens);
  const mismatches: PublicTruthMismatch[] = [];

  if (missing.length > 0) {
    mismatches.push(
      mismatch(
        document,
        claim,
        "general-embedding-benchmark",
        `benchmark summary is stale or incomplete; missing canonical value(s): ${missing.join(", ")}`
      )
    );
  }
  if (UNSUPPORTED_SUPERLATIVE_REGEX.test(claim.content)) {
    mismatches.push(
      mismatch(
        document,
        claim,
        "general-embedding-benchmark",
        "benchmark summary uses an unsupported superlative; state the fixture and measured metric instead"
      )
    );
  }

  const canonicalMetrics = new Set([
    benchmark.incumbent.metrics.vectorNdcgAt10,
    benchmark.incumbent.metrics.hybridNdcgAt10,
    benchmark.qwen.metrics.vectorNdcgAt10,
    benchmark.qwen.metrics.hybridNdcgAt10,
  ]);
  const contradictoryMetrics = [
    ...new Set(
      [...claim.content.matchAll(BENCHMARK_DECIMAL_REGEX)]
        .map((match) => match[0])
        .filter((value) => !canonicalMetrics.has(Number(value)))
    ),
  ];
  if (contradictoryMetrics.length > 0) {
    mismatches.push(
      mismatch(
        document,
        claim,
        "general-embedding-benchmark",
        `benchmark summary contains non-canonical metric(s): ${contradictoryMetrics.join(", ")}`
      )
    );
  }

  return mismatches;
};

const validateClaim = (
  document: PublicTruthDocument,
  claim: AnchoredClaim
): PublicTruthMismatch[] => {
  switch (claim.claimClass) {
    case "current-version":
      return validateCurrentVersion(document, claim);
    case "default-embed-model":
      return validateDefaultModel(document, claim);
    case "general-embedding-benchmark":
      return validateGeneralBenchmark(document, claim);
    case "runtime":
      return claim.content.includes(PUBLIC_TRUTH.release.bun)
        ? []
        : [
            mismatch(
              document,
              claim,
              "runtime",
              `expected Bun runtime ${PUBLIC_TRUTH.release.bun}`
            ),
          ];
    case "supported-platforms": {
      const missing = missingTokens(claim.content, PUBLIC_TRUTH.platforms);
      return missing.length === 0
        ? []
        : [
            mismatch(
              document,
              claim,
              "supported-platforms",
              `missing supported platform(s): ${missing.join(", ")}`
            ),
          ];
    }
    default:
      return [
        mismatch(
          document,
          claim,
          "anchor",
          `unknown public-truth claim class: ${claim.claimClass}`
        ),
      ];
  }
};

const compareMismatches = (
  left: PublicTruthMismatch,
  right: PublicTruthMismatch
): number =>
  left.path.localeCompare(right.path) ||
  left.line - right.line ||
  left.claimClass.localeCompare(right.claimClass) ||
  left.message.localeCompare(right.message);

/**
 * Verify only explicitly anchored current claims. Unanchored changelog and
 * historical prose are intentionally ignored.
 */
export const verifyAnchoredPublicTruth = (
  documents: readonly PublicTruthDocument[]
): PublicTruthMismatch[] => {
  const mismatches: PublicTruthMismatch[] = [];
  for (const document of documents) {
    const parsed = parseAnchors(document);
    mismatches.push(...parsed.mismatches);
    for (const claim of parsed.claims) {
      mismatches.push(...validateClaim(document, claim));
    }
  }
  return mismatches.sort(compareMismatches);
};

const evidencePaths = (): string[] => {
  const benchmark = PUBLIC_TRUTH.benchmarks.generalEmbedding;
  return [
    benchmark.incumbent.dataPath,
    benchmark.incumbent.evidencePath,
    benchmark.qwen.dataPath,
    benchmark.qwen.evidencePath,
  ];
};

export const validatePublicTruthEvidence = async (
  rootDir: string = REPOSITORY_ROOT
): Promise<PublicTruthMismatch[]> => {
  const mismatches: PublicTruthMismatch[] = [];
  for (const path of evidencePaths()) {
    const isMarkdown = path.endsWith(".md");
    const immutable = !isMarkdown || DATED_EVIDENCE_REGEX.test(path);
    const exists = await Bun.file(join(rootDir, path)).exists();
    if (
      !(immutable && exists) ||
      path.includes("latest") ||
      path.includes("/tmp")
    ) {
      mismatches.push({
        path,
        line: 1,
        claimClass: "manifest-evidence",
        message: !exists
          ? "manifest evidence does not exist"
          : "manifest evidence must use an immutable dated artifact path",
      });
    }
  }
  if (defaultEmbedUris.length !== 1) {
    mismatches.push({
      path: "src/config/types.ts",
      line: 1,
      claimClass: "default-embed-model",
      message: `built-in presets disagree on the default embed model: ${defaultEmbedUris.join(", ")}`,
    });
  }
  return mismatches.sort(compareMismatches);
};

const collectDocuments = async (
  rootDir: string,
  paths?: readonly string[]
): Promise<PublicTruthDocument[]> => {
  const resolvedPaths = new Set<string>();
  if (paths && paths.length > 0) {
    for (const path of paths) {
      resolvedPaths.add(path);
    }
  } else {
    for (const pattern of DEFAULT_SURFACE_GLOBS) {
      for await (const path of new Bun.Glob(pattern).scan({
        cwd: rootDir,
        onlyFiles: true,
      })) {
        resolvedPaths.add(path);
      }
    }
  }

  const documents: PublicTruthDocument[] = [];
  for (const path of [...resolvedPaths].sort()) {
    const absolutePath = isAbsolute(path) ? path : join(rootDir, path);
    if (!(await Bun.file(absolutePath).exists())) {
      documents.push({ path, content: "" });
      continue;
    }
    documents.push({
      path: isAbsolute(path) ? relative(rootDir, path) : path,
      content: await Bun.file(absolutePath).text(),
    });
  }
  return documents;
};

export const verifyRepositoryPublicTruth = async (options?: {
  rootDir?: string;
  paths?: readonly string[];
}): Promise<PublicTruthMismatch[]> => {
  const rootDir = options?.rootDir ?? REPOSITORY_ROOT;
  const [evidence, documents] = await Promise.all([
    validatePublicTruthEvidence(rootDir),
    collectDocuments(rootDir, options?.paths),
  ]);
  const coverage = options?.paths
    ? []
    : verifyRequiredAnchorCoverage(documents);
  return [
    ...evidence,
    ...coverage,
    ...verifyAnchoredPublicTruth(documents),
  ].sort(compareMismatches);
};

export const formatPublicTruthMismatch = (value: PublicTruthMismatch): string =>
  `${value.path}:${value.line} [${value.claimClass}] ${value.message}`;

if (import.meta.main) {
  const mismatches = await verifyRepositoryPublicTruth({
    paths: process.argv.slice(2),
  });
  if (mismatches.length === 0) {
    console.log("Public truth verification passed.");
  } else {
    for (const value of mismatches) {
      console.error(formatPublicTruthMismatch(value));
    }
    process.exitCode = 1;
  }
}
