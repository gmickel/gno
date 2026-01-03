#!/usr/bin/env bun
/**
 * Run evals and update scores.md with results.
 * Usage: bun scripts/update-eval-scores.ts [--include-llm]
 *
 * @module scripts/update-eval-scores
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const EVALS_DIR = join(import.meta.dir, "../evals");
const SCORES_FILE = join(EVALS_DIR, "scores.md");

// LLM-dependent evals (slow, optional)
const LLM_EVALS = new Set(["ask.eval.ts"]);

// Evals that have level/preset breakdowns
const LEVEL_EVALS: Record<string, { column: string; levels: string[] }> = {
  "thoroughness.eval.ts": {
    column: "Level",
    levels: ["fast", "balanced", "thorough"],
  },
  "ask.eval.ts": {
    column: "Preset",
    levels: ["slim", "balanced", "quality"],
  },
};

interface LevelScore {
  level: string;
  scores: number[];
  avg: number;
}

interface EvalResult {
  file: string;
  score: number;
  passed: boolean;
  evals: number;
  duration: string;
  levelBreakdown?: LevelScore[];
}

/**
 * Strip ANSI escape codes from string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex -- needed for ANSI stripping
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Parse table rows to extract level breakdown.
 * Returns map of level -> scores array.
 */
function parseLevelBreakdown(
  output: string,
  levelColumn: string,
  levels: string[]
): LevelScore[] {
  const scoresByLevel = new Map<string, number[]>();
  for (const level of levels) {
    scoresByLevel.set(level, []);
  }

  // Find table rows - they start with ║ and contain │
  const lines = output.split("\n");
  let inTable = false;
  let levelColIdx = -1;
  let scoreColIdx = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect header row
    if (trimmed.includes(levelColumn) && trimmed.includes("Score")) {
      inTable = true;
      // Parse column indices from header
      const cols = trimmed.split("│").map((c) => c.trim());
      levelColIdx = cols.findIndex((c) => c.includes(levelColumn));
      scoreColIdx = cols.findIndex((c) => c === "Score" || c === "Score ║");
      continue;
    }

    // Parse data rows
    if (inTable && trimmed.startsWith("║") && trimmed.includes("│")) {
      const cols = trimmed.split("│").map((c) => c.replace(/[║]/g, "").trim());

      if (levelColIdx >= 0 && scoreColIdx >= 0) {
        const level = cols[levelColIdx]?.trim();
        const scoreStr = cols[scoreColIdx]?.trim();

        if (level && levels.includes(level) && scoreStr) {
          const scoreMatch = scoreStr.match(/(\d+)%/);
          if (scoreMatch?.[1]) {
            const scores = scoresByLevel.get(level);
            if (scores) {
              scores.push(parseInt(scoreMatch[1], 10));
            }
          }
        }
      }
    }
  }

  // Compute averages
  const result: LevelScore[] = [];
  for (const level of levels) {
    const scores = scoresByLevel.get(level) ?? [];
    const avg =
      scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;
    result.push({ level, scores, avg });
  }

  return result;
}

/**
 * Run a single eval file and parse results.
 */
