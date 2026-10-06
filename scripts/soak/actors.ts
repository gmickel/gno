/**
 * Load generators for the soak harness. Each actor runs until stopped and
 * records what it did on the monitor timeline.
 *
 * @module scripts/soak/actors
 */

// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Corpus } from "./corpus";
import type { Resident } from "./gno";
import type { Monitor } from "./monitor";
import type { Rng } from "./rng";
import type { Sandbox } from "./sandbox";

import { postJson } from "./gno";
import { gnoCmd, runGno, spawnTagged } from "./sandbox";

export interface Actor {
  name: string;
  stop(): Promise<void>;
  /** Counts of what the actor did, for the report. */
  stats(): Record<string, number>;
}

function loop(
  name: string,
  intervalMs: () => number,
  step: () => Promise<void>,
  counts: Record<string, number>
): Actor {
  let stopped = false;
  const running = (async () => {
    while (!stopped) {
      try {
        await step();
      } catch (error) {
        counts.errors = (counts.errors ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        const key = `error: ${message.slice(0, 80)}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      await Bun.sleep(intervalMs());
    }
  })();
  return {
    name,
    stats: () => ({ ...counts }),
    async stop() {
      stopped = true;
      await running;
    },
  };
}

// ── File-system churn ────────────────────────────────────────────────────────

export interface ChurnOptions {
  /** Mean delay between operations. */
  meanDelayMs: number;
  /** Probability per step of a burst of many writes at once. */
  burstChance?: number;
  burstSize?: number;
}

export function fsChurn(
  corpus: Corpus,
  rng: Rng,
  monitor: Monitor,
  options: ChurnOptions
): Actor {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const step = async (): Promise<void> => {
    if (rng.chance(options.burstChance ?? 0)) {
      const size = options.burstSize ?? 200;
      for (let i = 0; i < size; i += 1)
        await corpus.writeNote(corpus.newNoteName());
      monitor.event("churn", `burst ${size} new notes`);
      bump("burst");
      return;
    }
    const roll = rng.next();
    const existing = corpus.randomNote();
    if (roll < 0.35 && existing) {
      await corpus.writeNote(existing);
      bump("edit");
    } else if (roll < 0.55 && existing) {
      await corpus.atomicSave(existing);
      bump("atomicSave");
    } else if (roll < 0.75) {
      await corpus.writeNote(corpus.newNoteName());
      bump("create");
    } else if (roll < 0.85 && existing) {
      await corpus.deleteNote(existing);
      bump("delete");
    } else if (roll < 0.95 && existing) {
      await corpus.renameNote(existing, corpus.newNoteName());
      bump("rename");
    } else if (roll < 0.98) {
      const from = `d${rng.int(0, 29)}`;
      const to = `moved-${rng.int(0, 1_000_000)}`;
      await corpus.moveDir(from, to).catch(() => undefined);
      bump("moveDir");
    } else {
      const dir = `d${rng.int(0, 29)}`;
      await corpus.deleteDir(dir);
      bump("deleteDir");
    }
  };
  return loop(
    "fs-churn",
    () => rng.int(0, options.meanDelayMs * 2),
    step,
    counts
  );
}

// ── REST readers ─────────────────────────────────────────────────────────────

const QUERIES = [
  "alpha beta",
  "resident scheduler",
  "battery lease",
  "vector index",
  "capsule evidence",
  "watcher daemon",
];

export function restReaders(resident: Resident, rng: Rng, qps: number): Actor {
  const counts: Record<string, number> = {};
  const step = async (): Promise<void> => {
    const query = rng.pick(QUERIES);
    const useQuery = rng.chance(0.2);
    const result = await postJson(
      resident,
      useQuery ? "/api/query" : "/api/search",
      { query, limit: 5 },
      15_000
    );
    const key = result.status === 200 ? "ok" : `status${result.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  return loop(
    "rest-readers",
    () => Math.max(10, Math.round(1000 / qps)),
    step,
    counts
  );
}

// ── MCP stdio clients ────────────────────────────────────────────────────────

export interface McpSession {
  pid: number;
  call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<boolean>;
  close(): Promise<void>;
  kill(): Promise<void>;
  exited: Promise<number>;
}

export async function openMcp(
  sandbox: Sandbox,
  args: string[] = []
): Promise<McpSession> {
  const stderrLog = join(
    sandbox.logDir,
    `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  if (sandbox.closed)
    throw new Error("sandbox is closed: no new processes after teardown");
  const proc = Bun.spawn({
    cmd: gnoCmd("mcp", ...args),
    env: sandbox.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: Bun.file(stderrLog),
  });
  sandbox.owned.add(proc.pid);
  void proc.exited.then(() => sandbox.owned.delete(proc.pid));
  const reader = proc.stdout.getReader();
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (ok: boolean) => void>();
  void (async () => {
    for (;;) {
      const { value, done } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: number; error?: unknown };
          if (message.id !== undefined) {
            pending.get(message.id)?.(!message.error);
            pending.delete(message.id);
          }
        } catch {
          // Non-JSON line; ignore.
        }
        newline = buffer.indexOf("\n");
      }
    }
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
  })();
  const send = (message: Record<string, unknown>) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `gno mcp exited (${proc.exitCode ?? proc.signalCode}); stderr: ${stderrLog}`
      );
    }
    void proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`
    );
    void proc.stdin.flush();
  };
  const request = (
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<boolean> => {
    const id = nextId;
    nextId += 1;
    const answered = new Promise<boolean>((resolve) =>
      pending.set(id, resolve)
    );
    send({ id, method, params });
    return Promise.race([answered, Bun.sleep(timeoutMs).then(() => false)]);
  };
  let initialized = false;
  try {
    initialized = await request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gno-soak", version: "1" },
      },
      60_000
    );
  } catch {
    initialized = false;
  }
  if (!initialized) {
    await Promise.race([proc.exited, Bun.sleep(2_000)]);
    proc.kill("SIGKILL");
    const stderr = await Bun.file(stderrLog)
      .text()
      .catch(() => "");
    throw new Error(
      `gno mcp failed to start: ${stderr.trim().split("\n").at(-1) ?? "no stderr"}`
    );
  }
  send({ method: "notifications/initialized" });
  return {
    pid: proc.pid,
    exited: proc.exited,
    call: (name, args, timeoutMs = 30_000) =>
      request("tools/call", { name, arguments: args }, timeoutMs),
    async close() {
      try {
        void proc.stdin.end();
      } catch {
        // Already closed.
      }
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
    },
    async kill() {
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

export interface McpChurnOptions {
  /** Long-lived sessions kept open for the actor's lifetime (agent-session shape). */
  longLived: number;
  /** Mean delay between short-lived sessions. */
  meanDelayMs: number;
  /** Probability a short-lived session is SIGKILLed mid-call. */
  killChance: number;
}

export function mcpChurn(
  sandbox: Sandbox,
  rng: Rng,
  options: McpChurnOptions
): Actor {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const longLived: McpSession[] = [];
  let opening = (async () => {
    for (let i = 0; i < options.longLived; i += 1) {
      try {
        longLived.push(await openMcp(sandbox, ["--tool-profile", "core"]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const key = `longLivedOpenFailed: ${message.slice(0, 80)}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  })();
  const step = async (): Promise<void> => {
    await opening;
    if (longLived.length > 0 && rng.chance(0.5)) {
      const session = rng.pick(longLived);
      bump(
        (await session.call("gno_search", {
          query: rng.pick(QUERIES),
          limit: 3,
        }))
          ? "longCallOk"
          : "longCallFail"
      );
      return;
    }
    const session = await openMcp(sandbox);
    if (rng.chance(options.killChance)) {
      void session.call("gno_query", { query: rng.pick(QUERIES), limit: 5 });
      await Bun.sleep(rng.int(10, 300));
      await session.kill();
      bump("killedMidCall");
      return;
    }
    bump(
      (await session.call("gno_search", { query: rng.pick(QUERIES), limit: 3 }))
        ? "shortCallOk"
        : "shortCallFail"
    );
    await session.close();
  };
  const actor = loop(
    "mcp-churn",
    () => rng.int(0, options.meanDelayMs * 2),
    step,
    counts
  );
  return {
    ...actor,
    async stop() {
      await actor.stop();
      opening = Promise.resolve();
      for (const session of longLived) await session.close();
    },
  };
}

// ── CLI writers (lease contention) ───────────────────────────────────────────

export function cliWriters(
  sandbox: Sandbox,
  rng: Rng,
  meanDelayMs: number
): Actor {
  const counts: Record<string, number> = {};
  const step = async (): Promise<void> => {
    const result = await runGno(sandbox, ["update", "--lock-wait", "30s"], {
      timeoutMs: 180_000,
    });
    const key = result.timedOut ? "timedOut" : `exit${result.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  return loop(
    "cli-writers",
    () => rng.int(meanDelayMs / 2, meanDelayMs * 2),
    step,
    counts
  );
}

// ── Event-stream subscribers ─────────────────────────────────────────────────

export interface SseHerd {
  open: number;
  abandon(count: number): void;
  close(): Promise<void>;
}

/**
 * Open `count` /api/events subscribers over raw sockets (not fetch, whose
 * client pool would also starve the harness's own status probes).
 * "Abandoned" subscribers stay connected and keep receiving, but nothing
 * reacts to their data - Bun sockets cannot stop reading, so this exercises
 * held connections rather than true backpressure.
 */
export async function sseHerd(
  resident: Resident,
  count: number
): Promise<SseHerd> {
  const sockets: { end(): void }[] = [];
  let open = 0;
  const request = `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${resident.port}\r\nAccept: text/event-stream\r\n\r\n`;
  for (let i = 0; i < count; i += 1) {
    try {
      let headersSeen = false;
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: resident.port,
        socket: {
          data(_socket, chunk) {
            if (
              !headersSeen &&
              new TextDecoder().decode(chunk).startsWith("HTTP/1.1 200")
            ) {
              headersSeen = true;
              open += 1;
            }
          },
        },
      });
      socket.write(request);
      sockets.push(socket);
    } catch {
      // Refused connections show up as a lower `open` count.
    }
  }
  await Bun.sleep(1_000);
  return {
    get open() {
      return open;
    },
    abandon() {
      // See the doc comment: held, not backpressured.
    },
    async close() {
      for (const socket of sockets) socket.end();
      await Bun.sleep(200);
    },
  };
}

/** Spawn a process that spawns `gno mcp` and is then SIGKILLed (parent death without stdin close). */
export async function orphanedMcpParent(
  sandbox: Sandbox
): Promise<{ parentPid: number; note: string }> {
  const script = `const p = Bun.spawn({ cmd: ${JSON.stringify(gnoCmd("mcp"))}, stdin: "pipe", stdout: "pipe", stderr: "ignore" }); console.log(p.pid); await Bun.sleep(600000);`;
  const parent = spawnTagged(sandbox, [process.execPath, "-e", script], {
    stdin: "ignore",
  });
  await Bun.sleep(3_000);
  parent.kill("SIGKILL");
  await parent.exited;
  return {
    parentPid: parent.pid,
    note: "parent SIGKILLed while holding the child's stdin pipe",
  };
}
