export type RetrievalDepth = "fast" | "balanced" | "thorough";

export interface ResolveDepthPolicyInput {
  presetId?: string;
  fast?: boolean;
  thorough?: boolean;
  expand?: boolean;
  rerank?: boolean;
  candidateLimit?: number;
  hasStructuredModes?: boolean;
}

export interface ResolvedDepthPolicy {
  depth: RetrievalDepth;
  noExpand: boolean;
  noRerank: boolean;
  candidateLimit?: number;
  balancedExpansionEnabled: boolean;
}

export const DEFAULT_THOROUGH_CANDIDATE_LIMIT = 40;

function normalizePresetId(presetId?: string): string {
  return presetId?.trim().toLowerCase() || "slim";
}

export function balancedUsesExpansion(presetId?: string): boolean {
  const normalized = normalizePresetId(presetId);
  return normalized === "slim" || normalized === "slim-tuned";
}

export function resolveDepthPolicy(
  input: ResolveDepthPolicyInput
): ResolvedDepthPolicy {
  const balancedExpansionEnabled = balancedUsesExpansion(input.presetId);
  let depth: RetrievalDepth = "balanced";
  let noExpand = !balancedExpansionEnabled;
  let noRerank = false;
  let candidateLimit = input.candidateLimit;

  if (input.fast) {
    depth = "fast";
    noExpand = true;
    noRerank = true;
  } else if (input.thorough) {
    depth = "thorough";
    noExpand = false;
    noRerank = false;
    candidateLimit ??= DEFAULT_THOROUGH_CANDIDATE_LIMIT;
  } else {
    if (input.expand === true) {
      noExpand = false;
    }
    if (input.expand === false) {
      noExpand = true;
    }
    if (input.rerank === true) {
      noRerank = false;
    }
    if (input.rerank === false) {
      noRerank = true;
    }
  }

  // Structured query modes supply explicit expansions and should not trigger
  // an additional generated expansion step.
  if (input.hasStructuredModes) {
    noExpand = true;
  }

  return {
    depth,
    noExpand,
    noRerank,
    candidateLimit,
    balancedExpansionEnabled,
  };
}
