import type { AskResult } from "../../pipeline/types";
import type { AskCommandOptions, AskCommandResult } from "./ask";

interface FormatOptions {
  showSources?: boolean;
}

const exactSpan = (uri: string, startLine: number, endLine: number): string =>
  `${uri}:L${startLine}${startLine === endLine ? "" : `-L${endLine}`}`;

const replaceEvidenceMarkers = (value: string, data: AskResult): string => {
  const citationNumbers = new Map(
    (data.citations ?? []).flatMap((citation, index) =>
      citation.evidenceId ? [[citation.evidenceId, index + 1] as const] : []
    )
  );
  return value.replace(
    /\[evidence:([a-f0-9]{64})\]/g,
    (marker, evidenceId: string) => {
      const citationNumber = citationNumbers.get(evidenceId);
      return citationNumber === undefined ? marker : `[${citationNumber}]`;
    }
  );
};

const readableAnswer = (data: AskResult): string | undefined =>
  data.answer ? replaceEvidenceMarkers(data.answer, data) : undefined;

const capsuleEvidence = (data: AskResult) =>
  data.verification?.capsule.evidence ?? [];

const terminalVerification = (
  verification: NonNullable<AskResult["verification"]>
): string[] => {
  const { claims, capsule, semantic } = verification;
  const lines = [
    "Verification:",
    `  Answer status: ${claims.answerStatus}`,
    `  Coverage: ${claims.coverage.supportedClaims}/${claims.coverage.totalClaims} supported (${(claims.coverage.supportedRatio * 100).toFixed(0)}%)`,
    `  Semantic verifier: ${semantic.status} (${semantic.reason})`,
  ];
  if (claims.abstentionReason) {
    lines.push(`  Abstention: ${claims.abstentionReason}`);
  }
  for (const [index, claim] of claims.claims.entries()) {
    lines.push(`  Claim ${index + 1} [${claim.status}]: ${claim.text}`);
    for (const evidence of claim.evidence) {
      lines.push(
        `    Evidence: ${exactSpan(evidence.uri, evidence.startLine, evidence.endLine)}`
      );
    }
  }
  const degraded = Object.entries(capsule.retrieval.capabilityStates).filter(
    ([, state]) => state.requested && state.outcome !== "used"
  );
  for (const [name, state] of degraded) {
    const reasons =
      state.fallbackReasons.length > 0
        ? ` (${state.fallbackReasons.join(", ")})`
        : "";
    lines.push(`  Capability: ${name} ${state.outcome}${reasons}`);
  }
  for (const facet of capsule.coverage.unresolvedFacets) {
    lines.push(`  Gap: unresolved facet ${facet}`);
  }
  for (const gap of capsule.coverage.gaps) {
    lines.push(`  Gap: ${gap.facet} (${gap.code})`);
  }
  lines.push("");
  return lines;
};

const markdownVerification = (
  verification: NonNullable<AskResult["verification"]>
): string[] => {
  const { claims, capsule, semantic } = verification;
  const lines = [
    "## Verification",
    "",
    `- Answer status: **${claims.answerStatus}**`,
    `- Coverage: **${claims.coverage.supportedClaims}/${claims.coverage.totalClaims}** supported (${(claims.coverage.supportedRatio * 100).toFixed(0)}%)`,
    `- Semantic verifier: **${semantic.status}** (\`${semantic.reason}\`)`,
  ];
  if (claims.abstentionReason) {
    lines.push(`- Abstention: \`${claims.abstentionReason}\``);
  }
  lines.push("");
  for (const [index, claim] of claims.claims.entries()) {
    lines.push(`### Claim ${index + 1}: ${claim.status}`);
    lines.push("");
    lines.push(claim.text);
    lines.push("");
    for (const evidence of claim.evidence) {
      lines.push(
        `- Evidence: \`${exactSpan(evidence.uri, evidence.startLine, evidence.endLine)}\``
      );
    }
    if (claim.evidence.length === 0) {
      lines.push("- Evidence: none retained");
    }
    lines.push("");
  }
  const degraded = Object.entries(capsule.retrieval.capabilityStates).filter(
    ([, state]) => state.requested && state.outcome !== "used"
  );
  if (
    degraded.length > 0 ||
    capsule.coverage.unresolvedFacets.length > 0 ||
    capsule.coverage.gaps.length > 0
  ) {
    lines.push("### Gaps and degradation");
    lines.push("");
    for (const [name, state] of degraded) {
      const reasons =
        state.fallbackReasons.length > 0
          ? `: ${state.fallbackReasons.join(", ")}`
          : "";
      lines.push(`- Capability \`${name}\`: ${state.outcome}${reasons}`);
    }
    for (const facet of capsule.coverage.unresolvedFacets) {
      lines.push(`- Unresolved facet: ${facet}`);
    }
    for (const gap of capsule.coverage.gaps) {
      lines.push(`- Gap: ${gap.facet} (\`${gap.code}\`)`);
    }
    lines.push("");
  }
  return lines;
};

