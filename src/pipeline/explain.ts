/**
 * Explainability formatter for search pipeline.
 * Outputs pipeline details to stderr.
 *
 * @module src/pipeline/explain
 */

import type {
  ExpansionResult,
  ExplainLine,
  ExplainResult,
  QueryModeSummary,
  RerankedCandidate,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format explain lines for stderr output.
 */
export function formatExplain(lines: ExplainLine[]): string {
  return lines.map((l) => `[explain] ${l.stage}: ${l.message}`).join("\n");
}

/**
 * Format result explain for --explain output.
 */
export function formatResultExplain(results: ExplainResult[]): string {
  const lines: string[] = [];
  for (const r of results.slice(0, 10)) {
    let msg = `score=${r.score.toFixed(2)}`;
    if (
      r.fusionScore !== undefined ||
      r.bm25Score !== undefined ||
      r.vecScore !== undefined ||
      r.rerankScore !== undefined
    ) {
      msg += " (";
      if (r.fusionScore !== undefined) {
        msg += `fusion=${r.fusionScore.toFixed(3)}`;
      }
      if (r.bm25Score !== undefined) {
        if (msg.at(-1) !== "(") {
          msg += ", ";
        }
        msg += `bm25=${r.bm25Score.toFixed(2)}`;
      }
      if (r.vecScore !== undefined) {
        if (msg.at(-1) !== "(") {
          msg += ", ";
        }
        msg += `vec=${r.vecScore.toFixed(2)}`;
      }
      if (r.rerankScore !== undefined) {
        if (msg.at(-1) !== "(") {
          msg += ", ";
        }
        msg += `rerank=${r.rerankScore.toFixed(2)}`;
      }
      msg += ")";
    }
    lines.push(`[explain] result ${r.rank}: ${r.docid} ${msg}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Explain Line Builders
// ─────────────────────────────────────────────────────────────────────────────

export type ExpansionStatus =
  | "disabled" // User chose --no-expand
  | "skipped_strong" // Strong BM25 signal detected
  | "attempted" // Expansion was attempted (may have succeeded or timed out)
  | "provided"; // Structured query modes were provided

export function explainExpansion(
  status: ExpansionStatus,
  result: ExpansionResult | null
): ExplainLine {
  if (status === "disabled") {
    return { stage: "expansion", message: "disabled" };
  }
  if (status === "skipped_strong") {
    return { stage: "expansion", message: "skipped (strong BM25)" };
  }
  if (status === "provided") {
    if (!result) {
      return { stage: "expansion", message: "provided (empty)" };
    }
    const lex = result.lexicalQueries.length;
    const sem = result.vectorQueries.length;
    const hyde = result.hyde ? ", 1 hyde" : "";
    return {
      stage: "expansion",
      message: `provided (${lex} term, ${sem} intent${hyde})`,
    };
  }
  if (!result) {
    return { stage: "expansion", message: "skipped (timeout)" };
  }
  const lex = result.lexicalQueries.length;
  const sem = result.vectorQueries.length;
  const hyde = result.hyde ? ", 1 HyDE" : "";
  return {
    stage: "expansion",
    message: `enabled (${lex} lexical, ${sem} semantic variants${hyde})`,
  };
}

export function explainQueryModes(summary: QueryModeSummary): ExplainLine {
  const hyde = summary.hyde ? "yes" : "no";
  return {
    stage: "query_modes",
    message: `term=${summary.term}, intent=${summary.intent}, hyde=${hyde}`,
  };
}

export function explainBm25(count: number): ExplainLine {
  return { stage: "bm25", message: `${count} candidates` };
}

export function explainVector(count: number, available: boolean): ExplainLine {
  if (!available) {
    return { stage: "vector", message: "unavailable (sqlite-vec not loaded)" };
  }
  return { stage: "vector", message: `${count} candidates` };
}

export function explainFusion(k: number, uniqueCount: number): ExplainLine {
  return {
    stage: "fusion",
    message: `RRF k=${k}, ${uniqueCount} unique candidates`,
  };
}

export function explainRerank(enabled: boolean, count: number): ExplainLine {
  if (!enabled) {
    return { stage: "rerank", message: "disabled" };
  }
  return { stage: "rerank", message: `top ${count} reranked` };
}

interface ExplainCountersInput {
  expansionCacheHits: number;
  expansionCacheLookups: number;
  rerankCacheHits: number;
  rerankCacheLookups: number;
  fallbackEvents: string[];
}

export function explainCounters(counters: ExplainCountersInput): ExplainLine {
  const events = [...new Set(counters.fallbackEvents)];
  const fallbackSummary = events.length > 0 ? events.join("|") : "none";
  return {
    stage: "counters",
    message: `expansionCache=${counters.expansionCacheHits}/${counters.expansionCacheLookups}, rerankCache=${counters.rerankCacheHits}/${counters.rerankCacheLookups}, fallbacks=${fallbackSummary}`,
  };
}

interface StageTimingsInput {
  langMs: number;
  expansionMs: number;
  bm25Ms: number;
  vectorMs: number;
  fusionMs: number;
  rerankMs: number;
  assemblyMs: number;
  totalMs: number;
}

export function explainTimings(timings: StageTimingsInput): ExplainLine {
  const fmt = (value: number): string => `${value.toFixed(2)}ms`;
  return {
    stage: "timing",
    message: [
      `lang=${fmt(timings.langMs)}`,
      `expansion=${fmt(timings.expansionMs)}`,
      `bm25=${fmt(timings.bm25Ms)}`,
      `vector=${fmt(timings.vectorMs)}`,
      `fusion=${fmt(timings.fusionMs)}`,
      `rerank=${fmt(timings.rerankMs)}`,
      `assembly=${fmt(timings.assemblyMs)}`,
      `total=${fmt(timings.totalMs)}`,
    ].join(", "),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build ExplainResult from RerankedCandidate
// ─────────────────────────────────────────────────────────────────────────────

export function buildExplainResults(
  candidates: RerankedCandidate[],
  docidMap: Map<string, string>
): ExplainResult[] {
  return candidates.slice(0, 20).map((c, i) => {
    const key = `${c.mirrorHash}:${c.seq}`;
    return {
      rank: i + 1,
      docid: docidMap.get(key) ?? "#unknown",
      score: c.blendedScore,
      fusionScore: c.fusionScore,
      bm25Score: c.bm25Rank !== null ? 1 / (60 + c.bm25Rank) : undefined,
      vecScore: c.vecRank !== null ? 1 / (60 + c.vecRank) : undefined,
      rerankScore: c.rerankScore ?? undefined,
    };
  });
}
