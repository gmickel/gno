/** Preparation only. Import has no network, subprocess, or native side effects. */
export interface Observation {
  requestId: string;
  phase: "offered" | "queued" | "execution-start" | "native-evaluation" | "native-settled" | "child-exit";
  monotonicMs: number;
  parentPid: number;
  childPid?: number;
  generation?: number;
  busy?: boolean;
  pendingIds?: string[];
  ownsNative?: boolean;
}
export interface Hooks {
  /** Real request-correlated child/owner observations; never a fixed-delay trigger. */
  waitFor(requestId: string, phase: Observation["phase"], signal: AbortSignal): Promise<Observation>;
  write(name: string, value: unknown): Promise<void>;
}
export interface OwnedSurface {
  origin: string;
  parentPid: number;
  /** Validated by the launch supervisor against its retained child handle/readiness. */
  validateOwnership(): Promise<void>;
}
function origin(surface: OwnedSurface): string {
  const url = new URL(surface.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw Error("Explicit owned loopback origin required");
  }
  return url.origin;
}
export async function requestWithCancellation(input: {
  nativeAuthorized: boolean;
  surface: OwnedSurface;
  hooks: Hooks;
  caseId: string;
  requestId: string;
  path: "/api/query" | "/api/ask" | "/mcp";
  body: unknown;
  headers?: Record<string, string>;
  trigger: Observation["phase"];
  mode: "disconnect" | "mcp-notification";
  mcpRequestId?: string | number;
}): Promise<void> {
  if (!input.nativeAuthorized) throw Error("Native phase requires host grant");
  await input.surface.validateOwnership();
  const base = origin(input.surface);
  const controller = new AbortController();
  const bound = AbortSignal.timeout(180_000); // Observer safety bound, not product inference tuning.
  const started = performance.now();
  const sentHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", ...input.headers };
  await input.hooks.write(`${input.caseId}.request`, { ...input, hooks: undefined, surface: { origin: base, parentPid: input.surface.parentPid }, started });
  let delivered = false;
  const call = fetch(base + input.path, {
    method: "POST", headers: sentHeaders, body: JSON.stringify(input.body),
    signal: AbortSignal.any([controller.signal, bound]),
  }).then(async response => {
    const text = await response.text();
    delivered = true;
    return { status: response.status, headers: Object.fromEntries(response.headers), text, settledMs: performance.now() };
  }).catch(error => ({ error: String(error), settledMs: performance.now() }));
  try {
    const observed = await input.hooks.waitFor(input.requestId, input.trigger, bound);
    if (delivered) {
      await input.hooks.write(`${input.caseId}.race`, { status: "UNEXERCISED", observed, reason: "response preceded trigger" });
      return;
    }
    const cancelledAt = performance.now();
    if (input.mode === "disconnect") controller.abort(Error("owned QA transport disconnect"));
    else {
      if (input.path !== "/mcp" || input.mcpRequestId === undefined) throw Error("Exact MCP call request ID required");
      const response = await fetch(base + "/mcp", {
        method: "POST", headers: sentHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: input.mcpRequestId, reason: "owned QA cancellation" } }),
        signal: bound,
      });
      await input.hooks.write(`${input.caseId}.cancel-notification`, { status: response.status, body: await response.text(), cancelledAt });
    }
    const caller = await call;
    await input.hooks.write(`${input.caseId}.caller`, { observed, cancelledAt, caller });
    // Resolver must accept either actual native settlement OR confirmed owned child exit.
    const native = await input.hooks.waitFor(input.requestId, "native-settled", bound);
    await input.hooks.write(`${input.caseId}.native`, native);
  } finally {
    controller.abort();
    await input.hooks.write(`${input.caseId}.full-response`, await call);
  }
}

/** Retained subprocess handle only: never accepts an arbitrary numeric process ID. */
export async function observeShutdown(input: {
  nativeAuthorized: boolean;
  child: Bun.Subprocess;
  validateOwnership(): Promise<void>;
  signal: "SIGINT" | "SIGTERM";
  hooks: Pick<Hooks, "write">;
  caseId: string;
}): Promise<void> {
  if (!input.nativeAuthorized) throw Error("Shutdown QA requires host grant");
  await input.validateOwnership();
  const start = performance.now();
  input.child.kill(input.signal);
  const result = await Promise.race([
    input.child.exited.then(exit => ({ exit, elapsedMs: performance.now() - start })),
    Bun.sleep(11_000).then(() => ({ exceededSharedBudget: true, elapsedMs: performance.now() - start })),
  ]);
  await input.hooks.write(`${input.caseId}.shutdown`, result);
  // The external owned-group watchdog handles cleanup after a failed budget.
  // Descendant absence, WAL integrity and durable pending/completed identities are separate proofs.
}