const formatTerminal = (data: AskResult, opts: FormatOptions = {}): string => {
  const lines: string[] = [];
  const hasAnswer = Boolean(data.answer);
  const answer = readableAnswer(data);
  if (answer) {
    lines.push("Answer:", answer, "");
  }
  if (data.verification) {
    lines.push(...terminalVerification(data.verification));
  }
  if (data.citations && data.citations.length > 0) {
    lines.push("Cited Sources:");
    for (const [index, citation] of data.citations.entries()) {
      const range =
        citation.startLine === undefined
          ? ""
          : `:L${citation.startLine}${citation.endLine === undefined || citation.endLine === citation.startLine ? "" : `-L${citation.endLine}`}`;
      lines.push(`  [${index + 1}] ${citation.uri}${range}`);
    }
    lines.push("");
  }
  const showAllSources = !hasAnswer || opts.showSources;
  const verifiedEvidence = capsuleEvidence(data);
  if (showAllSources && verifiedEvidence.length > 0) {
    lines.push("All Capsule Evidence:");
    for (const evidence of verifiedEvidence) {
      lines.push(
        `  [${evidence.docid}] ${exactSpan(evidence.uri, evidence.startLine, evidence.endLine)}`
      );
      if (evidence.title) lines.push(`    ${evidence.title}`);
    }
  } else if (showAllSources && data.results.length > 0) {
    lines.push(hasAnswer ? "All Retrieved Sources:" : "Sources:");
    for (const result of data.results) {
      lines.push(`  [${result.docid}] ${result.uri}`);
      if (result.title) lines.push(`    ${result.title}`);
    }
  } else if (hasAnswer && data.results.length > 0) {
    const citedCount = data.citations?.length ?? 0;
    if (data.results.length > citedCount) {
      lines.push(
        `(${data.results.length} sources retrieved, use --show-sources to list all)`
      );
    }
  }
  if (!data.answer && data.results.length === 0) {
    lines.push("No relevant sources found.");
  }
  return replaceEvidenceMarkers(lines.join("\n"), data);
};

const formatMarkdown = (data: AskResult, opts: FormatOptions = {}): string => {
  const lines: string[] = [`# Question: ${data.query}`, ""];
  const hasAnswer = Boolean(data.answer);
  const answer = readableAnswer(data);
  if (answer) {
    lines.push("## Answer", "", answer, "");
  }
  if (data.verification) {
    lines.push(...markdownVerification(data.verification));
  }
  if (data.citations && data.citations.length > 0) {
    lines.push("## Cited Sources", "");
    for (const [index, citation] of data.citations.entries()) {
      const range =
        citation.startLine === undefined
          ? ""
          : `:L${citation.startLine}${citation.endLine === undefined || citation.endLine === citation.startLine ? "" : `-L${citation.endLine}`}`;
      lines.push(`**[${index + 1}]** \`${citation.uri}${range}\``);
    }
    lines.push("");
  }
  if (!hasAnswer || opts.showSources) {
    const verifiedEvidence = capsuleEvidence(data);
    lines.push(
      verifiedEvidence.length > 0
        ? "## All Capsule Evidence"
        : hasAnswer
          ? "## All Retrieved Sources"
          : "## Sources",
      ""
    );
    if (verifiedEvidence.length > 0) {
      for (const [index, evidence] of verifiedEvidence.entries()) {
        lines.push(
          `${index + 1}. **${evidence.title || evidence.uri}**`,
          `   - URI: \`${exactSpan(evidence.uri, evidence.startLine, evidence.endLine)}\``
        );
      }
    } else {
      for (const [index, result] of data.results.entries()) {
        lines.push(
          `${index + 1}. **${result.title || result.source.relPath}**`
        );
        lines.push(`   - URI: \`${result.uri}\``);
        lines.push(`   - Score: ${result.score.toFixed(2)}`);
      }
      if (data.results.length === 0) lines.push("*No relevant sources found.*");
    }
  }
  lines.push(
    "",
    "---",
    `*Mode: ${data.mode} | Expanded: ${data.meta.expanded} | Reranked: ${data.meta.reranked}*`
  );
  return replaceEvidenceMarkers(lines.join("\n"), data);
};

export function formatAsk(
  result: AskCommandResult,
  options: AskCommandOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: "ASK_FAILED", message: result.error },
        })
      : `Error: ${result.error}`;
  }
  if (options.json) return JSON.stringify(result.data, null, 2);
  const formatOptions = { showSources: options.showSources };
  return options.md
    ? formatMarkdown(result.data, formatOptions)
    : formatTerminal(result.data, formatOptions);
}
