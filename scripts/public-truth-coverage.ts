const START_ANCHOR_REGEX = /<!--\s*public-truth:([a-z-]+)\s*-->/g;

export type PublicTruthClaimClass =
  | "cjk-lexical-benchmark"
  | "current-version"
  | "default-embed-model"
  | "general-embedding-benchmark"
  | "runtime"
  | "supported-platforms"
  | "manifest-evidence"
  | "anchor";

export interface PublicTruthDocument {
  path: string;
  content: string;
}

export interface PublicTruthMismatch {
  path: string;
  line: number;
  claimClass: PublicTruthClaimClass;
  message: string;
}

export interface RequiredPublicTruthAnchor {
  path: string;
  claimClass: PublicTruthClaimClass;
}

export const REQUIRED_PUBLIC_TRUTH_ANCHORS = [
  { path: "README.md", claimClass: "current-version" },
  { path: "README.md", claimClass: "default-embed-model" },
  { path: "README.md", claimClass: "runtime" },
  { path: "README.md", claimClass: "supported-platforms" },
  { path: "README.md", claimClass: "general-embedding-benchmark" },
  { path: "README.md", claimClass: "cjk-lexical-benchmark" },
  { path: "website/_config.yml", claimClass: "current-version" },
  { path: "docs/FINE-TUNED-MODELS.md", claimClass: "default-embed-model" },
  {
    path: "docs/HOW-SEARCH-WORKS.md",
    claimClass: "general-embedding-benchmark",
  },
  {
    path: "docs/HOW-SEARCH-WORKS.md",
    claimClass: "cjk-lexical-benchmark",
  },
  {
    path: "docs/CONFIGURATION.md",
    claimClass: "general-embedding-benchmark",
  },
  {
    path: "docs/CONFIGURATION.md",
    claimClass: "cjk-lexical-benchmark",
  },
  { path: "docs/CONFIGURATION.md", claimClass: "default-embed-model" },
  {
    path: "website/features/benchmarks.md",
    claimClass: "general-embedding-benchmark",
  },
] as const satisfies readonly RequiredPublicTruthAnchor[];

const compareMismatches = (
  left: PublicTruthMismatch,
  right: PublicTruthMismatch
): number =>
  left.path.localeCompare(right.path) ||
  left.line - right.line ||
  left.claimClass.localeCompare(right.claimClass) ||
  left.message.localeCompare(right.message);

const claimClasses = (content: string): Set<string> => {
  START_ANCHOR_REGEX.lastIndex = 0;
  return new Set(
    [...content.matchAll(START_ANCHOR_REGEX)].map((match) => match[1] ?? "")
  );
};

export const verifyRequiredAnchorCoverage = (
  documents: readonly PublicTruthDocument[],
  requirements: readonly RequiredPublicTruthAnchor[] = REQUIRED_PUBLIC_TRUTH_ANCHORS
): PublicTruthMismatch[] => {
  const documentsByPath = new Map(
    documents.map((document) => [document.path, document])
  );
  const mismatches: PublicTruthMismatch[] = [];
  for (const requirement of requirements) {
    const document = documentsByPath.get(requirement.path);
    if (!document) {
      mismatches.push({
        path: requirement.path,
        line: 1,
        claimClass: "anchor",
        message: `required public-truth surface is missing (${requirement.claimClass})`,
      });
      continue;
    }
    if (!claimClasses(document.content).has(requirement.claimClass)) {
      mismatches.push({
        path: requirement.path,
        line: 1,
        claimClass: "anchor",
        message: `required public-truth anchor is missing: ${requirement.claimClass}`,
      });
    }
  }
  return mismatches.sort(compareMismatches);
};
