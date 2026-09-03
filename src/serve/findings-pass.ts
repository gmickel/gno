/**
 * Daemon-only scheduled findings pass: read-only audit -> findings records.
 *
 * Report-only by construction: the audit never repairs, the writer only
 * touches records it owns under the findings collection root, and every
 * attempt persists its outcome so a starved or failing scheduler is visible
 * through `gno daemon --status` and `gno doctor` without debug logs.
 *
 * The audit runs without the shared write lease; only the record write takes
 * it, so a long audit never blocks capture or CLI writers.
 */

import type { Config } from "../config/types";
import type { AuditRunResult } from "../core/audit";
import type {
  FindingsRunCounts,
  FindingsRunOutcome,
  FindingsRunStateRecord,
  FindingsSchedule,
} from "../core/findings-run-state";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { AUDIT_CATEGORIES } from "../core/audit";
import { runWorkspaceAudit } from "../core/audit-workspace";
import { applyFindingsRecords } from "../core/findings-records";
import {
  createPendingFindingsRunState,
  EMPTY_FINDINGS_COUNTS,
  writeFindingsRunState,
} from "../core/findings-run-state";
import { acquireCliWriteLease } from "../core/write-lease";

/** Audit report cap; matches the audit schema ceiling. */
const FINDINGS_AUDIT_MAX_FINDINGS = 1000;
const LEASE_HOLDER_COMMAND = "gno daemon (findings pass)";
const CONTROL_CHARS = /\p{Cc}/gu;

/** Error text lands in a JSON state file and status lines: keep it printable and bounded. */
const boundErrorText = (text: string): string =>
  text.replace(CONTROL_CHARS, "").slice(0, 512);

export interface FindingsPassResult {
  outcome: FindingsRunOutcome;
  counts: FindingsRunCounts;
  durationMs: number;
  error: string | null;
  /** The state record persisted for this attempt. */
  record: FindingsRunStateRecord;
}

type FindingsPassAttempt = Omit<FindingsPassResult, "record">;

export interface FindingsPassDeps {
  store: SqliteAdapter;
  getConfig: () => Config;
  schedule: FindingsSchedule;
  dbPath: string;
  indexName: string;
  statePath: string;
  now?: () => Date;
  /** Overridable for tests; defaults to the shared `.mcp-write.lock` lease. */
  acquireLease?: (dbPath: string) => Promise<{
    ok: boolean;
    release?: () => Promise<void>;
    holder?: string | null;
  }>;
  runAudit?: typeof runWorkspaceAudit;
  /** Overridable for tests; defaults to the atomic state-file writer. */
  writeState?: typeof writeFindingsRunState;
}

const defaultAcquireLease: NonNullable<
  FindingsPassDeps["acquireLease"]
> = async (dbPath) => {
  const lease = await acquireCliWriteLease({
    dbPath,
    waitMs: 0,
    noWait: true,
    command: LEASE_HOLDER_COMMAND,
  });
  return lease.ok
    ? { ok: true, release: lease.release }
    : { ok: false, holder: lease.holder };
};

const settledRuleIds = (result: AuditRunResult): Set<string> => {
  if (!result.ok) return new Set();
  return new Set(
    result.report.rules
      .filter((rule) => rule.status === "pass" || rule.status === "fail")
      .map((rule) => rule.ruleId)
  );
};

/**
 * One pass. Never throws: every failure lands in the persisted state, and a
 * failure to persist lands as `failed` in the returned record instead.
 */
