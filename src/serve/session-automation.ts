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
import { tickAutomation } from "../sessions/automation";
import { AUTOMATION_TICK_MS } from "../sessions/automation-state";

const LEASE_HOLDER_COMMAND = "gno daemon (session automation)";

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
  #running: Promise<void> | null = null;
  #disposed = false;

  constructor(options: SessionAutomationSchedulerOptions) {
    this.#options = options;
    this.#startedAt = (options.now ?? (() => new Date()))();
  }

  /** Drain once at startup, then tick. */
  start(): void {
    this.#schedule(0);
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
