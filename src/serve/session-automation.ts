/**
 * Daemon-only session automation tick: heartbeat, coalesced schedule
 * admissions and a drain of pending profiles through the manual importer.
 *
 * Runs only in `gno daemon` on a session-archive config (never in `serve`).
 * One tick at a time over the daemon's background-work tracker; the owner
 * config is reread every tick, so enable/disable take effect without a
 * restart. Imports take the shared write lease; a busy lease backs off.
 */

import type { SessionAutomationRunResult } from "../sessions/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { acquireCliWriteLease } from "../core/write-lease";
import { heartbeatAutomation, tickAutomation } from "../sessions/automation";
import { AUTOMATION_TICK_MS } from "../sessions/automation-state";

const LEASE_HOLDER_COMMAND = "gno daemon (session automation)";

/**
 * The importer syncs the lexical index itself, so the resident watcher later
 * sees unchanged files and never queues embedding: do it here for the
 * collections a run synced, and mark the mutation (as the REST import does).
 */
export function notifyAutomationImport(
  result: SessionAutomationRunResult,
  sink: {
    markMutation: () => void;
    notifySyncComplete: (collections: string[]) => void;
  }
): void {
  const collections = [
    ...new Set(
      result.receipts.flatMap((receipt) => receipt.lexical.collections)
    ),
  ];
  if (collections.length === 0) return;
  sink.markMutation();
  sink.notifySyncComplete(collections);
}

export interface SessionAutomationSchedulerOptions {
  store: SqliteAdapter;
  configPath: string;
  indexName: string;
  dbPath: string;
  startBackgroundWork: (
    operation: (signal: AbortSignal) => Promise<void>
  ) => boolean;
  /** Called after every run; the daemon logs content-free counts. */
  onResult?: (result: SessionAutomationRunResult) => void;
  onError?: (error: unknown) => void;
  now?: () => Date;
  tickMs?: number;
}

export class SessionAutomationScheduler {
  readonly #options: SessionAutomationSchedulerOptions;
  readonly #startedAt: Date;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;
  #disposed = false;

  constructor(options: SessionAutomationSchedulerOptions) {
    this.#options = options;
    this.#startedAt = (options.now ?? (() => new Date()))();
  }

  /** Drain once at startup, then tick; heartbeat independently of ticks. */
  start(): void {
    this.#beat();
    this.#heartbeat = setInterval(
      () => this.#beat(),
      this.#options.tickMs ?? AUTOMATION_TICK_MS
    );
    this.#heartbeat.unref?.();
    this.#schedule(0);
  }

  /** A tick or import in progress must not let the heartbeat go stale. */
  #beat(): void {
    if (this.#disposed) return;
    const options = this.#options;
    heartbeatAutomation({
      configPath: options.configPath,
      indexName: options.indexName,
      now: options.now,
      daemonStartedAt: this.#startedAt,
    }).catch((error: unknown) => options.onError?.(error));
  }

  /** One tick; coalesces with a tick already in flight. */
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    const options = this.#options;
    const run = tickAutomation({
      configPath: options.configPath,
      indexName: options.indexName,
      store: options.store,
      now: options.now,
      daemonStartedAt: this.#startedAt,
      acquireLease: async () => {
        const lease = await acquireCliWriteLease({
          dbPath: options.dbPath,
          waitMs: 0,
          noWait: true,
          command: LEASE_HOLDER_COMMAND,
        });
        return lease.ok ? { ok: true, release: lease.release } : { ok: false };
      },
    })
      .then((results) => {
        for (const result of results) options.onResult?.(result);
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        this.#running = null;
        this.#schedule(options.tickMs ?? AUTOMATION_TICK_MS);
      });
    this.#running = run;
    return run;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#disposed || this.#running) return;
      const started = this.#options.startBackgroundWork(() => this.tick());
      if (!started) this.#schedule(this.#options.tickMs ?? AUTOMATION_TICK_MS);
    }, delayMs);
    this.#timer.unref?.();
  }
}