export async function runFindingsPass(
  deps: FindingsPassDeps,
  previous: FindingsRunStateRecord,
  signal?: AbortSignal
): Promise<FindingsPassResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const persist = async (
    result: FindingsPassAttempt
  ): Promise<FindingsPassResult> => {
    const finishedAt = now();
    const record: FindingsRunStateRecord = {
      ...previous,
      collection: deps.schedule.collection.name,
      cadence: deps.schedule.cadence,
      lastOutcome: result.outcome,
      lastRunAt: startedAt.toISOString(),
      lastSuccessAt:
        result.outcome === "success"
          ? finishedAt.toISOString()
          : previous.lastSuccessAt,
      nextDueAt: new Date(
        finishedAt.getTime() + deps.schedule.cadenceMs
      ).toISOString(),
      durationMs: result.durationMs,
      counts: result.outcome === "success" ? result.counts : previous.counts,
      error: result.error,
    };
    try {
      await (deps.writeState ?? writeFindingsRunState)(deps.statePath, record);
    } catch (error) {
      // An unwritable state file must not kill the daemon loop, but it must
      // not vanish either: the in-memory record (next pass's `previous`, the
      // daemon log via onResult) carries the failure until a write lands.
      const message = error instanceof Error ? error.message : String(error);
      const failed: FindingsRunStateRecord = {
        ...record,
        lastOutcome: "failed",
        error: boundErrorText(
          `state write failed: ${message}${record.error ? ` (after: ${record.error})` : ""}`
        ),
      };
      return {
        outcome: "failed",
        counts: failed.counts ?? result.counts,
        durationMs: result.durationMs,
        error: failed.error,
        record: failed,
      };
    }
    return { ...result, record };
  };
  const fail = (error: string): Promise<FindingsPassResult> =>
    persist({
      outcome: "failed",
      counts: previous.counts ?? EMPTY_FINDINGS_COUNTS,
      durationMs: now().getTime() - startedAt.getTime(),
      error: boundErrorText(error),
    });

  // The audit is read-only: run it without the write lease so MCP/REST
  // capture and CLI writers are never blocked behind a long audit. Only the
  // findings-record write below needs the lease.
  let audit: AuditRunResult;
  let allowResolve: boolean;
  try {
    const config = deps.getConfig();
    const findingsCollection = deps.schedule.collection.name;
    const audited = config.collections
      .map((collection) => collection.name)
      .filter((name) => name !== findingsCollection);
    if (audited.length === 0) {
      return persist({
        outcome: "success",
        counts: { ...EMPTY_FINDINGS_COUNTS },
        durationMs: now().getTime() - startedAt.getTime(),
        error: null,
      });
    }
    audit = await (deps.runAudit ?? runWorkspaceAudit)({
      store: deps.store,
      config,
      collections: config.collections,
      indexName: deps.indexName,
      categories: [...AUDIT_CATEGORIES],
      collectionFilters: audited,
      maxFindings: FINDINGS_AUDIT_MAX_FINDINGS,
      signal,
      now: startedAt,
    });
    if (!audit.ok) return fail(`audit failed: ${audit.error}`);
    if (audit.report.status === "failed") {
      return fail("audit reported status failed");
    }
    allowResolve =
      audit.report.status === "complete" &&
      !audit.report.counts.findings.truncated;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  // Write phase: take the shared lease only for as long as the records are
  // being applied. A busy lease at this point still lands as skipped_lease.
  const lease = await (deps.acquireLease ?? defaultAcquireLease)(deps.dbPath);
  if (!lease.ok) {
    return persist({
      outcome: "skipped_lease",
      counts: previous.counts ?? EMPTY_FINDINGS_COUNTS,
      durationMs: now().getTime() - startedAt.getTime(),
      error: lease.holder
        ? boundErrorText(`lease held by ${lease.holder}`)
        : "lease held",
    });
  }
  try {
    const applied = await applyFindingsRecords({
      root: deps.schedule.collection.path,
      findings: audit.report.findings,
      settledRuleIds: settledRuleIds(audit),
      allowResolve,
      now: startedAt,
    });
    return persist({
      outcome: "success",
      counts: {
        findings: audit.report.counts.findings.total,
        written: applied.written,
        reopened: applied.reopened,
        resolved: applied.resolved,
        deleted: applied.deleted,
        open: applied.open,
      },
      durationMs: now().getTime() - startedAt.getTime(),
      error: null,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    await lease.release?.().catch(() => undefined);
  }
}

export interface FindingsSchedulerOptions {
  deps: FindingsPassDeps;
  startBackgroundWork: (
    operation: (signal: AbortSignal) => Promise<void>
  ) => boolean;
  /** Called after every attempt; the daemon logs failures only. */
  onResult?: (result: FindingsPassResult) => void;
}

/**
 * Fixed-cadence timer over the daemon's background-work tracker. One pass at
 * a time; a pass still running when the next tick fires is simply skipped
 * (the next tick is armed after the pass completes), so cadence is a floor.
 */
export class FindingsScheduler {
  readonly #options: FindingsSchedulerOptions;
  #state: FindingsRunStateRecord;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<FindingsPassResult> | null = null;
  #disposed = false;

  constructor(options: FindingsSchedulerOptions) {
    this.#options = options;
    this.#state = createPendingFindingsRunState(
      options.deps.schedule,
      (options.deps.now ?? (() => new Date()))()
    );
  }

  get state(): FindingsRunStateRecord {
    return this.#state;
  }

  /** Persist the pending state and arm the first tick. */
  async start(): Promise<void> {
    if (this.#disposed) return;
    const { deps } = this.#options;
    try {
      await (deps.writeState ?? writeFindingsRunState)(
        deps.statePath,
        this.#state
      );
    } catch (error) {
      // An unwritable state file must not stop the loop: keep the pending
      // record in memory with the write error attached and still arm the
      // first tick; the next successful pass write carries a fresh record.
      const message = error instanceof Error ? error.message : String(error);
      this.#state = {
        ...this.#state,
        error: `state write failed: ${message}`,
      };
    }
    this.#arm();
  }

  /** Run a pass now (tests, live verification). Coalesces with an in-flight pass. */
  triggerNow(signal?: AbortSignal): Promise<FindingsPassResult> {
    if (this.#running) return this.#running;
    const run = runFindingsPass(this.#options.deps, this.#state, signal)
      .then((result) => {
        this.#state = result.record;
        this.#options.onResult?.(result);
        return result;
      })
      .finally(() => {
        this.#running = null;
        this.#arm();
      });
    this.#running = run;
    return run;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        if (this.#disposed || this.#running) return;
        const started = this.#options.startBackgroundWork(async (signal) => {
          await this.triggerNow(signal);
        });
        if (!started) this.#arm();
      },
      this.#options.deps.schedule.cadenceMs
    );
    this.#timer.unref?.();
  }
}
