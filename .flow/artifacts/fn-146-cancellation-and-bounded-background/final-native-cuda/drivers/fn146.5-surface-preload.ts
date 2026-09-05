/** Selected snapshot observer; native machinery stays in the actual child. */
import { appendFileSync, readFileSync } from "node:fs"; // Termination-safe synchronous evidence/marker read has no Bun API.
import { installTransitionObserver } from "./fn146.5-transition-observer";
import { installShutdownBindings } from "./fn146.5-shutdown-bindings";
const settings = JSON.parse(process.env.GNO_SURFACE_QA!);
const { source, root, observerRoot, models } = settings;
await installShutdownBindings(source, row => appendFileSync(`${root}/shutdown.jsonl`, JSON.stringify({ parentPid: process.pid, row }) + "\n"), error => process.stderr.write(`QA_SHUTDOWN_CAPTURE_FAILED ${String(error)}\n`));
const { installPhaseBridge } = await import(`${observerRoot}/phase-parent.ts`);
const { observeOwnership } = await import(`${observerRoot}/ownership-observer.ts`);
installPhaseBridge(source, `${root}/phases.jsonl`);
const emit = (value: unknown) => appendFileSync(`${root}/owner.jsonl`, JSON.stringify({ at: Date.now(), parentPid: process.pid, value }) + "\n");
const { installParentCapture } = await import(`${source}/evals/acceptance/parent-capture.ts`);
const capture = await installParentCapture(`surface-${process.pid}`, models, `${root}/capture`, undefined, (event: unknown) => emit({ kind: "child", event }));
const { NativeWorkerClient } = await import(`${source}/src/llm/native-worker/client.ts`);
installTransitionObserver(NativeWorkerClient.prototype, emit, error => process.stderr.write(`QA_TRANSITION_CAPTURE_FAILED ${String(error)}\n`));
// One capture scope spans concurrent public requests; exact native request IDs and offer markers correlate them.
capture.begin(`surface-session-${process.pid}`);
const original = NativeWorkerClient.prototype.request;
const workers = new Set<any>();
NativeWorkerClient.prototype.request = function(...args: any[]) {
  workers.add(this);
  let marker = "unmarked"; try { marker = readFileSync(`${root}/case.txt`, "utf8").trim(); } catch {}
  emit({ kind: "offer", marker, input: args[0], owner: observeOwnership(this) });
  const signal = args[2]?.signal;
  signal?.addEventListener("abort", () => emit({ kind: "signal-abort", marker, owner: observeOwnership(this) }), { once: true });
  const result = original.apply(this, args);
  void result.then(() => { emit({ kind: "caller-return", marker, owner: observeOwnership(this) }); }, (error: unknown) => { emit({ kind: "caller-error", marker, error: String(error), owner: observeOwnership(this) }); }).catch((error: unknown) => process.stderr.write(`QA_CALLER_CAPTURE_FAILED ${String(error)}\n`));
  return result;
};
let prior = "";
setInterval(() => {
  const rows = [...workers].map(worker => observeOwnership(worker)).map(row => ({ ...row, atMonotonicMs: undefined }));
  const next = JSON.stringify(rows);
  if (next !== prior) { prior = next; emit({ kind: "owners", rows }); }
}, 5).unref();
