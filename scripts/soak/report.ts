/**
 * Soak report: `report.json` (machine-readable, also the replay input) and
 * `report.md` (for people) in the run's report directory.
 *
 * @module scripts/soak/report
 */

// node:fs/promises — mkdir is a directory-structure op
import { mkdir } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Observation, Verdicts } from "./invariants";
import type { Monitor } from "./monitor";

import { THRESHOLDS } from "./config";

export interface RunOptions {
  tier: "smoke" | "torture" | "soak";
  seed: number;
  durationMs: number;
  docs: number;
  classes?: string[];
  idleQuietMs: number;
  contain: boolean;
}

export interface Report {
  runId: string;
  options: RunOptions;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gno: { version: string; commit: string };
  platform: { os: string; arch: string; bun: string };
  thresholds: typeof THRESHOLDS;
  summary: ReturnType<Verdicts["summary"]>;
  failures: Observation[];
  observations: Observation[];
  timeline: Monitor["timeline"];
  notes: string[];
  staleFromEarlierRuns: string[];
  sandboxRoot: string;
}

function table(rows: string[][]): string {
  const [head, ...rest] = rows;
  if (!head) return "";
  const line = (cells: string[]) =>
    `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rest.map(line)].join(
    "\n"
  );
}

export function renderMarkdown(report: Report): string {
  const overall = report.summary.some((s) => s.status === "fail")
    ? "FAIL"
    : "PASS";
  const lines = [
    `# GNO soak report: ${report.options.tier} (${overall})`,
    "",
    `Run \`${report.runId}\`, seed ${report.options.seed}, gno ${report.gno.version} (${report.gno.commit}), ${report.platform.os}/${report.platform.arch}, bun ${report.platform.bun}.`,
    `Started ${report.startedAt}, took ${(report.durationMs / 60_000).toFixed(1)} min. Replay: \`bun run soak --replay ${join("<dir>", "report.json")}\`.`,
    "",
    "## Invariants",
    "",
    table([
      ["ID", "Invariant", "Result", "Checks", "Failures"],
      ...report.summary.map((s) => [
        s.id,
        s.name,
        s.status.toUpperCase(),
        String(s.checks),
        String(s.failures),
      ]),
    ]),
    "",
  ];
  if (report.failures.length > 0) {
    lines.push("## Failures", "");
    for (const failure of report.failures) {
      lines.push(
        `- **${failure.invariant}** \`${failure.scenario}\`: ${failure.detail}`
      );
    }
    lines.push("");
  }
  if (report.staleFromEarlierRuns.length > 0) {
    lines.push(
      "## Leftovers from earlier runs",
      "",
      ...report.staleFromEarlierRuns.map((s) => `- ${s}`),
      ""
    );
  }
  if (report.notes.length > 0)
    lines.push("## Notes", "", ...report.notes.map((n) => `- ${n}`), "");
  lines.push(
    "## All observations",
    "",
    table([
      ["Invariant", "Scenario", "Result", "Detail"],
      ...report.observations.map((o) => [
        o.invariant,
        o.scenario,
        o.skipped ? "skip" : o.ok ? "pass" : "FAIL",
        o.detail,
      ]),
    ]),
    ""
  );
  return lines.join("\n");
}

export async function writeReport(
  dir: string,
  report: Report
): Promise<{ json: string; md: string }> {
  await mkdir(dir, { recursive: true });
  const json = join(dir, "report.json");
  const md = join(dir, "report.md");
  await Bun.write(json, JSON.stringify(report, null, 2));
  await Bun.write(md, renderMarkdown(report));
  return { json, md };
}