async function runEval(file: string): Promise<EvalResult | null> {
  const filePath = join(EVALS_DIR, file);

  console.log(`Running ${file}...`);

  const proc = Bun.spawn(["bun", "--bun", "evalite", filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const rawOutput = await new Response(proc.stdout).text();
  const rawStderr = await new Response(proc.stderr).text();
  await proc.exited;

  // Strip ANSI codes for parsing
  const output = stripAnsi(rawOutput);

  // Parse score from output (e.g., "Score  84%" or "Score  ✖  (13 failed)")
  const scoreMatch = output.match(/Score\s+(\d+)%/);
  const evalsMatch = output.match(/Evals\s+(\d+)/);
  const durationMatch = output.match(/Duration\s+(\d+)ms/);
  const passedMatch = output.match(/\(passed\)/);

  if (!scoreMatch) {
    console.error(`  Failed to parse score from ${file}`);
    if (rawStderr)
      console.error(`  stderr: ${stripAnsi(rawStderr).slice(0, 200)}`);
    return null;
  }

  const result: EvalResult = {
    file,
    score: parseInt(scoreMatch[1] ?? "0", 10),
    passed: !!passedMatch,
    evals: evalsMatch ? parseInt(evalsMatch[1] ?? "0", 10) : 0,
    duration: durationMatch ? `${durationMatch[1] ?? "?"}ms` : "?",
  };

  // Parse level breakdown if applicable
  const levelConfig = LEVEL_EVALS[file];
  if (levelConfig) {
    result.levelBreakdown = parseLevelBreakdown(
      output,
      levelConfig.column,
      levelConfig.levels
    );
  }

  const status = result.passed ? "PASS" : "FAIL";
  console.log(
    `  ${status}: ${result.score}% (${result.evals} evals, ${result.duration})`
  );

  if (result.levelBreakdown) {
    for (const lb of result.levelBreakdown) {
      console.log(`    ${lb.level}: ${lb.avg}%`);
    }
  }

  return result;
}

/**
 * Generate scores.md content.
 */
function generateScoresMarkdown(results: EvalResult[]): string {
  const timestamp = new Date().toISOString().split("T")[0];
  const totalEvals = results.reduce((sum, r) => sum + r.evals, 0);
  const avgScore = Math.round(
    results.reduce((sum, r) => sum + r.score, 0) / results.length
  );
  const allPassed = results.every((r) => r.passed);

  let md = `# Eval Scores

Last updated: ${timestamp}

## Summary

| Metric | Value |
|--------|-------|
| Total Evals | ${totalEvals} |
| Average Score | ${avgScore}% |
| Status | ${allPassed ? "All Passing" : "Some Failing"} |

## Results by File

| Eval | Score | Status | Cases | Duration |
|------|-------|--------|-------|----------|
`;

  for (const r of results.sort((a, b) => b.score - a.score)) {
    const status = r.passed ? "PASS" : "FAIL";
    md += `| ${r.file.replace(".eval.ts", "")} | ${r.score}% | ${status} | ${r.evals} | ${r.duration} |\n`;
  }

  // Add level breakdowns if any
  const withBreakdowns = results.filter((r) => r.levelBreakdown);
  if (withBreakdowns.length > 0) {
    md += `
## Breakdown by Level

`;
    for (const r of withBreakdowns) {
      const name = r.file.replace(".eval.ts", "");
      md += `### ${name}\n\n`;
      md += `| Level | Score |\n|-------|-------|\n`;
      for (const lb of r.levelBreakdown ?? []) {
        md += `| ${lb.level} | ${lb.avg}% |\n`;
      }
      md += "\n";
    }
  }

  md += `## Thresholds

- **Pass threshold**: 70%
- **LLM evals (ask)**: Skipped by default, run with \`--include-llm\`

## Running Evals

\`\`\`bash
# Run all evals and update scores.md
bun run evals

# Include LLM evals (slower)
bun run evals --include-llm

# Run individual eval
bun run eval evals/vsearch.eval.ts
\`\`\`
`;

  return md;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const skipLlm = !process.argv.includes("--include-llm");

console.log("Scanning evals...");
const files = (await readdir(EVALS_DIR)).filter((f) => f.endsWith(".eval.ts"));

const toRun = skipLlm ? files.filter((f) => !LLM_EVALS.has(f)) : files;

if (skipLlm && files.length > toRun.length) {
  console.log(`Skipping LLM evals: ${[...LLM_EVALS].join(", ")}`);
  console.log("(use --include-llm to include them)\n");
}

const results: EvalResult[] = [];

for (const file of toRun) {
  const result = await runEval(file);
  if (result) {
    results.push(result);
  }
}

console.log("\nWriting scores.md...");
await Bun.write(SCORES_FILE, generateScoresMarkdown(results));

console.log(`\nDone! Results written to evals/scores.md`);

// Exit with error if any failed
const failed = results.filter((r) => !r.passed);
if (failed.length > 0) {
  console.log(`\n${failed.length} eval(s) failed threshold.`);
  process.exit(1);
}
