/**
 * Text renderings of session receipts and status, shared by every text
 * surface (CLI terminal output, MCP text content).
 *
 * @module src/sessions/format
 */

import type {
  SessionAutomationRunResult,
  SessionAutomationStatus,
  SessionImportReceipt,
  SessionsStatus,
} from "./types";

/** Plain-text import receipt shared by the CLI and MCP. */
export function formatImportReceiptText(receipt: SessionImportReceipt): string {
  const c = receipt.counts;
  const lines = [
    `Session import ${receipt.dryRun ? "(dry run, nothing written) " : ""}${receipt.status}`,
    `threads: ${c.imported} imported, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skippedPolicy} skipped by policy`,
    `units: ${c.incomplete} incomplete, ${c.failed} failed, ${c.unsupported} unsupported${receipt.deferredUnits > 0 ? `, ${receipt.deferredUnits} deferred by limit` : ""}`,
    `turns: ${receipt.turns.human} human, ${receipt.turns.assistant} assistant, ${receipt.turns.redactions} redactions, ${receipt.turns.injectedSkipped} injected skipped`,
    `lexical: ${receipt.lexical.status}${receipt.lexical.error ? ` (${receipt.lexical.error})` : ""}; embedding backlog: ${receipt.embedding.backlog ?? "n/a"}`,
  ];
  const notable = receipt.units.filter(
    (unit) =>
      unit.outcome !== "unchanged" &&
      unit.outcome !== "imported" &&
      unit.outcome !== "updated"
  );
  for (const unit of notable.slice(0, 20)) {
    lines.push(
      `- ${unit.sourceId} ${unit.locator}: ${unit.outcome}${unit.reason ? ` (${unit.reason})` : ""}`
    );
  }
  for (const warning of receipt.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/** Plain-text archive status shared by the CLI and MCP. */
export function formatStatusText(status: SessionsStatus): string {
  const lines = [`Session archive (index ${status.index})`];
  for (const collection of status.collections) {
    lines.push(
      `- collection ${collection.name}: ${collection.threads} threads`
    );
  }
  for (const source of status.sources) {
    lines.push(
      `- source ${source.id} (${source.harness} -> ${source.collection}): ${source.available ? "available" : "UNAVAILABLE"}; units ${source.units.complete} complete, ${source.units.incomplete} incomplete, ${source.units.failed} failed, ${source.units.pending} pending; last import ${source.lastImportAt ?? "never"}`
    );
    if (source.sourceUnavailable > 0) {
      lines.push(
        `  ${source.sourceUnavailable} archived units no longer have a source (archive retained${source.staleParser > 0 ? `, ${source.staleParser} from an older parser` : ""})`
      );
    }
  }
  lines.push(...formatAutomationLines(status.automation));
  for (const warning of status.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/**
 * When a failed run is retried. Only a running daemon retries, so without one
 * no time is promised, and a due time already passed is not shown as upcoming.
 */
export function retryWording(
  retryAt: string | null,
  daemonRunning: boolean,
  now: Date,
  at: (iso: string | null) => string
): string | null {
  if (!retryAt) return null;
  if (!daemonRunning) {
    return "retried when the daemon runs, or run the profile again yourself";
  }
  return Date.parse(retryAt) <= now.getTime()
    ? "retry due on the daemon's next tick"
    : `retried automatically at ${at(retryAt)}`;
}

/** UTC instant shown in the reader's timezone, e.g. `2026-09-24 15:04:05`. */
export function formatLocalTime(iso: string | null, timezone: string): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("sv-SE", { timeZone: timezone });
}

function daemonLine(
  automation: SessionAutomationStatus,
  at: (iso: string | null) => string
): string {
  if (automation.daemon.state === "running") {
    return `daemon running (heartbeat ${at(automation.daemon.heartbeatAt)})`;
  }
  if (automation.daemon.state === "stale") {
    return `daemon stale (last heartbeat ${at(automation.daemon.heartbeatAt)})`;
  }
  return "not running: no daemon";
}

function formatAutomationLines(automation: SessionAutomationStatus): string[] {
  if (automation.profiles.length === 0) {
    return ["Automation: off (manual imports only)"];
  }
  const at = (iso: string | null) => formatLocalTime(iso, automation.timezone);
  const lines = [
    `Automation (${daemonLine(automation, at)}; times in ${automation.timezone})`,
  ];
  for (const profile of automation.profiles) {
    const hookMissing =
      profile.hook?.enabled && profile.hook.installed === false
        ? " (entry missing)"
        : "";
    const hook = profile.hook
      ? `hook ${profile.hook.harness} ${profile.hook.enabled ? "on" : "off"}${hookMissing}`
      : "hook off";
    let schedule = "schedule off";
    if (profile.schedule?.enabled) {
      let next = "not running: no daemon";
      if (profile.schedule.nextDueAt) {
        next = `next ${at(profile.schedule.nextDueAt)}`;
      } else if (automation.daemon.state === "running") {
        next = "due time set on the daemon's next tick";
      }
      schedule = `schedule every ${profile.schedule.cadence}, ${next}`;
    }
    lines.push(
      `- profile ${profile.id}: ${profile.state}; sources ${profile.sources.join(", ")} -> ${profile.collections.join(", ") || "(none)"}; ${hook}; ${schedule}`
    );
    // A failure awaiting correction is shown by state and action, not as
    // queued work.
    if (profile.pending && profile.state !== "failed") {
      const wording = retryWording(
        profile.retryAt,
        automation.daemon.state === "running",
        new Date(),
        at
      );
      const retry = wording ? `; ${wording}` : "";
      lines.push(
        `  pending since ${at(profile.pending.since)} (${profile.pending.triggers.join(", ") || "continuation"})${retry}`
      );
    }
    if (profile.running) {
      lines.push(`  running since ${at(profile.running.startedAt)}`);
    }
    if (profile.lastRun) {
      const run = profile.lastRun;
      lines.push(
        `  last run ${at(run.finishedAt)}: ${run.outcome}${run.reason ? ` (${run.reason})` : ""}; threads ${run.threads.imported} imported, ${run.threads.updated} updated; units ${run.units.incomplete} incomplete, ${run.units.failed} failed, ${run.units.deferred} deferred`
      );
    }
    lines.push(`  last success ${at(profile.lastSuccessAt)}`);
    if (profile.recovery) lines.push(`  action: ${profile.recovery}`);
  }
  return lines;
}

/** What follows a run: remaining work, or the next step after a failure. */
const RETRYABLE_REASONS = new Set(["busy", "runtime_error", "interrupted"]);

export function runTail(result: SessionAutomationRunResult): string {
  if (result.outcome === "failed") {
    return RETRYABLE_REASONS.has(result.reason ?? "")
      ? "; a running daemon retries it, or run it again once the archive is free (see gno sessions status)"
      : "; see gno sessions status for the recovery action";
  }
  return result.pending ? "; more work is pending" : "";
}

/** Plain-text automation run result shared by the CLI and MCP. */
export function formatAutomationRunText(
  result: SessionAutomationRunResult
): string {
  if (!result.ran) {
    return `Automation profile ${result.profileId}: not started (${result.reason ?? "unknown"})${result.pending ? "; work stays pending" : ""}`;
  }
  const lines = [
    `Automation profile ${result.profileId}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}${runTail(result)}`,
  ];
  for (const receipt of result.receipts) {
    const deferred =
      receipt.deferredUnits > 0 ? `, ${receipt.deferredUnits} deferred` : "";
    lines.push(
      `- ${receipt.sourceIds.join(", ")}: ${receipt.status}; ${receipt.counts.imported} imported, ${receipt.counts.updated} updated, ${receipt.counts.unchanged} unchanged; ${receipt.counts.incomplete} incomplete, ${receipt.counts.failed} failed${deferred}`
    );
  }
  return lines.join("\n");
}
